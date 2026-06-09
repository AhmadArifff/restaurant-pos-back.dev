const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { ensureDefaultBranches } = require('./branchController');
const { getRequestBranchId } = require('../utils/branchContext');

let ensureCashierScheduleTablePromise = null;

const ensureCashierScheduleTable = async () => {
  if (!ensureCashierScheduleTablePromise) {
    ensureCashierScheduleTablePromise = (async () => {
      if (db.isPostgres) {
        await db.query(`
          CREATE TABLE IF NOT EXISTS cashier_schedules (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            work_date DATE NOT NULL,
            start_time VARCHAR(5) NOT NULL,
            end_time VARCHAR(5) NOT NULL,
            shift_name VARCHAR(80) NULL,
            status VARCHAR(24) NOT NULL DEFAULT 'scheduled',
            note TEXT NULL,
            created_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await db.query('CREATE INDEX IF NOT EXISTS idx_cashier_schedules_date_user ON cashier_schedules(work_date, user_id)');
        return;
      }

      await db.query(`
        CREATE TABLE IF NOT EXISTS cashier_schedules (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id BIGINT NOT NULL,
          work_date DATE NOT NULL,
          start_time VARCHAR(5) NOT NULL,
          end_time VARCHAR(5) NOT NULL,
          shift_name VARCHAR(80) NULL,
          status VARCHAR(24) NOT NULL DEFAULT 'scheduled',
          note TEXT NULL,
          created_by BIGINT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_cashier_schedules_date_user (work_date, user_id),
          CONSTRAINT fk_cashier_schedules_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          CONSTRAINT fk_cashier_schedules_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        )
      `);
    })().catch((err) => {
      ensureCashierScheduleTablePromise = null;
      throw err;
    });
  }
  return ensureCashierScheduleTablePromise;
};

const isValidDateKey = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const isValidTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email dan password wajib diisi' });

    await ensureDefaultBranches();

    const [rows] = await db.query(`
      SELECT u.*, b.name AS branch_name, b.branch_key
      FROM users u
      LEFT JOIN branches b ON b.id = u.default_branch_id
      WHERE u.email = ?
    `, [email]);
    if (!rows.length)
      return res.status(401).json({ message: 'Email tidak ditemukan' });

    const valid = await bcrypt.compare(password, rows[0].password);
    if (!valid)
      return res.status(401).json({ message: 'Password salah' });

    const user = rows[0];
    const token = jwt.sign(
      { id: user.id, role: user.role, branch_id: user.default_branch_id || null },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES }
    );

    // ── Catat kehadiran ──
    const today = new Date().toISOString().split('T')[0];
    const [existing] = await db.query(
      'SELECT id FROM attendance WHERE user_id = ? AND date = ?',
      [user.id, today]
    );
    if (!existing.length) {
      await db.query(
        'INSERT INTO attendance (user_id, date, login_at) VALUES (?, ?, NOW())',
        [user.id, today]
      );
    } else {
      // Update login_at jika login ulang
      await db.query(
        'UPDATE attendance SET login_at = NOW(), logout_at = NULL WHERE user_id = ? AND date = ?',
        [user.id, today]
      );
    }
    // Auto-buat draft pengajuan stok saat kasir login
    // const { autoRequestOnLogin } = require('./stockRequestController');
    // await autoRequestOnLogin(user.id, db);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        default_branch_id: user.default_branch_id || null,
        branch_name: user.branch_name || null,
        branch_key: user.branch_key || null,
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.logout = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    await db.query(
      'UPDATE attendance SET logout_at = NOW() WHERE user_id = ? AND date = ? AND logout_at IS NULL',
      [req.user.id, today]
    );
    res.json({ message: 'Logout berhasil' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getActiveUsers = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const branchId = getRequestBranchId(req) || req.user.branch_id || null;
    const branchWhere = branchId && branchId !== 'all' ? 'AND u.default_branch_id = ?' : '';
    const params = [today];
    if (branchWhere) params.push(branchId);
    // User aktif = login hari ini & belum logout
    const [rows] = await db.query(`
      SELECT u.id, u.name, u.role, a.login_at,
             TIMESTAMPDIFF(MINUTE, a.login_at, NOW()) AS active_minutes
      FROM attendance a
      JOIN users u ON a.user_id = u.id
      WHERE a.date = ? AND a.logout_at IS NULL ${branchWhere}
      ORDER BY a.login_at ASC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getMe = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.default_branch_id, b.name AS branch_name, b.branch_key, u.created_at
       FROM users u
       LEFT JOIN branches b ON b.id = u.default_branch_id
       WHERE u.id = ?`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'User tidak ditemukan' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.register = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ message: 'Semua field wajib diisi' });

    const [exists] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (exists.length)
      return res.status(400).json({ message: 'Email sudah digunakan' });

    const hash = await bcrypt.hash(password, 10);
    const branchId = getRequestBranchId(req) || req.user.branch_id || req.body.default_branch_id || null;
    const [result] = await db.query(
      "INSERT INTO users (name, email, password, role, default_branch_id) VALUES (?, ?, ?, ?, ?)",
      [name, email, hash, role || 'kasir', branchId]
    );

    res.status(201).json({ message: 'User berhasil dibuat', id: result.insertId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getAllUsers = async (req, res) => {
  try {
    const branchId = getRequestBranchId(req) || req.user.branch_id || null;
    const branchWhere = branchId && branchId !== 'all' ? 'WHERE u.default_branch_id = ?' : '';
    const params = branchWhere ? [branchId] : [];
    const [rows] = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.default_branch_id, b.name AS branch_name, u.created_at
       FROM users u
       LEFT JOIN branches b ON b.id = u.default_branch_id
       ${branchWhere}
       ORDER BY u.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getCashierSchedules = async (req, res) => {
  try {
    await ensureCashierScheduleTable();
    const today = new Date().toISOString().split('T')[0];
    const dateFrom = isValidDateKey(req.query.date_from) ? req.query.date_from : today;
    const dateTo = isValidDateKey(req.query.date_to) ? req.query.date_to : dateFrom;
    const branchId = getRequestBranchId(req) || req.user.branch_id || null;
    const params = [dateFrom, dateTo];
    let userFilter = '';

    if (req.query.user_id) {
      userFilter = ' AND cs.user_id = ?';
      params.push(req.query.user_id);
    }
    if (branchId && branchId !== 'all') {
      userFilter += ' AND u.default_branch_id = ?';
      params.push(branchId);
    }

    const [rows] = await db.query(`
      SELECT
        cs.id, cs.user_id, cs.work_date, cs.start_time, cs.end_time,
        cs.shift_name, cs.status, cs.note, cs.created_by, cs.created_at, cs.updated_at,
        u.name AS user_name, u.email AS user_email, u.role AS user_role,
        b.name AS branch_name,
        creator.name AS created_by_name
      FROM cashier_schedules cs
      JOIN users u ON u.id = cs.user_id
      LEFT JOIN branches b ON b.id = u.default_branch_id
      LEFT JOIN users creator ON creator.id = cs.created_by
      WHERE cs.work_date BETWEEN ? AND ?${userFilter}
      ORDER BY cs.work_date ASC, cs.start_time ASC, u.name ASC
    `, params);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Gagal memuat jadwal kasir' });
  }
};

exports.createCashierSchedule = async (req, res) => {
  try {
    await ensureCashierScheduleTable();
    const { user_id, work_date, start_time, end_time, shift_name, status, note } = req.body || {};
    const branchId = getRequestBranchId(req) || req.user.branch_id || null;

    if (!user_id || !isValidDateKey(work_date) || !isValidTime(start_time) || !isValidTime(end_time)) {
      return res.status(400).json({ message: 'Kasir, tanggal, jam mulai, dan jam selesai wajib valid' });
    }
    if (start_time >= end_time) {
      return res.status(400).json({ message: 'Jam selesai harus lebih besar dari jam mulai' });
    }

    const userParams = [user_id];
    let branchWhere = '';
    if (branchId && branchId !== 'all') {
      branchWhere = ' AND default_branch_id = ?';
      userParams.push(branchId);
    }
    const [users] = await db.query(`SELECT id FROM users WHERE id = ? AND role IN ('kasir', 'admin')${branchWhere}`, userParams);
    if (!users.length) return res.status(404).json({ message: 'Kasir tidak ditemukan' });

    const [result] = await db.query(`
      INSERT INTO cashier_schedules (user_id, work_date, start_time, end_time, shift_name, status, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      user_id,
      work_date,
      start_time,
      end_time,
      shift_name || 'Shift Kasir',
      status || 'scheduled',
      note || null,
      req.user.id,
    ]);

    res.status(201).json({ message: 'Jadwal kasir berhasil dibuat', id: result.insertId });
  } catch (err) {
    res.status(500).json({ message: 'Gagal membuat jadwal kasir' });
  }
};

exports.updateCashierSchedule = async (req, res) => {
  try {
    await ensureCashierScheduleTable();
    const { id } = req.params;
    const { user_id, work_date, start_time, end_time, shift_name, status, note } = req.body || {};
    const branchId = getRequestBranchId(req) || req.user.branch_id || null;

    if (!user_id || !isValidDateKey(work_date) || !isValidTime(start_time) || !isValidTime(end_time)) {
      return res.status(400).json({ message: 'Kasir, tanggal, jam mulai, dan jam selesai wajib valid' });
    }
    if (start_time >= end_time) {
      return res.status(400).json({ message: 'Jam selesai harus lebih besar dari jam mulai' });
    }

    const existingParams = [id];
    let existingBranchWhere = '';
    if (branchId && branchId !== 'all') {
      existingBranchWhere = ' AND u.default_branch_id = ?';
      existingParams.push(branchId);
    }
    const [existing] = await db.query(`
      SELECT cs.id
      FROM cashier_schedules cs
      JOIN users u ON u.id = cs.user_id
      WHERE cs.id = ?${existingBranchWhere}
    `, existingParams);
    if (!existing.length) return res.status(404).json({ message: 'Jadwal tidak ditemukan' });

    const userParams = [user_id];
    let userBranchWhere = '';
    if (branchId && branchId !== 'all') {
      userBranchWhere = ' AND default_branch_id = ?';
      userParams.push(branchId);
    }
    const [users] = await db.query(`SELECT id FROM users WHERE id = ? AND role IN ('kasir', 'admin')${userBranchWhere}`, userParams);
    if (!users.length) return res.status(404).json({ message: 'Kasir tidak ditemukan' });

    await db.query(`
      UPDATE cashier_schedules
      SET user_id = ?, work_date = ?, start_time = ?, end_time = ?, shift_name = ?, status = ?, note = ?, updated_at = NOW()
      WHERE id = ?
    `, [
      user_id,
      work_date,
      start_time,
      end_time,
      shift_name || 'Shift Kasir',
      status || 'scheduled',
      note || null,
      id,
    ]);

    res.json({ message: 'Jadwal kasir berhasil diperbarui' });
  } catch (err) {
    res.status(500).json({ message: 'Gagal memperbarui jadwal kasir' });
  }
};

exports.deleteCashierSchedule = async (req, res) => {
  try {
    await ensureCashierScheduleTable();
    const branchId = getRequestBranchId(req) || req.user.branch_id || null;
    const params = [req.params.id];
    let branchWhere = '';
    if (branchId && branchId !== 'all') {
      branchWhere = ' AND u.default_branch_id = ?';
      params.push(branchId);
    }
    const [existing] = await db.query(`
      SELECT cs.id
      FROM cashier_schedules cs
      JOIN users u ON u.id = cs.user_id
      WHERE cs.id = ?${branchWhere}
    `, params);
    if (!existing.length) return res.status(404).json({ message: 'Jadwal tidak ditemukan' });

    await db.query('DELETE FROM cashier_schedules WHERE id = ?', [req.params.id]);
    res.json({ message: 'Jadwal kasir berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: 'Gagal menghapus jadwal kasir' });
  }
};
