const normalizePhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  let local = digits;
  if (local.startsWith('62')) local = local.slice(2);
  if (local.startsWith('0')) local = local.replace(/^0+/, '');
  return local.length >= 5 ? `62${local}`.slice(0, 16) : '';
};

const toMoney = (value) => Number(Number(value || 0).toFixed(2));

const parseBundleIds = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(Number).filter(Boolean);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Boolean) : [];
  } catch (_) {
    return String(value)
      .split(',')
      .map((item) => Number(String(item).trim()))
      .filter(Boolean);
  }
};

const serializeBundleIds = (ids) => JSON.stringify((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean));

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
    LIMIT 1
  `);
  return normalizeProgram(rows[0]) || {
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
  const needsPhone = ['voucher', 'review_reward'].includes(program.type) && Number(program.usage_limit_per_phone || 0) > 0;
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

const cartHasBundle = (items, bundleIds) => {
  if (!bundleIds.length) return false;
  const cartProductIds = new Set((items || []).map((item) => Number(item.product_id || item.id)).filter(Boolean));
  return bundleIds.every((id) => cartProductIds.has(Number(id)));
};

const findBestDiscount = async ({ executor, subtotal, items = [], voucherCode = '', customerPhone = '' }) => {
  const total = Number(subtotal || 0);
  if (total <= 0) return null;

  const normalizedCode = String(voucherCode || '').trim().toUpperCase();
  const candidates = [];

  if (normalizedCode) {
    const [rows] = await executor.query(
      "SELECT * FROM discount_programs WHERE type = 'voucher' AND UPPER(code) = ? LIMIT 1",
      [normalizedCode]
    );
    const voucher = normalizeProgram(rows[0]);
    if (!voucher) {
      const err = new Error('Kode voucher tidak ditemukan');
      err.status_code = 400;
      throw err;
    }
    candidates.push(voucher);
  } else {
    const bundles = await getActivePrograms(executor, 'bundle');
    candidates.push(...bundles.filter((program) => cartHasBundle(items, program.bundle_product_ids)));
  }

  let best = null;
  for (const program of candidates) {
    if (total < Number(program.min_order_amount || 0)) continue;
    const usage = await validateProgramUsage(executor, program, customerPhone);
    if (!usage.valid) {
      if (normalizedCode) {
        const err = new Error(usage.message);
        err.status_code = 400;
        throw err;
      }
      continue;
    }
    const amount = calculateAmount(total, program);
    if (amount <= 0) continue;
    const current = {
      program,
      discount_amount: amount,
      discount_rate: program.discount_type === 'percent' ? Number(program.discount_value || 0) : 0,
      discount_label: program.name,
      voucher_code: program.type === 'voucher' ? program.code : null,
      normalized_phone: usage.normalizedPhone,
    };
    if (!best || current.discount_amount > best.discount_amount) best = current;
  }

  return best;
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
  getReviewProgram,
  normalizePhone,
  normalizeProgram,
  parseBundleIds,
  recordRedemption,
  serializeBundleIds,
  validateProgramUsage,
};
