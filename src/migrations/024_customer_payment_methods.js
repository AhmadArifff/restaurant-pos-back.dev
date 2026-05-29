exports.up = async (db) => {
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

  await db.query(`
    INSERT IGNORE INTO payment_methods
      (method_key, name, type, provider_name, account_name, account_number, instructions, payment_timeout_minutes, sort_order, status)
    VALUES
      ('qris', 'QRIS', 'qris', 'QRIS', 'Sultan Kebab', NULL, 'Scan QRIS, pastikan nominal sesuai total bayar, lalu upload bukti pembayaran.', 15, 1, 'active'),
      ('transfer', 'Transfer Bank', 'transfer', 'Bank', 'Sultan Kebab', '0000000000', 'Transfer sesuai total bayar, gunakan nama pelanggan sebagai berita transfer, lalu upload bukti pembayaran.', 15, 2, 'active')
  `);
};

exports.down = async (db) => {
  await db.query('DROP TABLE IF EXISTS payment_methods');
};
