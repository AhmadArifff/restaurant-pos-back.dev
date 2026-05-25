const crypto = require('crypto');
const db = require('../config/db');

const DEFAULT_BRANCHES = [
  { branch_key: 'bandung', name: 'Sultan Kebab Dago', area: 'Bandung Kota' },
  { branch_key: 'jakarta', name: 'Sultan Kebab SCBD', area: 'Jakarta Selatan' },
  { branch_key: 'surabaya', name: 'Sultan Kebab Pakuwon', area: 'Surabaya Barat' },
];

const normalizeKey = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80) || crypto.randomBytes(4).toString('hex');

const parseSettingValue = (row) => {
  if (!row?.setting_value) return null;
  try {
    return JSON.parse(row.setting_value);
  } catch {
    return null;
  }
};

const getLandingBranches = async () => {
  const [rows] = await db.query(
    "SELECT setting_value FROM website_settings WHERE setting_key = 'landing_locations' LIMIT 1"
  );
  const setting = parseSettingValue(rows[0]);
  const branches = Array.isArray(setting?.branches) ? setting.branches : [];

  if (!branches.length) return DEFAULT_BRANCHES;

  return branches.map((branch, index) => ({
    branch_key: normalizeKey(branch.id || branch.name || `branch-${index + 1}`),
    name: branch.name || branch.tabLabel || `Cabang ${index + 1}`,
    area: branch.area || branch.sectionTag || null,
    address: Array.isArray(branch.details)
      ? (branch.details.find((detail) => detail.text)?.text || null)
      : null,
    phone: Array.isArray(branch.details)
      ? (branch.details.find((detail) => Array.isArray(detail.lines))?.lines?.[0] || null)
      : null,
  }));
};

const ensureDefaultBranches = async () => {
  const [existing] = await db.query('SELECT id FROM branches LIMIT 1');
  if (existing.length) return;

  const branches = await getLandingBranches();
  for (const branch of branches) {
    await db.query(`
      INSERT INTO branches (branch_key, name, area, address, phone, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `, [branch.branch_key, branch.name, branch.area || null, branch.address || null, branch.phone || null]);
  }
};

exports.ensureDefaultBranches = ensureDefaultBranches;

exports.list = async (req, res) => {
  try {
    await ensureDefaultBranches();
    const [rows] = await db.query(`
      SELECT id, branch_key, name, area, address, phone, status, created_at, updated_at
      FROM branches
      WHERE status = 'active'
      ORDER BY name ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.syncFromLanding = async (req, res) => {
  try {
    const branches = await getLandingBranches();
    for (const branch of branches) {
      const [existing] = await db.query('SELECT id FROM branches WHERE branch_key = ? LIMIT 1', [branch.branch_key]);
      if (existing.length) {
        await db.query(`
          UPDATE branches
          SET name = ?, area = ?, address = ?, phone = ?, status = 'active'
          WHERE branch_key = ?
        `, [branch.name, branch.area || null, branch.address || null, branch.phone || null, branch.branch_key]);
      } else {
        await db.query(`
          INSERT INTO branches (branch_key, name, area, address, phone, status)
          VALUES (?, ?, ?, ?, ?, 'active')
        `, [branch.branch_key, branch.name, branch.area || null, branch.address || null, branch.phone || null]);
      }
    }
    const [rows] = await db.query("SELECT * FROM branches WHERE status = 'active' ORDER BY name ASC");
    res.json({ message: 'Cabang berhasil disinkronkan dari landing page', data: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.setMyBranch = async (req, res) => {
  try {
    const branchId = Number(req.body.branch_id);
    if (!branchId) return res.status(400).json({ message: 'Cabang wajib dipilih' });

    const [branches] = await db.query("SELECT id FROM branches WHERE id = ? AND status = 'active'", [branchId]);
    if (!branches.length) return res.status(404).json({ message: 'Cabang tidak ditemukan' });

    await db.query('UPDATE users SET default_branch_id = ? WHERE id = ?', [branchId, req.user.id]);
    res.json({ message: 'Cabang aktif berhasil disimpan', branch_id: branchId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
