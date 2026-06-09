const db = require('../config/db');
const {
  findBestDiscount,
  getActivePrograms,
  validateReviewVoucher,
  normalizeProgram,
  parseBundleItems,
  serializeBundleIds,
} = require('../services/discountService');

const sanitizeType = (value) => (
  ['review_reward', 'voucher', 'bundle'].includes(value) ? value : 'voucher'
);

const sanitizeDiscountType = (value) => (
  ['percent', 'fixed'].includes(value) ? value : 'percent'
);

const JAKARTA_OFFSET_MINUTES = 7 * 60;

const formatSqlDateTime = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

const jakartaLocalToUtc = (datePart, timePart, secondsPart = '00') => {
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  const second = Number(secondsPart || 0);
  return new Date(Date.UTC(year, month - 1, day, hour, minute - JAKARTA_OFFSET_MINUTES, second));
};

const sanitizeDateTime = (value) => {
  if (!value) return null;
  const localDateTime = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/);
  if (localDateTime) {
    const jakartaDate = jakartaLocalToUtc(localDateTime[1], localDateTime[2], localDateTime[3]);
    if (Number.isNaN(jakartaDate.getTime())) return null;
    return db.isPostgres ? jakartaDate.toISOString() : `${localDateTime[1]} ${localDateTime[2]}:${localDateTime[3] || '00'}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return db.isPostgres ? date.toISOString() : formatSqlDateTime(date);
};

const toProgramPayload = (body = {}) => {
  const type = sanitizeType(body.type);
  const code = type === 'voucher' && body.code
    ? String(body.code).trim().toUpperCase()
    : null;
  const startAt = sanitizeDateTime(body.start_at);
  const endAt = sanitizeDateTime(body.end_at);

  return {
    name: String(body.name || '').trim(),
    type,
    code,
    discount_type: sanitizeDiscountType(body.discount_type),
    discount_value: Math.max(0, Number(body.discount_value || 0)),
    min_order_amount: Math.max(0, Number(body.min_order_amount || 0)),
    usage_limit_per_phone: Math.max(0, Number(body.usage_limit_per_phone ?? 1)),
    total_usage_limit: body.total_usage_limit === '' || body.total_usage_limit == null
      ? null
      : Math.max(0, Number(body.total_usage_limit || 0)),
    min_service_rating: Math.min(5, Math.max(1, Number(body.min_service_rating || 1))),
    min_menu_rating: Math.min(5, Math.max(1, Number(body.min_menu_rating || 1))),
    bundle_product_ids: serializeBundleIds(
      type === 'bundle'
        ? (body.bundle_items || body.bundle_product_ids)
        : []
    ),
    status: body.status === 'inactive' ? 'inactive' : 'active',
    start_at: startAt,
    end_at: endAt,
    note: body.note ? String(body.note).trim() : null,
  };
};

const validateDateRange = (payload) => {
  if (!payload.start_at || !payload.end_at) return null;
  if (new Date(payload.end_at).getTime() < new Date(payload.start_at).getTime()) {
    return 'Tanggal expired harus setelah tanggal mulai aktif';
  }
  return null;
};

const sendError = (res, err, fallback = 'Aksi diskon belum bisa diproses. Silakan coba lagi.') => {
  res.status(err.status_code || 500).json({ message: err.status_code ? err.message : fallback });
};

let discountValiditySchemaReady = false;

const ignoreSchemaExistsError = (err) => (
  err?.code === '42701'
  || err?.code === '42P07'
  || /Duplicate column|Duplicate key name|already exists/i.test(err?.message || '')
);

const ensureDiscountValiditySchema = async () => {
  if (discountValiditySchemaReady) return;
  const dateType = db.isPostgres ? 'TIMESTAMPTZ' : 'DATETIME';

  const statements = [
    `ALTER TABLE discount_programs ADD COLUMN start_at ${dateType} NULL`,
    `ALTER TABLE discount_programs ADD COLUMN end_at ${dateType} NULL`,
    'CREATE INDEX idx_discount_programs_status_dates ON discount_programs (status, start_at, end_at)',
  ];

  for (const statement of statements) {
    try {
      await db.query(statement);
    } catch (err) {
      if (!ignoreSchemaExistsError(err)) throw err;
    }
  }

  discountValiditySchemaReady = true;
};

exports.list = async (req, res) => {
  try {
    await ensureDiscountValiditySchema();
    const [rows] = await db.query(`
      SELECT dp.*,
        COALESCE(stats.used_count, 0) AS used_count,
        COALESCE(stats.distributed_amount, 0) AS distributed_amount
      FROM discount_programs dp
      LEFT JOIN (
        SELECT program_id,
          COUNT(*) AS used_count,
          COALESCE(SUM(discount_amount), 0) AS distributed_amount
        FROM discount_redemptions
        GROUP BY program_id
      ) stats ON stats.program_id = dp.id
      ORDER BY dp.status ASC, dp.type ASC, dp.id DESC
    `);
    res.json(rows.map((row) => ({
      ...normalizeProgram(row),
      used_count: Number(row.used_count || 0),
      distributed_amount: Number(row.distributed_amount || 0),
    })));
  } catch (err) {
    sendError(res, err, 'Data voucher dan diskon gagal dimuat.');
  }
};

exports.active = async (req, res) => {
  try {
    await ensureDiscountValiditySchema();
    const programs = await getActivePrograms(db, req.query.type || null);
    if (!programs.length) return res.json([]);

    const programIds = programs.map((program) => program.id).filter(Boolean);
    const statsByProgram = new Map();
    if (programIds.length) {
      const placeholders = programIds.map(() => '?').join(',');
      const [statsRows] = await db.query(`
        SELECT program_id,
          COUNT(*) AS used_count,
          COALESCE(SUM(discount_amount), 0) AS distributed_amount
        FROM discount_redemptions
        WHERE program_id IN (${placeholders})
        GROUP BY program_id
      `, programIds);
      statsRows.forEach((row) => {
        statsByProgram.set(Number(row.program_id), {
          used_count: Number(row.used_count || 0),
          distributed_amount: Number(row.distributed_amount || 0),
        });
      });
    }

    const bundleProductIds = [
      ...new Set(programs
        .flatMap((program) => parseBundleItems(program.bundle_items || program.bundle_product_ids))
        .map((item) => Number(item.product_id || item.id || item))
        .filter(Boolean)),
    ];
    const productById = new Map();
    if (bundleProductIds.length) {
      const placeholders = bundleProductIds.map(() => '?').join(',');
      const [productRows] = await db.query(`
        SELECT id, name, price, image_url
        FROM products
        WHERE id IN (${placeholders})
      `, bundleProductIds);
      productRows.forEach((product) => productById.set(Number(product.id), product));
    }

    res.json(programs.map((program) => {
      const stats = statsByProgram.get(Number(program.id)) || { used_count: 0, distributed_amount: 0 };
      const remainingQuota = program.total_usage_limit == null
        ? null
        : Math.max(0, Number(program.total_usage_limit || 0) - Number(stats.used_count || 0));
      const bundleItems = parseBundleItems(program.bundle_items || program.bundle_product_ids).map((item) => {
        const product = productById.get(Number(item.product_id));
        return {
          ...item,
          name: product?.name || `Menu #${item.product_id}`,
          price: product?.price == null ? null : Number(product.price || 0),
          image_url: product?.image_url || null,
        };
      });

      return {
        ...program,
        bundle_items: bundleItems,
        bundle_product_ids: bundleItems,
        used_count: stats.used_count,
        distributed_amount: stats.distributed_amount,
        remaining_quota: remainingQuota,
      };
    }));
  } catch (err) {
    sendError(res, err, 'Data diskon aktif gagal dimuat.');
  }
};

