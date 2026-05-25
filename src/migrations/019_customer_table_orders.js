exports.up = async (db) => {
  const crypto = require('crypto');

  await db.query(`
    CREATE TABLE IF NOT EXISTS dining_tables (
      id INT PRIMARY KEY AUTO_INCREMENT,
      table_number VARCHAR(30) UNIQUE NOT NULL,
      table_name VARCHAR(100) NULL,
      capacity INT NOT NULL DEFAULT 2,
      qr_token VARCHAR(80) UNIQUE NOT NULL,
      status ENUM('active', 'maintenance', 'inactive') NOT NULL DEFAULT 'active',
      note TEXT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS customer_orders (
      id INT PRIMARY KEY AUTO_INCREMENT,
      order_code VARCHAR(50) UNIQUE NOT NULL,
      table_id INT NOT NULL,
      customer_name VARCHAR(120) NULL,
      customer_phone VARCHAR(40) NULL,
      subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
      discount_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
      discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      final_total DECIMAL(12,2) NOT NULL DEFAULT 0,
      status ENUM('pending', 'accepted', 'preparing', 'ready', 'completed', 'cancelled') NOT NULL DEFAULT 'pending',
      payment_status ENUM('unpaid', 'paid') NOT NULL DEFAULT 'unpaid',
      transaction_id INT NULL,
      note TEXT NULL,
      reviewed_at TIMESTAMP NULL,
      accepted_by INT NULL,
      accepted_at TIMESTAMP NULL,
      completed_by INT NULL,
      completed_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (table_id) REFERENCES dining_tables(id),
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL,
      FOREIGN KEY (accepted_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (completed_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS customer_order_items (
      id INT PRIMARY KEY AUTO_INCREMENT,
      order_id INT NOT NULL,
      product_id INT NOT NULL,
      product_name VARCHAR(150) NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      qty INT NOT NULL,
      subtotal DECIMAL(12,2) NOT NULL,
      note TEXT NULL,
      FOREIGN KEY (order_id) REFERENCES customer_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS customer_order_reviews (
      id INT PRIMARY KEY AUTO_INCREMENT,
      order_id INT NOT NULL UNIQUE,
      service_rating INT NOT NULL,
      service_comment TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES customer_orders(id) ON DELETE CASCADE
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS customer_order_item_reviews (
      id INT PRIMARY KEY AUTO_INCREMENT,
      order_id INT NOT NULL,
      order_item_id INT NOT NULL,
      product_id INT NOT NULL,
      rating INT NOT NULL,
      comment TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES customer_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (order_item_id) REFERENCES customer_order_items(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id),
      UNIQUE KEY unique_customer_order_item_review (order_item_id)
    )
  `);

  const [tables] = await db.query('SELECT id FROM dining_tables LIMIT 1');
  if (!tables.length) {
    for (let i = 1; i <= 8; i += 1) {
      await db.query(`
        INSERT INTO dining_tables (table_number, table_name, capacity, qr_token, status)
        VALUES (?, ?, ?, ?, 'active')
      `, [
        String(i).padStart(2, '0'),
        `Meja ${i}`,
        i <= 4 ? 2 : 4,
        crypto.randomBytes(24).toString('hex'),
      ]);
    }
  }
};

exports.down = async (db) => {
  await db.query('DROP TABLE IF EXISTS customer_order_item_reviews');
  await db.query('DROP TABLE IF EXISTS customer_order_reviews');
  await db.query('DROP TABLE IF EXISTS customer_order_items');
  await db.query('DROP TABLE IF EXISTS customer_orders');
  await db.query('DROP TABLE IF EXISTS dining_tables');
};
