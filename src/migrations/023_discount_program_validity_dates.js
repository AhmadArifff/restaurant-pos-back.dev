exports.up = async (db) => {
  const alterations = [
    ['discount_programs', 'start_at DATETIME NULL'],
    ['discount_programs', 'end_at DATETIME NULL'],
  ];

  for (const [table, columnDef] of alterations) {
    try {
      await db.query(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    } catch (err) {
      if (!/Duplicate column/i.test(err.message)) throw err;
    }
  }

  const indexes = [
    ['discount_programs', 'idx_discount_programs_status_dates', 'status, start_at, end_at'],
  ];

  for (const [table, name, columns] of indexes) {
    try {
      await db.query(`CREATE INDEX ${name} ON ${table} (${columns})`);
    } catch (err) {
      if (!/Duplicate key name|already exists/i.test(err.message)) throw err;
    }
  }
};

exports.down = async (db) => {
  try {
    await db.query('DROP INDEX idx_discount_programs_status_dates ON discount_programs');
  } catch (err) {
    if (!/doesn't exist|Unknown key/i.test(err.message)) throw err;
  }
};
