exports.up = async (db) => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS discount_programs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(160) NOT NULL,
      type ENUM('review_reward', 'voucher', 'bundle') NOT NULL DEFAULT 'voucher',
      code VARCHAR(80) NULL,
      discount_type ENUM('percent', 'fixed') NOT NULL DEFAULT 'percent',
      discount_value DECIMAL(12,2) NOT NULL DEFAULT 0,
      min_order_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      usage_limit_per_phone INT NOT NULL DEFAULT 1,
      total_usage_limit INT NULL,
      min_service_rating INT NOT NULL DEFAULT 1,
      min_menu_rating INT NOT NULL DEFAULT 1,
      bundle_product_ids TEXT NULL,
      status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
      note TEXT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_discount_code (code),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS discount_redemptions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      program_id INT NOT NULL,
      order_id INT NULL,
      transaction_id INT NULL,
      customer_phone VARCHAR(40) NULL,
      normalized_phone VARCHAR(40) NULL,
      voucher_code VARCHAR(80) NULL,
      subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
      discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (program_id) REFERENCES discount_programs(id) ON DELETE CASCADE,
      FOREIGN KEY (order_id) REFERENCES customer_orders(id) ON DELETE SET NULL,
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      INDEX idx_discount_phone (program_id, normalized_phone),
      INDEX idx_discount_transaction (transaction_id),
      INDEX idx_discount_order (order_id)
    )
  `);

  const alterations = [
    ['transactions', 'discount_rate DECIMAL(5,2) NOT NULL DEFAULT 0'],
    ['transactions', 'discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0'],
    ['transactions', 'discount_label VARCHAR(160) NULL'],
    ['transactions', 'discount_program_id INT NULL'],
    ['transactions', 'voucher_code VARCHAR(80) NULL'],
    ['transactions', 'customer_phone VARCHAR(40) NULL'],
    ['customer_orders', 'discount_label VARCHAR(160) NULL'],
    ['customer_orders', 'discount_program_id INT NULL'],
    ['customer_orders', 'voucher_code VARCHAR(80) NULL'],
  ];

  for (const [table, columnDef] of alterations) {
    try {
      await db.query(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    } catch (err) {
      if (!/Duplicate column/i.test(err.message)) throw err;
    }
  }

  const [programs] = await db.query("SELECT id FROM discount_programs WHERE type = 'review_reward' LIMIT 1");
  if (!programs.length) {
    await db.query(`
      INSERT INTO discount_programs
        (name, type, discount_type, discount_value, usage_limit_per_phone, min_service_rating, min_menu_rating, status, note)
      VALUES
        ('Reward Review Pelanggan', 'review_reward', 'percent', 5, 1, 1, 1, 'active', 'Diskon otomatis setelah pelanggan memberi rating pelayanan dan menu pesanan.')
    `);
  }
};

exports.down = async (db) => {
  await db.query('DROP TABLE IF EXISTS discount_redemptions');
  await db.query('DROP TABLE IF EXISTS discount_programs');
};
