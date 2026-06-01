const crypto = require('crypto');
const db = require('../config/db');

const normalizePhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  let local = digits;
  if (local.startsWith('62')) local = local.slice(2);
  if (local.startsWith('0')) local = local.replace(/^0+/, '');
  return local.length >= 5 ? `62${local}`.slice(0, 16) : '';
};

const toMoney = (value) => Number(Number(value || 0).toFixed(2));
const REVIEW_VOUCHER_DAYS = 7;

const formatSqlDateTime = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

const makeReviewVoucherToken = () => `RV${crypto.randomBytes(12).toString('hex').toUpperCase()}`;

const normalizeName = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();

const extractReviewVoucherToken = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const parsed = JSON.parse(raw);
    if (parsed?.type === 'review_reward_voucher' && parsed?.token) return String(parsed.token).trim().toUpperCase();
  } catch (_) {}

  const marker = 'SK-REVIEW-VOUCHER:';
  if (raw.toUpperCase().startsWith(marker)) return raw.slice(marker.length).trim().toUpperCase();
  return raw.trim().toUpperCase();
};

let reviewVoucherSchemaReady = false;
const ignoreSchemaExistsError = (err) => (
  err?.code === '42701'
  || err?.code === '42P07'
  || /Duplicate column|Duplicate key name|already exists/i.test(err?.message || '')
);

