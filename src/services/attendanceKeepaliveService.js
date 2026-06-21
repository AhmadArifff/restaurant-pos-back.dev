const db = require('../config/db');

const KEEPALIVE_SOURCE = 'supabase_keepalive';
const KEEPALIVE_KEY_PREFIX = 'supabase-keepalive';

let ensureSchemaPromise = null;

const ensureAttendanceAutomationSchema = async () => {
  if (!ensureSchemaPromise) {
    ensureSchemaPromise = (async () => {
      if (db.isPostgres) {
        await db.query("ALTER TABLE attendance ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'user'");
        await db.query('ALTER TABLE attendance ADD COLUMN IF NOT EXISTS automation_key VARCHAR(80) NULL');
        await db.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_automation_key
          ON attendance(automation_key)
          WHERE automation_key IS NOT NULL
        `);
        return;
      }

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
    })().catch((error) => {
      ensureSchemaPromise = null;
      throw error;
    });
  }

  return ensureSchemaPromise;
};

const getJakartaDateKey = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const buildAutomationKey = (dateKey) => `${KEEPALIVE_KEY_PREFIX}:${dateKey}`;

const createDailyAttendanceKeepalive = async (date = new Date()) => {
  await ensureAttendanceAutomationSchema();
  const dateKey = getJakartaDateKey(date);
  const automationKey = buildAutomationKey(dateKey);

  const [admins] = await db.query(
    "SELECT id, name FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1"
  );
  if (!admins.length) {
    return { created: false, reason: 'admin_not_found', date: dateKey };
  }

  const [existing] = await db.query(
    'SELECT id FROM attendance WHERE automation_key = ? LIMIT 1',
    [automationKey]
  );
  if (existing.length) {
    return { created: false, reason: 'already_exists', date: dateKey };
  }

  await db.query(
    `INSERT INTO attendance (user_id, date, login_at, logout_at, source, automation_key)
     VALUES (?, ?, NOW(), NOW(), ?, ?)`,
    [admins[0].id, dateKey, KEEPALIVE_SOURCE, automationKey]
  );

  return {
    created: true,
    date: dateKey,
    admin_id: admins[0].id,
    admin_name: admins[0].name,
  };
};

const deleteDailyAttendanceKeepalive = async (date = new Date()) => {
  await ensureAttendanceAutomationSchema();
  const dateKey = getJakartaDateKey(date);
  const automationKey = buildAutomationKey(dateKey);
  const [result] = await db.query(
    'DELETE FROM attendance WHERE source = ? AND automation_key = ?',
    [KEEPALIVE_SOURCE, automationKey]
  );

  return {
    deleted: Number(result?.affectedRows || result?.rowCount || 0),
    date: dateKey,
  };
};

module.exports = {
  KEEPALIVE_SOURCE,
  ensureAttendanceAutomationSchema,
  createDailyAttendanceKeepalive,
  deleteDailyAttendanceKeepalive,
};
