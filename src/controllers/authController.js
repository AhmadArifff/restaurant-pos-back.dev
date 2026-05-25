const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { ensureDefaultBranches } = require('./branchController');

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
    // User aktif = login hari ini & belum logout
    const [rows] = await db.query(`
      SELECT u.id, u.name, u.role, a.login_at,
             TIMESTAMPDIFF(MINUTE, a.login_at, NOW()) AS active_minutes
      FROM attendance a
      JOIN users u ON a.user_id = u.id
      WHERE a.date = ? AND a.logout_at IS NULL
      ORDER BY a.login_at ASC
    `, [today]);
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
    const [result] = await db.query(
      "INSERT INTO users (name, email, password, role, default_branch_id) VALUES (?, ?, ?, ?, ?)",
      [name, email, hash, role || 'kasir', req.body.default_branch_id || null]
    );

    res.status(201).json({ message: 'User berhasil dibuat', id: result.insertId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getAllUsers = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.default_branch_id, b.name AS branch_name, u.created_at
       FROM users u
       LEFT JOIN branches b ON b.id = u.default_branch_id
       ORDER BY u.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
