const db = require('../config/db');
const { ensureAttendanceAutomationSchema } = require('../services/attendanceKeepaliveService');

// ── Helpers ───────────────────────────────────────────────────
function formatDate(d) {
  if (d instanceof Date) {
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return String(d).split('T')[0];
}

// Cache HPP per product dalam 1 request — hindari query berulang
async function buildHPPMap(productIds) {
  if (!productIds.length) return {};
  const placeholders = productIds.map(() => '?').join(',');
  const [ings] = await db.query(`
    SELECT pi.product_id,
           CAST(pi.qty AS DECIMAL(10,4)) AS qty,
           si.price_per_unit
    FROM product_ingredients pi
    JOIN stock_items si ON pi.stock_item_id = si.id
    WHERE pi.product_id IN (${placeholders})
  `, productIds);

  const map = {};
  for (const row of ings) {
    const id = Number(row.product_id);
    if (!map[id]) map[id] = 0;
    map[id] += Number(row.price_per_unit) * parseFloat(row.qty);
  }
  return map; // { productId: hppPerPcs }
}

// ── getWeeklyAttendance (tidak berubah) ───────────────────────
exports.getWeeklyAttendance = async (req, res) => {
  try {
    await ensureAttendanceAutomationSchema();
    const { month, year } = req.query;
    const y = Number(year  || new Date().getFullYear());
    const m = Number(month || new Date().getMonth() + 1);

    const [rows] = await db.query(`
      SELECT u.id AS user_id, u.name,
             a.date, a.login_at, a.logout_at,
             DAYNAME(a.date) AS day_name,
             DAY(a.date)     AS day_num,
             DAYOFWEEK(a.date) AS day_of_week
      FROM attendance a
      JOIN users u ON a.user_id = u.id
      WHERE YEAR(a.date) = ? AND MONTH(a.date) = ? AND a.source = 'user'
      ORDER BY u.name, a.date ASC
    `, [y, m]);

    const getWeekNum  = (dayNum) => Math.ceil(dayNum / 7);
    const daysInMonth = new Date(y, m, 0).getDate();
    const weekRanges  = {};
    for (let d = 1; d <= daysInMonth; d++) {
      const wk = getWeekNum(d);
      if (!weekRanges[wk]) weekRanges[wk] = { start: d, end: d };
      weekRanges[wk].end = d;
    }

    const byUser = {};
    for (const row of rows) {
      if (!byUser[row.user_id]) {
        byUser[row.user_id] = { user_id: row.user_id, name: row.name, weeks: {} };
      }
      const wk    = getWeekNum(Number(row.day_num));
      const range = weekRanges[wk];
      const key   = `Minggu ${wk} (${range.start}-${range.end})`;

      if (!byUser[row.user_id].weeks[key]) {
        byUser[row.user_id].weeks[key] = { label: key, days: [], count: 0 };
      }
      byUser[row.user_id].weeks[key].days.push({
        date:     row.date,
        day_num:  Number(row.day_num),
        day_name: row.day_name,
        login_at: row.login_at,
      });
      byUser[row.user_id].weeks[key].count++;
    }

    const allWeekKeys = Object.entries(weekRanges)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([wk, r]) => `Minggu ${wk} (${r.start}-${r.end})`);

    res.json({ users: Object.values(byUser), allWeeks: allWeekKeys, weekRanges });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── getStaffPerformance — BATCH query, tidak N+1 ──────────────
exports.getStaffPerformance = async (req, res) => {
  try {
    const { month, year } = req.query;
    const y = Number(year  || new Date().getFullYear());
    const m = Number(month || new Date().getMonth() + 1);

    // 1. Rekap transaksi per kasir per hari
    const [rows] = await db.query(`
      SELECT u.id AS user_id, u.name,
             DATE(t.created_at) AS date,
             COUNT(t.id)        AS total_trx,
             SUM(t.total_price) AS total_revenue
      FROM transactions t
      JOIN users u ON t.created_by = u.id
      WHERE YEAR(t.created_at) = ? AND MONTH(t.created_at) = ?
      GROUP BY u.id, u.name, DATE(t.created_at)
      ORDER BY date ASC
    `, [y, m]);

    // 2. Semua transaction_items bulan ini — 1 query saja
    const [allItems] = await db.query(`
      SELECT t.created_by AS user_id,
             DATE(t.created_at) AS date,
             ti.product_id,
             ti.qty
      FROM transaction_items ti
      JOIN transactions t ON ti.transaction_id = t.id
      WHERE YEAR(t.created_at) = ? AND MONTH(t.created_at) = ?
    `, [y, m]);

    // 3. Per produk per kasir per hari
    const [prodRows] = await db.query(`
      SELECT u.id AS user_id, DATE(t.created_at) AS date,
             p.id AS product_id, p.name AS product_name,
             SUM(ti.qty) AS total_qty
      FROM transaction_items ti
      JOIN transactions t ON ti.transaction_id = t.id
      JOIN users u         ON t.created_by = u.id
      JOIN products p      ON ti.product_id = p.id
      WHERE YEAR(t.created_at) = ? AND MONTH(t.created_at) = ?
      GROUP BY u.id, DATE(t.created_at), p.id, p.name
      ORDER BY date ASC
    `, [y, m]);

    // 4. Build HPP map — 1 query untuk SEMUA produk sekaligus
    const uniqueProductIds = [...new Set(allItems.map(i => Number(i.product_id)))];
    const hppMap = await buildHPPMap(uniqueProductIds);

    // 5. Hitung HPP per user per hari dari allItems (no DB calls)
    // Group allItems: { "userId_dateStr": { productId: totalQty } }
    const itemsByUserDate = {};
    for (const item of allItems) {
      const dateStr = formatDate(item.date);
      const key     = `${item.user_id}_${dateStr}`;
      if (!itemsByUserDate[key]) itemsByUserDate[key] = [];
      itemsByUserDate[key].push({
        product_id: Number(item.product_id),
        qty:        Number(item.qty),
      });
    }

    // 6. Build byUser
    const byUser = {};
    for (const row of rows) {
      if (!byUser[row.user_id]) {
        byUser[row.user_id] = {
          user_id: row.user_id, name: row.name,
          data: [], total_trx: 0, total_revenue: 0, total_margin: 0,
        };
      }

      const dateStr = formatDate(row.date);
      const key     = `${row.user_id}_${dateStr}`;
      const items   = itemsByUserDate[key] || [];

      // Hitung HPP dari cache map — 0 DB calls
      let dayHPP = 0;
      for (const item of items) {
        const hppPerPcs = hppMap[item.product_id] || 0;
        dayHPP += hppPerPcs * item.qty;
      }

      const dayRevenue = Number(row.total_revenue);
      const dayMargin  = Math.round(dayRevenue - dayHPP);

      byUser[row.user_id].data.push({
        date:          dateStr,
        total_trx:     Number(row.total_trx),
        total_revenue: dayRevenue,
        total_margin:  dayMargin,
      });
      byUser[row.user_id].total_trx     += Number(row.total_trx);
      byUser[row.user_id].total_revenue += dayRevenue;
      byUser[row.user_id].total_margin  += dayMargin;
    }

    // 7. Attach product data
    for (const row of prodRows) {
      if (!byUser[row.user_id]) continue;
      const dateStr  = formatDate(row.date);
      const dayEntry = byUser[row.user_id].data.find(d => d.date === dateStr);
      if (!dayEntry) continue;
      if (!dayEntry.products) dayEntry.products = [];
      dayEntry.products.push({
        product_id:   Number(row.product_id),
        product_name: row.product_name,
        total_qty:    Number(row.total_qty),
      });
    }

    res.json(Object.values(byUser));
  } catch (err) {
    console.error('[getStaffPerformance]', err);
    res.status(500).json({ message: err.message });
  }
};