exports.preview = async (req, res) => {
  try {
    await ensureDiscountValiditySchema();
    const subtotal = Number(req.body.subtotal || 0);
    const discount = await findBestDiscount({
      executor: db,
      subtotal,
      items: Array.isArray(req.body.items) ? req.body.items : [],
      voucherCode: req.body.voucher_code,
      customerPhone: req.body.customer_phone,
      customerName: req.body.customer_name,
      reviewVoucherToken: req.body.review_voucher_token,
    });

    if (!discount) {
      return res.json({
        applicable: false,
        message: 'Belum ada diskon yang cocok untuk pesanan ini.',
        final_total: subtotal,
      });
    }

    res.json({
      applicable: true,
      program_id: discount.program.id,
      label: discount.discount_label,
      type: discount.type || discount.program.type,
      discount_rate: discount.discount_rate,
      discount_amount: discount.discount_amount,
      discount_base: discount.discount_base || subtotal,
      bundle_items: discount.bundle_items || [],
      breakdown: (discount.components || []).map((component) => ({
        program_id: component.program.id,
        label: component.discount_label,
        type: component.program.type,
        discount_rate: component.discount_rate,
        discount_amount: component.discount_amount,
        discount_base: component.discount_base,
        voucher_code: component.voucher_code,
        review_voucher: component.review_voucher || null,
        bundle_items: component.bundle_items || [],
      })),
      final_total: Math.max(0, subtotal - discount.discount_amount),
      message: `${discount.discount_label} bisa digunakan.`,
    });
  } catch (err) {
    sendError(res, err, 'Diskon belum bisa dicek. Silakan coba lagi.');
  }
};

