const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const { isSupabaseStorageEnabled, uploadImageBuffer, deleteByPublicUrl } = require('./supabaseStorage');

const ACTIVE_STATUSES = new Set(['active', 'inactive']);
const PAYMENT_TYPES = new Set(['qris', 'transfer']);

const isPostgres = () => Boolean(db.isPostgres);

const sanitizePaymentType = (value) => {
  const safe = String(value || '').toLowerCase();
  return PAYMENT_TYPES.has(safe) ? safe : 'qris';
};

const sanitizeStatus = (value) => {
  const safe = String(value || '').toLowerCase();
  return ACTIVE_STATUSES.has(safe) ? safe : 'active';
};

const normalizeTimeout = (value) => {
  const minutes = Number(value || 15);
  if (!Number.isFinite(minutes)) return 15;
  return Math.max(1, Math.min(180, Math.round(minutes)));
};

const toNullable = (value) => {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
};

const ensurePaymentTables = async () => {
  if (isPostgres()) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS payment_methods (
        id BIGSERIAL PRIMARY KEY,
        method_key VARCHAR(40) UNIQUE NOT NULL,
        name VARCHAR(120) NOT NULL,
        type VARCHAR(30) NOT NULL DEFAULT 'qris',
        provider_name VARCHAR(120) NULL,
        account_name VARCHAR(120) NULL,
        account_number VARCHAR(120) NULL,
        qr_image_url TEXT NULL,
        instructions TEXT NULL,
        payment_timeout_minutes INTEGER NOT NULL DEFAULT 15,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query('CREATE INDEX IF NOT EXISTS idx_payment_methods_status_sort ON payment_methods(status, sort_order, id)');
    await db.query('ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS payment_method_id BIGINT NULL REFERENCES payment_methods(id) ON DELETE SET NULL');
    await db.query('ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS payment_method_key VARCHAR(40) NULL');
    await db.query('ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS payment_method_name VARCHAR(120) NULL');
    await db.query('ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS payment_due_at TIMESTAMPTZ NULL');
    await db.query('ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS payment_proof_url TEXT NULL');
    await db.query('ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS payment_proof_note TEXT NULL');
    await db.query('ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS payment_submitted_at TIMESTAMPTZ NULL');
    await db.query('CREATE INDEX IF NOT EXISTS idx_customer_orders_payment_due ON customer_orders(payment_due_at)');
  } else {
    await db.query(`
      CREATE TABLE IF NOT EXISTS payment_methods (
        id INT PRIMARY KEY AUTO_INCREMENT,
        method_key VARCHAR(40) UNIQUE NOT NULL,
        name VARCHAR(120) NOT NULL,
        type VARCHAR(30) NOT NULL DEFAULT 'qris',
        provider_name VARCHAR(120) NULL,
        account_name VARCHAR(120) NULL,
        account_number VARCHAR(120) NULL,
        qr_image_url TEXT NULL,
        instructions TEXT NULL,
        payment_timeout_minutes INT NOT NULL DEFAULT 15,
        status ENUM('active','inactive') NOT NULL DEFAULT 'active',
        sort_order INT NOT NULL DEFAULT 0,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_payment_methods_status_sort (status, sort_order, id)
      )
    `);

    const alterations = [
      'payment_method_id INT NULL',
      'payment_method_key VARCHAR(40) NULL',
      'payment_method_name VARCHAR(120) NULL',
      'payment_due_at DATETIME NULL',
      'payment_proof_url TEXT NULL',
      'payment_proof_note TEXT NULL',
      'payment_submitted_at DATETIME NULL',
    ];
    for (const columnDef of alterations) {
      try {
        await db.query(`ALTER TABLE customer_orders ADD COLUMN ${columnDef}`);
      } catch (err) {
        if (!/Duplicate column/i.test(err.message)) throw err;
      }
    }
    try {
      await db.query('CREATE INDEX idx_customer_orders_payment_due ON customer_orders(payment_due_at)');
    } catch (err) {
      if (!/Duplicate key name|already exists/i.test(err.message)) throw err;
    }
  }

  await seedDefaultPaymentMethods();
};