const ensureReviewVoucherSchema = async (executor = db) => {
  if (reviewVoucherSchemaReady) return;
  if (db.isPostgres) {
    await executor.query(`
      CREATE TABLE IF NOT EXISTS review_reward_vouchers (
        id BIGSERIAL PRIMARY KEY,
        token VARCHAR(96) NOT NULL UNIQUE,
        program_id BIGINT NULL REFERENCES discount_programs(id) ON DELETE SET NULL,
        source_order_id BIGINT NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
        redeemed_order_id BIGINT NULL REFERENCES customer_orders(id) ON DELETE SET NULL,
        customer_name VARCHAR(160) NULL,
        customer_phone VARCHAR(40) NULL,
        normalized_phone VARCHAR(20) NULL,
        discount_type VARCHAR(20) NOT NULL DEFAULT 'percent',
        discount_value NUMERIC(12,2) NOT NULL DEFAULT 0,
        status VARCHAR(24) NOT NULL DEFAULT 'active',
        issued_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        redeemed_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await executor.query('CREATE INDEX IF NOT EXISTS idx_review_reward_vouchers_token ON review_reward_vouchers(token)');
    await executor.query('CREATE INDEX IF NOT EXISTS idx_review_reward_vouchers_phone ON review_reward_vouchers(normalized_phone, status, expires_at)');
    await executor.query('CREATE INDEX IF NOT EXISTS idx_review_reward_vouchers_source_order ON review_reward_vouchers(source_order_id)');
    reviewVoucherSchemaReady = true;
    return;
  }

  await executor.query(`
    CREATE TABLE IF NOT EXISTS review_reward_vouchers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      token VARCHAR(96) NOT NULL UNIQUE,
      program_id INT NULL,
      source_order_id INT NOT NULL,
      redeemed_order_id INT NULL,
      customer_name VARCHAR(160) NULL,
      customer_phone VARCHAR(40) NULL,
      normalized_phone VARCHAR(20) NULL,
      discount_type VARCHAR(20) NOT NULL DEFAULT 'percent',
      discount_value DECIMAL(12,2) NOT NULL DEFAULT 0,
      status VARCHAR(24) NOT NULL DEFAULT 'active',
      issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      redeemed_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_review_voucher_token (token),
      INDEX idx_review_reward_vouchers_phone (normalized_phone, status, expires_at),
      INDEX idx_review_reward_vouchers_source_order (source_order_id)
    )
  `);
  reviewVoucherSchemaReady = true;
};

const parseBundleIds = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => Number(item?.product_id || item?.id || item)).filter(Boolean))];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? [...new Set(parsed.map((item) => Number(item?.product_id || item?.id || item)).filter(Boolean))]
      : [];
  } catch (_) {
    return [...new Set(String(value)
      .split(',')
      .map((item) => Number(String(item).trim()))
      .filter(Boolean))];
  }
};

const parseBundleItems = (value) => {
  if (!value) return [];
  let raw = value;
  if (!Array.isArray(raw)) {
    try {
      raw = JSON.parse(value);
    } catch (_) {
      raw = String(value).split(',').map((item) => item.trim());
    }
  }

  if (!Array.isArray(raw)) return [];
  const byProduct = new Map();
  raw.forEach((item) => {
    const productId = Number(item?.product_id || item?.id || item);
    if (!productId) return;
    const qty = Math.max(1, Number(item?.qty || item?.min_qty || 1));
    const previous = byProduct.get(productId);
    byProduct.set(productId, {
      product_id: productId,
      qty: previous ? Math.max(Number(previous.qty || 1), qty) : qty,
    });
  });
  return [...byProduct.values()];
};

const serializeBundleIds = (ids) => JSON.stringify(parseBundleItems(ids));

const normalizeProgram = (program) => {
  if (!program) return null;
  return {
    ...program,
    discount_value: Number(program.discount_value || 0),
    min_order_amount: Number(program.min_order_amount || 0),
    usage_limit_per_phone: Number(program.usage_limit_per_phone || 0),
    total_usage_limit: program.total_usage_limit == null ? null : Number(program.total_usage_limit || 0),
    min_service_rating: Number(program.min_service_rating || 1),
    min_menu_rating: Number(program.min_menu_rating || 1),
    bundle_items: parseBundleItems(program.bundle_product_ids),
    bundle_product_ids: parseBundleIds(program.bundle_product_ids),
  };
};

const isProgramActiveNow = (program) => {
  if (!program || program.status !== 'active') return false;
  const now = Date.now();
  if (program.start_at && new Date(program.start_at).getTime() > now) return false;
  if (program.end_at && new Date(program.end_at).getTime() < now) return false;
  return true;
};

const calculateAmount = (subtotal, program) => {
  const total = Number(subtotal || 0);
  if (!program || total <= 0) return 0;
  if (program.discount_type === 'fixed') return toMoney(Math.min(total, Number(program.discount_value || 0)));
  return toMoney(Math.min(total, total * (Number(program.discount_value || 0) / 100)));
};

const mapReviewVoucher = (row) => {
  if (!row) return null;
  return {
    ...row,
    token: String(row.token || '').toUpperCase(),
    discount_value: Number(row.discount_value || 0),
    source_order_date: row.source_order_date || row.issued_at || row.created_at,
    customer_name: row.customer_name || '',
    customer_phone: row.customer_phone || '',
  };
};

const getReviewVoucherByToken = async (executor, tokenValue) => {
  await ensureReviewVoucherSchema(executor);
  const token = extractReviewVoucherToken(tokenValue);
  if (!token) return null;
  const [rows] = await executor.query(`
    SELECT rv.*, co.order_code AS source_order_code, co.created_at AS source_order_date,
      dp.name AS program_name
    FROM review_reward_vouchers rv
    JOIN customer_orders co ON co.id = rv.source_order_id
    LEFT JOIN discount_programs dp ON dp.id = rv.program_id
    WHERE rv.token = ?
    LIMIT 1
  `, [token]);
  return mapReviewVoucher(rows[0]);
};

const buildReviewVoucherPayload = (voucher) => {
  if (!voucher) return null;
  return {
    token: voucher.token,
    program_id: voucher.program_id,
    program_name: voucher.program_name || 'Voucher Review Pelanggan',
    discount_type: voucher.discount_type,
    discount_value: Number(voucher.discount_value || 0),
    customer_name: voucher.customer_name || '',
    customer_phone: voucher.customer_phone || '',
    source_order_id: voucher.source_order_id,
    source_order_code: voucher.source_order_code,
    source_order_date: voucher.source_order_date,
    issued_at: voucher.issued_at,
    expires_at: voucher.expires_at,
    redeemed_at: voucher.redeemed_at,
    redeemed_order_id: voucher.redeemed_order_id,
    status: voucher.status,
    qr_payload: JSON.stringify({
      type: 'review_reward_voucher',
      token: voucher.token,
    }),
  };
};

const validateReviewVoucher = async (executor, {
  token,
  customerPhone = '',
  customerName = '',
  requireIdentity = true,
} = {}) => {
  const voucher = await getReviewVoucherByToken(executor, token);
  if (!voucher) return { valid: false, message: 'Voucher review tidak ditemukan' };
  if (voucher.status !== 'active') return { valid: false, message: 'Voucher review sudah tidak aktif' };
  if (voucher.redeemed_at || voucher.redeemed_order_id) return { valid: false, message: 'Voucher review sudah pernah digunakan' };
  if (voucher.expires_at && new Date(voucher.expires_at).getTime() < Date.now()) {
    return { valid: false, message: 'Voucher review sudah expired' };
  }

  const normalizedInputPhone = normalizePhone(customerPhone);
  if (requireIdentity && !normalizedInputPhone) {
    return { valid: false, message: 'Nomor HP wajib diisi untuk validasi voucher review' };
  }
  if (voucher.normalized_phone && normalizedInputPhone && voucher.normalized_phone !== normalizedInputPhone) {
    return { valid: false, message: 'Nomor HP tidak sesuai dengan pemilik voucher review' };
  }

  const sourceName = normalizeName(voucher.customer_name);
  const inputName = normalizeName(customerName);
  if (requireIdentity && sourceName && !inputName) {
    return { valid: false, message: 'Nama pelanggan wajib diisi untuk validasi voucher review' };
  }
  if (sourceName && inputName && sourceName !== inputName) {
    return { valid: false, message: 'Nama pelanggan tidak sesuai dengan pemilik voucher review' };
  }

  return {
    valid: true,
    voucher,
    normalizedPhone: normalizedInputPhone || voucher.normalized_phone || '',
    payload: buildReviewVoucherPayload(voucher),
  };
};

const validateReviewRewardIssuance = async (executor, program, customerPhone = '') => {
  const usage = await validateProgramUsage(executor, program, customerPhone);
  if (!usage.valid) return usage;
  if (!program?.id) return usage;

  await ensureReviewVoucherSchema(executor);
  const normalizedPhone = normalizePhone(customerPhone);
  const [totalRows] = await executor.query(
    'SELECT COUNT(*) AS total FROM review_reward_vouchers WHERE program_id = ?',
    [program.id]
  );
  const issuedTotal = Number(totalRows[0]?.total || 0);
  if (program.total_usage_limit != null && issuedTotal >= Number(program.total_usage_limit)) {
    return { valid: false, message: 'Kuota program voucher review sudah habis' };
  }

  if (normalizedPhone && Number(program.usage_limit_per_phone || 0) > 0) {
    const [phoneRows] = await executor.query(
      'SELECT COUNT(*) AS total FROM review_reward_vouchers WHERE program_id = ? AND normalized_phone = ?',
      [program.id, normalizedPhone]
    );
    const issuedForPhone = Number(phoneRows[0]?.total || 0);
    if (issuedForPhone >= Number(program.usage_limit_per_phone || 0)) {
      return { valid: false, message: 'Nomor HP ini sudah mencapai batas klaim voucher review' };
    }
  }

  return usage;
};

const createReviewVoucher = async (executor, { order, program, customerPhone = '', customerName = '' } = {}) => {
  if (!order?.id || !program?.id) return null;
  await ensureReviewVoucherSchema(executor);
  const [existing] = await executor.query(`
    SELECT rv.*, co.order_code AS source_order_code, co.created_at AS source_order_date,
      dp.name AS program_name
    FROM review_reward_vouchers rv
    JOIN customer_orders co ON co.id = rv.source_order_id
    LEFT JOIN discount_programs dp ON dp.id = rv.program_id
    WHERE rv.source_order_id = ? AND rv.program_id = ?
    LIMIT 1
  `, [order.id, program.id]);
  if (existing.length) return buildReviewVoucherPayload(mapReviewVoucher(existing[0]));

  const token = makeReviewVoucherToken();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + REVIEW_VOUCHER_DAYS * 24 * 60 * 60 * 1000);
  const name = String(customerName || order.customer_name || '').trim();
  const phone = String(customerPhone || order.customer_phone || '').trim();
  const normalizedPhone = normalizePhone(phone);
  const [result] = await executor.query(`
    INSERT INTO review_reward_vouchers
      (token, program_id, source_order_id, customer_name, customer_phone, normalized_phone,
       discount_type, discount_value, status, issued_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `, [
    token,
    program.id,
    order.id,
    name || null,
    phone || null,
    normalizedPhone || null,
    program.discount_type || 'percent',
    Number(program.discount_value || 0),
    formatSqlDateTime(issuedAt),
    formatSqlDateTime(expiresAt),
  ]);
  const [rows] = await executor.query(`
    SELECT rv.*, co.order_code AS source_order_code, co.created_at AS source_order_date,
      dp.name AS program_name
    FROM review_reward_vouchers rv
    JOIN customer_orders co ON co.id = rv.source_order_id
    LEFT JOIN discount_programs dp ON dp.id = rv.program_id
    WHERE rv.id = ?
    LIMIT 1
  `, [result.insertId]);
  return buildReviewVoucherPayload(mapReviewVoucher(rows[0]));
};

const redeemReviewVoucher = async (executor, { token, orderId } = {}) => {
  if (!token || !orderId) return;
  await ensureReviewVoucherSchema(executor);
  await executor.query(`
    UPDATE review_reward_vouchers
    SET status = 'redeemed',
        redeemed_order_id = ?,
        redeemed_at = NOW()
    WHERE token = ? AND status = 'active' AND redeemed_at IS NULL
  `, [orderId, extractReviewVoucherToken(token)]);
};

const getProgramById = async (executor, id) => {
  if (!id) return null;
  const [rows] = await executor.query('SELECT * FROM discount_programs WHERE id = ? LIMIT 1', [id]);
  return normalizeProgram(rows[0]);
};

const getReviewProgram = async (executor) => {
  const [rows] = await executor.query(`
    SELECT * FROM discount_programs
    WHERE type = 'review_reward' AND status = 'active'
    ORDER BY id ASC
  `);

  const programs = rows.map(normalizeProgram).filter(Boolean);
  const activeProgram = programs.find(isProgramActiveNow);
  if (activeProgram) return activeProgram;
  if (programs.length > 0) return null;

  return {
    id: null,
    name: 'Reward Review Pelanggan',
    type: 'review_reward',
    discount_type: 'percent',
    discount_value: 5,
    min_service_rating: 1,
    min_menu_rating: 1,
  };
};

const getActivePrograms = async (executor, type = null) => {
  const params = [];
  let where = "WHERE status = 'active'";
  if (type) {
    where += ' AND type = ?';
    params.push(type);
  }
  const [rows] = await executor.query(`
    SELECT * FROM discount_programs
    ${where}
    ORDER BY type ASC, discount_value DESC, id DESC
  `, params);
  return rows.map(normalizeProgram).filter(isProgramActiveNow);
};

const countRedemptions = async (executor, programId, normalizedPhone = '') => {
  const [totalRows] = await executor.query(
    'SELECT COUNT(*) AS total FROM discount_redemptions WHERE program_id = ?',
    [programId]
  );
  let phoneCount = 0;
  if (normalizedPhone) {
    const [phoneRows] = await executor.query(
      'SELECT COUNT(*) AS total FROM discount_redemptions WHERE program_id = ? AND normalized_phone = ?',
      [programId, normalizedPhone]
    );
    phoneCount = Number(phoneRows[0]?.total || 0);
  }
  return {
    total: Number(totalRows[0]?.total || 0),
    phone: phoneCount,
  };
};

const validateProgramUsage = async (executor, program, customerPhone = '') => {
  if (!program) return { valid: false, message: 'Program diskon tidak ditemukan' };
  if (!isProgramActiveNow(program)) return { valid: false, message: 'Program diskon sedang tidak aktif' };

  const normalizedPhone = normalizePhone(customerPhone);
  const needsPhone = ['voucher', 'review_reward', 'bundle'].includes(program.type) && Number(program.usage_limit_per_phone || 0) > 0;
  if (needsPhone && !normalizedPhone) {
    return { valid: false, message: 'Nomor HP wajib diisi untuk klaim diskon ini' };
  }

  const counts = await countRedemptions(executor, program.id, normalizedPhone);
  if (program.total_usage_limit != null && counts.total >= Number(program.total_usage_limit)) {
    return { valid: false, message: 'Kuota program diskon sudah habis' };
  }
  if (normalizedPhone && Number(program.usage_limit_per_phone || 0) > 0 && counts.phone >= Number(program.usage_limit_per_phone)) {
    return { valid: false, message: 'Nomor HP ini sudah mencapai batas klaim diskon' };
  }

  return { valid: true, normalizedPhone, remaining_for_phone: normalizedPhone ? Math.max(0, Number(program.usage_limit_per_phone || 0) - counts.phone) : null };
};

const cartHasBundle = (items, bundleItems) => {
  if (!bundleItems.length) return false;
  const cartQtyByProduct = new Map();
  (items || []).forEach((item) => {
    const productId = Number(item.product_id || item.id);
    if (!productId) return;
    cartQtyByProduct.set(productId, Number(cartQtyByProduct.get(productId) || 0) + Number(item.qty || 0));
  });
  return bundleItems.every((item) => Number(cartQtyByProduct.get(Number(item.product_id)) || 0) >= Number(item.qty || 1));
};

const getItemSubtotal = (item) => {
  const qty = Number(item.qty || 0);
  const price = Number(item.price || 0);
  const explicitSubtotal = Number(item.subtotal || 0);
  return toMoney(explicitSubtotal > 0 ? explicitSubtotal : price * qty);
};

const getProgramDiscountBase = (subtotal, items, program) => {
  if (program?.type !== 'bundle') return toMoney(subtotal);
  const bundleIds = new Set((program.bundle_items || []).map((item) => Number(item.product_id)).filter(Boolean));
  const bundleSubtotal = (items || []).reduce((sum, item) => {
    const productId = Number(item.product_id || item.id);
    return bundleIds.has(productId) ? sum + getItemSubtotal(item) : sum;
  }, 0);
  return toMoney(bundleSubtotal);
};

const makeDiscountComponent = ({ program, usage, discountBase, amount }) => ({
  program,
  discount_base: toMoney(discountBase),
  discount_amount: toMoney(amount),
  discount_rate: program.discount_type === 'percent' ? Number(program.discount_value || 0) : 0,
  discount_label: program.name,
  voucher_code: program.type === 'voucher' ? program.code : null,
  normalized_phone: usage.normalizedPhone,
  bundle_items: program.type === 'bundle' ? program.bundle_items : [],
});

const mergeDiscountComponents = (components, total) => {
  const validComponents = (components || []).filter((component) => Number(component.discount_amount || 0) > 0);
  if (!validComponents.length) return null;

  const discountAmount = toMoney(Math.min(
    Number(total || 0),
    validComponents.reduce((sum, component) => sum + Number(component.discount_amount || 0), 0)
  ));
  const primary = validComponents[0];
  const voucher = validComponents.find((component) => component.program?.type === 'voucher');
  const bundle = validComponents.find((component) => component.program?.type === 'bundle');

  return {
    program: primary.program,
    programs: validComponents,
    components: validComponents,
    discount_base: toMoney(validComponents.reduce((sum, component) => sum + Number(component.discount_base || 0), 0)),
    discount_amount: discountAmount,
    discount_rate: validComponents.length === 1 ? primary.discount_rate : 0,
    discount_label: validComponents.map((component) => component.discount_label).join(' + '),
    voucher_code: voucher?.voucher_code || null,
    normalized_phone: voucher?.normalized_phone || primary.normalized_phone,
    bundle_items: bundle?.bundle_items || [],
    type: validComponents.length > 1 ? 'mixed' : primary.program.type,
  };
};

const findBestDiscount = async ({ executor, subtotal, items = [], voucherCode = '', customerPhone = '', customerName = '', reviewVoucherToken = '' }) => {
  const total = Number(subtotal || 0);
  if (total <= 0) return null;

  const normalizedCode = String(voucherCode || '').trim().toUpperCase();
  const components = [];
  let voucher = null;
  let reviewVoucher = null;
  let voucherError = null;

  if (normalizedCode) {
    const [rows] = await executor.query(
      "SELECT * FROM discount_programs WHERE type = 'voucher' AND UPPER(code) = ? LIMIT 1",
      [normalizedCode]
    );
    voucher = normalizeProgram(rows[0]);
    if (!voucher) {
      voucherError = 'Kode voucher tidak ditemukan';
    }
  }

  if (reviewVoucherToken) {
    const validation = await validateReviewVoucher(executor, {
      token: reviewVoucherToken,
      customerPhone,
      customerName,
      requireIdentity: true,
    });
    if (!validation.valid) {
      const err = new Error(validation.message);
      err.status_code = 400;
      throw err;
    }
    reviewVoucher = validation.voucher;
  }

  const bundles = await getActivePrograms(executor, 'bundle');
  let bestBundle = null;
  for (const program of bundles.filter((item) => cartHasBundle(items, item.bundle_items))) {
    const discountBase = getProgramDiscountBase(total, items, program);
    if (discountBase < Number(program.min_order_amount || 0)) continue;
    const usage = await validateProgramUsage(executor, program, customerPhone);
    if (!usage.valid) continue;
    const amount = calculateAmount(discountBase, program);
    if (amount <= 0) continue;
    const current = makeDiscountComponent({ program, usage, discountBase, amount });
    if (!bestBundle || current.discount_amount > bestBundle.discount_amount) bestBundle = current;
  }

  if (bestBundle) components.push(bestBundle);

  if (voucher) {
    const usage = await validateProgramUsage(executor, voucher, customerPhone);
    if (!usage.valid) {
      voucherError = usage.message;
    } else {
      const voucherBase = toMoney(Math.max(0, total - Number(bestBundle?.discount_base || 0)));
      if (voucherBase >= Number(voucher.min_order_amount || 0)) {
        const amount = calculateAmount(voucherBase, voucher);
        if (amount > 0) {
          components.push(makeDiscountComponent({ program: voucher, usage, discountBase: voucherBase, amount }));
        }
      }
    }
  }

  if (reviewVoucher) {
    const reviewProgram = {
      id: reviewVoucher.program_id,
      name: reviewVoucher.program_name || 'Voucher Review Pelanggan',
      type: 'review_reward',
      discount_type: reviewVoucher.discount_type,
      discount_value: Number(reviewVoucher.discount_value || 0),
    };
    const reviewBase = toMoney(Math.max(0, total - Number(bestBundle?.discount_base || 0)));
    const amount = calculateAmount(reviewBase, reviewProgram);
    if (amount > 0) {
      components.push({
        program: reviewProgram,
        review_voucher: buildReviewVoucherPayload(reviewVoucher),
        review_voucher_token: reviewVoucher.token,
        discount_base: reviewBase,
        discount_amount: toMoney(amount),
        discount_rate: reviewProgram.discount_type === 'percent' ? Number(reviewProgram.discount_value || 0) : 0,
        discount_label: reviewProgram.name,
        voucher_code: reviewVoucher.token,
        normalized_phone: reviewVoucher.normalized_phone || normalizePhone(customerPhone),
        bundle_items: [],
      });
    }
  }

  if (voucherError && !components.length) {
    const err = new Error(voucherError);
    err.status_code = 400;
    throw err;
  }

  return mergeDiscountComponents(components, total);
};

const recordRedemption = async ({
  executor,
  program,
  orderId = null,
  transactionId = null,
  customerPhone = '',
  subtotal = 0,
  discountAmount = 0,
  createdBy = null,
  voucherCode = null,
}) => {
  if (!program?.id || Number(discountAmount || 0) <= 0) return;
  const normalizedPhone = normalizePhone(customerPhone);
  await executor.query(`
    INSERT INTO discount_redemptions
      (program_id, order_id, transaction_id, customer_phone, normalized_phone, voucher_code, subtotal, discount_amount, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    program.id,
    orderId,
    transactionId,
    customerPhone || null,
    normalizedPhone || null,
    voucherCode || null,
    subtotal,
    discountAmount,
    createdBy || null,
  ]);
};

module.exports = {
  calculateAmount,
  findBestDiscount,
  getActivePrograms,
  getProgramById,
  buildReviewVoucherPayload,
  createReviewVoucher,
  ensureReviewVoucherSchema,
  extractReviewVoucherToken,
  getReviewProgram,
  getReviewVoucherByToken,
  normalizePhone,
  normalizeProgram,
  parseBundleItems,
  parseBundleIds,
  recordRedemption,
  redeemReviewVoucher,
  serializeBundleIds,
  validateReviewVoucher,
  validateReviewRewardIssuance,
  validateProgramUsage,
};
