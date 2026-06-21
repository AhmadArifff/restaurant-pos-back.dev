exports.up = async (db) => {
  try {
    await db.query("ALTER TABLE attendance ADD COLUMN source VARCHAR(32) NOT NULL DEFAULT 'user'");
  } catch (error) {
    if (!/duplicate column/i.test(String(error.message || ''))) throw error;
  }

  try {
    await db.query('ALTER TABLE attendance ADD COLUMN automation_key VARCHAR(80) NULL');
  } catch (error) {
    if (!/duplicate column/i.test(String(error.message || ''))) throw error;
  }

  try {
    await db.query('CREATE UNIQUE INDEX idx_attendance_automation_key ON attendance(automation_key)');
  } catch (error) {
    if (!/duplicate key name|already exists/i.test(String(error.message || ''))) throw error;
  }
};
