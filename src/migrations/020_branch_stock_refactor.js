exports.up = async (db) => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS branches (
      id INT PRIMARY KEY AUTO_INCREMENT,
      branch_key VARCHAR(100) UNIQUE NOT NULL,
      name VARCHAR(150) NOT NULL,
      area VARCHAR(150) NULL,
      address TEXT NULL,
      phone VARCHAR(60) NULL,
      status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  const alterations = [
    ['users', 'default_branch_id INT NULL'],
    ['dining_tables', 'branch_id INT NULL'],
    ['customer_orders', 'branch_id INT NULL'],
    ['transactions', 'branch_id INT NULL'],
    ['main_stock', 'branch_id INT NULL'],
    ['stock_requests', 'branch_id INT NULL'],
  ];

  for (const [table, columnDef] of alterations) {
    try {
      await db.query(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    } catch (err) {
      if (!/Duplicate column/i.test(err.message)) throw err;
    }
  }

  const [branches] = await db.query('SELECT id FROM branches LIMIT 1');
  let branchId = branches[0]?.id;
  if (!branchId) {
    const [result] = await db.query(`
      INSERT INTO branches (branch_key, name, area, status)
      VALUES ('default', 'Cabang Utama', 'Default', 'active')
    `);
    branchId = result.insertId;
  }

  for (const table of ['users', 'dining_tables', 'customer_orders', 'transactions', 'main_stock', 'stock_requests']) {
    const column = table === 'users' ? 'default_branch_id' : 'branch_id';
    await db.query(`UPDATE ${table} SET ${column} = ? WHERE ${column} IS NULL`, [branchId]);
  }

  try {
    await db.query('ALTER TABLE dining_tables DROP INDEX table_number');
  } catch (error) {
    if (error.code !== 'ER_CANT_DROP_FIELD_OR_KEY' && error.code !== 'ER_DROP_INDEX_FK') {
      throw error;
    }
  }

  try {
    await db.query('CREATE UNIQUE INDEX unique_dining_table_branch_number ON dining_tables (branch_id, table_number)');
  } catch (error) {
    if (error.code !== 'ER_DUP_KEYNAME') throw error;
  }
};

exports.down = async () => {};