exports.validateReviewVoucher = async (req, res) => {
  try {
    const validation = await validateReviewVoucher(db, {
      token: req.body.token || req.body.review_voucher_token,
      customerPhone: req.body.customer_phone,
      customerName: req.body.customer_name,
      requireIdentity: true,
    });

    if (!validation.valid) {
      return res.status(400).json({ valid: false, message: validation.message });
    }

    res.json({
      valid: true,
      message: 'Voucher review valid dan bisa digunakan.',
      data: validation.payload,
    });
  } catch (err) {
    sendError(res, err, 'Voucher review belum bisa divalidasi. Silakan coba lagi.');
  }
};

exports.create = async (req, res) => {
  try {
    await ensureDiscountValiditySchema();
    const payload = toProgramPayload(req.body);
    if (!payload.name) return res.status(400).json({ message: 'Nama program wajib diisi' });
    if (payload.type === 'voucher' && !payload.code) return res.status(400).json({ message: 'Kode voucher wajib diisi' });
    if (payload.type === 'bundle' && !parseBundleItems(payload.bundle_product_ids).length) {
      return res.status(400).json({ message: 'Paket bundle wajib memiliki minimal satu menu' });
    }
    const dateError = validateDateRange(payload);
    if (dateError) return res.status(400).json({ message: dateError });

    const [result] = await db.query(`
      INSERT INTO discount_programs
        (name, type, code, discount_type, discount_value, min_order_amount, usage_limit_per_phone,
         total_usage_limit, min_service_rating, min_menu_rating, bundle_product_ids, status, start_at, end_at, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      payload.name,
      payload.type,
      payload.code,
      payload.discount_type,
      payload.discount_value,
      payload.min_order_amount,
      payload.usage_limit_per_phone,
      payload.total_usage_limit,
      payload.min_service_rating,
      payload.min_menu_rating,
      payload.bundle_product_ids,
      payload.status,
      payload.start_at,
      payload.end_at,
      payload.note,
      req.user?.id || null,
    ]);

    const [rows] = await db.query('SELECT * FROM discount_programs WHERE id = ?', [result.insertId]);
    res.status(201).json({ message: 'Program voucher dan diskon berhasil dibuat', data: normalizeProgram(rows[0]) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'Kode voucher sudah digunakan' });
    }
    sendError(res, err, 'Program voucher dan diskon gagal disimpan.');
  }
};

exports.update = async (req, res) => {
  try {
    await ensureDiscountValiditySchema();
    const payload = toProgramPayload(req.body);
    if (!payload.name) return res.status(400).json({ message: 'Nama program wajib diisi' });
    if (payload.type === 'voucher' && !payload.code) return res.status(400).json({ message: 'Kode voucher wajib diisi' });
    if (payload.type === 'bundle' && !parseBundleItems(payload.bundle_product_ids).length) {
      return res.status(400).json({ message: 'Paket bundle wajib memiliki minimal satu menu' });
    }
    const dateError = validateDateRange(payload);
    if (dateError) return res.status(400).json({ message: dateError });

    const [result] = await db.query(`
      UPDATE discount_programs
      SET name = ?, type = ?, code = ?, discount_type = ?, discount_value = ?,
          min_order_amount = ?, usage_limit_per_phone = ?, total_usage_limit = ?,
          min_service_rating = ?, min_menu_rating = ?, bundle_product_ids = ?,
          status = ?, start_at = ?, end_at = ?, note = ?
      WHERE id = ?
    `, [
      payload.name,
      payload.type,
      payload.code,
      payload.discount_type,
      payload.discount_value,
      payload.min_order_amount,
      payload.usage_limit_per_phone,
      payload.total_usage_limit,
      payload.min_service_rating,
      payload.min_menu_rating,
      payload.bundle_product_ids,
      payload.status,
      payload.start_at,
      payload.end_at,
      payload.note,
      req.params.id,
    ]);

    if (!result.affectedRows) return res.status(404).json({ message: 'Program diskon tidak ditemukan' });
    const [rows] = await db.query('SELECT * FROM discount_programs WHERE id = ?', [req.params.id]);
    res.json({ message: 'Program voucher dan diskon berhasil diperbarui', data: normalizeProgram(rows[0]) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'Kode voucher sudah digunakan' });
    }
    sendError(res, err, 'Program voucher dan diskon gagal diperbarui.');
  }
};

exports.remove = async (req, res) => {
  try {
    if (String(req.query.hard || '') === '1') {
      const [result] = await db.query('DELETE FROM discount_programs WHERE id = ?', [req.params.id]);
      if (!result.affectedRows) return res.status(404).json({ message: 'Program diskon tidak ditemukan' });
      return res.json({ message: 'Program voucher dan diskon berhasil dihapus' });
    }
    const [result] = await db.query("UPDATE discount_programs SET status = 'inactive' WHERE id = ?", [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Program diskon tidak ditemukan' });
    res.json({ message: 'Program voucher dan diskon berhasil dinonaktifkan' });
  } catch (err) {
    sendError(res, err, 'Program voucher dan diskon gagal dinonaktifkan.');
  }
};
