const db = require('../config/db');

exports.up = async () => {
  if (db.isPostgres) {
    await db.query(`
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
    await db.query('CREATE INDEX IF NOT EXISTS idx_review_reward_vouchers_token ON review_reward_vouchers(token)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_review_reward_vouchers_phone ON review_reward_vouchers(normalized_phone, status, expires_at)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_review_reward_vouchers_source_order ON review_reward_vouchers(source_order_id)');
    return;
  }

  await db.query(`
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
};

exports.down = async () => {
  await db.query('DROP TABLE IF EXISTS review_reward_vouchers');
};