const seedDefaultPaymentMethods = async () => {
  const defaults = [
    {
      method_key: 'qris',
      name: 'QRIS',
      type: 'qris',
      provider_name: 'QRIS',
      account_name: 'Sultan Kebab',
      account_number: null,
      instructions: 'Scan QRIS, pastikan nominal sesuai total bayar, lalu upload bukti pembayaran.',
      payment_timeout_minutes: 15,
      sort_order: 1,
    },
    {
      method_key: 'transfer',
      name: 'Transfer Bank',
      type: 'transfer',
      provider_name: 'Bank',
      account_name: 'Sultan Kebab',
      account_number: '0000000000',
      instructions: 'Transfer sesuai total bayar, gunakan nama pelanggan sebagai berita transfer, lalu upload bukti pembayaran.',
      payment_timeout_minutes: 15,
      sort_order: 2,
    },
  ];

  for (const item of defaults) {
    if (isPostgres()) {
      await db.query(`
        INSERT INTO payment_methods
          (method_key, name, type, provider_name, account_name, account_number, instructions, payment_timeout_minutes, sort_order, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT (method_key) DO NOTHING
      `, [
        item.method_key,
        item.name,
        item.type,
        item.provider_name,
        item.account_name,
        item.account_number,
        item.instructions,
        item.payment_timeout_minutes,
        item.sort_order,
      ]);
    } else {
      await db.query(`
        INSERT IGNORE INTO payment_methods
          (method_key, name, type, provider_name, account_name, account_number, instructions, payment_timeout_minutes, sort_order, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
      `, [
        item.method_key,
        item.name,
        item.type,
        item.provider_name,
        item.account_name,
        item.account_number,
        item.instructions,
        item.payment_timeout_minutes,
        item.sort_order,
      ]);
    }
  }
};

const normalizePaymentPayload = (body = {}) => {
  const type = sanitizePaymentType(body.type);
  const rawKey = String(body.method_key || body.key || type).trim().toLowerCase();
  const methodKey = rawKey.replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || type;
  return {
    method_key: methodKey,
    name: toNullable(body.name) || (type === 'qris' ? 'QRIS' : 'Transfer'),
    type,
    provider_name: toNullable(body.provider_name),
    account_name: toNullable(body.account_name),
    account_number: toNullable(body.account_number),
    instructions: toNullable(body.instructions),
    payment_timeout_minutes: normalizeTimeout(body.payment_timeout_minutes),
    status: sanitizeStatus(body.status),
    sort_order: Number(body.sort_order || 0),
  };
};

const uploadPaymentAsset = async ({ file, folder = 'payments', prefix = 'payment' }) => {
  if (!file) return null;

  if (isSupabaseStorageEnabled()) {
    const uploaded = await uploadImageBuffer({ folder, prefix, file });
    return uploaded.publicUrl;
  }

  const dir = path.join(process.cwd(), 'public/images', folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(file.originalname || '') || '.jpg';
  const safeName = `${prefix}-${Date.now()}${ext.toLowerCase()}`;
  const target = path.join(dir, safeName);
  fs.writeFileSync(target, file.buffer);
  return `/images/${folder}/${safeName}`;
};

const removePaymentAsset = async (url) => {
  if (!url) return;
  if (isSupabaseStorageEnabled()) {
    await deleteByPublicUrl(url);
    return;
  }
  if (!String(url).includes('/images/payments/')) return;
  const fullPath = path.join(process.cwd(), 'public', String(url).replace(/^\/+/, ''));
  try {
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  } catch (_) {}
};

const listPaymentMethods = async ({ includeInactive = false } = {}) => {
  await ensurePaymentTables();
  const where = includeInactive ? '' : "WHERE status = 'active'";
  const [rows] = await db.query(`
    SELECT *
    FROM payment_methods
    ${where}
    ORDER BY sort_order ASC, id ASC
  `);
  return rows.map((row) => ({
    ...row,
    payment_timeout_minutes: Number(row.payment_timeout_minutes || 15),
    sort_order: Number(row.sort_order || 0),
  }));
};

const getPaymentMethodById = async (id, { activeOnly = false } = {}) => {
  await ensurePaymentTables();
  const params = [Number(id)];
  let where = 'WHERE id = ?';
  if (activeOnly) where += " AND status = 'active'";
  const [rows] = await db.query(`SELECT * FROM payment_methods ${where} LIMIT 1`, params);
  return rows[0] || null;
};

const buildPaymentOrderFields = (method) => {
  if (!method) return {
    paymentMethodId: null,
    paymentMethodKey: null,
    paymentMethodName: null,
    paymentDueAtSql: null,
  };

  const timeout = normalizeTimeout(method.payment_timeout_minutes);
  const paymentDueAtSql = isPostgres()
    ? `NOW() + INTERVAL '${timeout} minutes'`
    : `DATE_ADD(NOW(), INTERVAL ${timeout} MINUTE)`;

  return {
    paymentMethodId: method.id,
    paymentMethodKey: method.method_key,
    paymentMethodName: method.name,
    paymentDueAtSql,
  };
};

module.exports = {
  buildPaymentOrderFields,
  ensurePaymentTables,
  getPaymentMethodById,
  listPaymentMethods,
  normalizePaymentPayload,
  removePaymentAsset,
  uploadPaymentAsset,
};
