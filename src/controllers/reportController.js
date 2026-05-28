const PDFDocument = require('pdfkit');
const db = require('../config/db');
const { getRequestBranchId } = require('../utils/branchContext');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

const money = (value) => Number(value || 0);
const pct = (value) => Math.round(Number(value || 0) * 10) / 10;

const formatCurrency = (value) =>
  `Rp ${money(value).toLocaleString('id-ID')}`;

const toSqlDate = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const jakartaDateExpr = (column) =>
  db.isPostgres
    ? `CAST(${column} AT TIME ZONE 'Asia/Jakarta' AS DATE)`
    : `DATE(${column})`;

const getPeriodRange = (period, month, year) => {
  const y = Number(year || new Date().getFullYear());
  const m = Number(month || new Date().getMonth() + 1);

  if (period === 'monthly') {
    return {
      start: `${y}-01-01`,
      end: `${y}-12-31`,
      prevStart: `${y - 1}-01-01`,
      prevEnd: `${y - 1}-12-31`,
      label: `Tahun ${y}`,
    };
  }

  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0);
  const prevStart = new Date(y, m - 2, 1);
  const prevEnd = new Date(y, m - 1, 0);
  const iso = (date) => date.toISOString().slice(0, 10);

  return {
    start: iso(start),
    end: iso(end),
    prevStart: iso(prevStart),
    prevEnd: iso(prevEnd),
    label: `${MONTHS[m - 1]} ${y}`,
  };
};

const getTotals = async (start, end) => {
  const [[trx]] = await db.query(`
    SELECT COUNT(DISTINCT id) AS total_trx,
           COALESCE(SUM(total_price), 0) AS revenue
    FROM transactions
    WHERE DATE(created_at) BETWEEN ? AND ?
  `, [start, end]);

  const [[hpp]] = await db.query(`
    SELECT COALESCE(SUM(ti.qty * COALESCE(ing.hpp_per_product, 0)), 0) AS hpp
    FROM transaction_items ti
    JOIN transactions t ON ti.transaction_id = t.id
    LEFT JOIN (
      SELECT pi.product_id, SUM(CAST(pi.qty AS DECIMAL(10,4)) * si.price_per_unit) AS hpp_per_product
      FROM product_ingredients pi
      JOIN stock_items si ON pi.stock_item_id = si.id
      GROUP BY pi.product_id
    ) ing ON ing.product_id = ti.product_id
    WHERE DATE(t.created_at) BETWEEN ? AND ?
  `, [start, end]);

  const revenue = money(trx.revenue);
  const totalHpp = money(hpp.hpp);
  const grossProfit = revenue - totalHpp;
  const totalTrx = Number(trx.total_trx || 0);

  return {
    revenue: Math.round(revenue),
    hpp: Math.round(totalHpp),
    gross_profit: Math.round(grossProfit),
    margin_pct: revenue > 0 ? pct((grossProfit / revenue) * 100) : 0,
    total_trx: totalTrx,
    avg_order_value: totalTrx > 0 ? Math.round(revenue / totalTrx) : 0,
  };
};

const getSeries = async (period, start, end) => {
  const groupExpr = period === 'monthly' ? 'MONTH(created_at)' : 'DATE(created_at)';
  const hppGroupExpr = period === 'monthly' ? 'MONTH(t.created_at)' : 'DATE(t.created_at)';

  const [trxRows] = await db.query(`
    SELECT ${groupExpr} AS period_key,
           COUNT(DISTINCT id) AS total_trx,
           COALESCE(SUM(total_price), 0) AS revenue
    FROM transactions
    WHERE DATE(created_at) BETWEEN ? AND ?
    GROUP BY ${groupExpr}
    ORDER BY period_key ASC
  `, [start, end]);

  const [hppRows] = await db.query(`
    SELECT ${hppGroupExpr} AS period_key,
           COALESCE(SUM(ti.qty * COALESCE(ing.hpp_per_product, 0)), 0) AS hpp
    FROM transaction_items ti
    JOIN transactions t ON ti.transaction_id = t.id
    LEFT JOIN (
      SELECT pi.product_id, SUM(CAST(pi.qty AS DECIMAL(10,4)) * si.price_per_unit) AS hpp_per_product
      FROM product_ingredients pi
      JOIN stock_items si ON pi.stock_item_id = si.id
      GROUP BY pi.product_id
    ) ing ON ing.product_id = ti.product_id
    WHERE DATE(t.created_at) BETWEEN ? AND ?
    GROUP BY ${hppGroupExpr}
    ORDER BY period_key ASC
  `, [start, end]);

  const hppByKey = new Map(hppRows.map((row) => [String(row.period_key), money(row.hpp)]));

  return trxRows.map((row) => {
    const key = String(row.period_key);
    const revenue = money(row.revenue);
    const hpp = hppByKey.get(key) || 0;
    const margin = revenue - hpp;
    return {
      period_key: row.period_key,
      label: period === 'monthly'
        ? MONTHS[Number(row.period_key) - 1]
        : new Date(row.period_key).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }),
      total_trx: Number(row.total_trx || 0),
      revenue: Math.round(revenue),
      hpp: Math.round(hpp),
      margin: Math.round(margin),
      margin_pct: revenue > 0 ? pct((margin / revenue) * 100) : 0,
    };
  });
};

const getTrailingDailyTrend = async (days) => {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));

  const rows = await getSeries('daily', toSqlDate(start), toSqlDate(end));
  const byDate = new Map(rows.map((row) => [toSqlDate(new Date(row.period_key)), row]));

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = toSqlDate(date);
    const found = byDate.get(key);

    return found || {
      period_key: key,
      label: date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }),
      total_trx: 0,
      revenue: 0,
      hpp: 0,
      margin: 0,
      margin_pct: 0,
    };
  });
};

const getTrailingMonthlyTrend = async (months = 12) => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const [trxRows] = await db.query(`
    SELECT YEAR(created_at) AS year_key,
           MONTH(created_at) AS month_key,
           COUNT(DISTINCT id) AS total_trx,
           COALESCE(SUM(total_price), 0) AS revenue
    FROM transactions
    WHERE DATE(created_at) BETWEEN ? AND ?
    GROUP BY YEAR(created_at), MONTH(created_at)
    ORDER BY year_key ASC, month_key ASC
  `, [toSqlDate(start), toSqlDate(end)]);

  const [hppRows] = await db.query(`
    SELECT YEAR(t.created_at) AS year_key,
           MONTH(t.created_at) AS month_key,
           COALESCE(SUM(ti.qty * COALESCE(ing.hpp_per_product, 0)), 0) AS hpp
    FROM transaction_items ti
    JOIN transactions t ON ti.transaction_id = t.id
    LEFT JOIN (
      SELECT pi.product_id, SUM(CAST(pi.qty AS DECIMAL(10,4)) * si.price_per_unit) AS hpp_per_product
      FROM product_ingredients pi
      JOIN stock_items si ON pi.stock_item_id = si.id
      GROUP BY pi.product_id
    ) ing ON ing.product_id = ti.product_id
    WHERE DATE(t.created_at) BETWEEN ? AND ?
    GROUP BY YEAR(t.created_at), MONTH(t.created_at)
    ORDER BY year_key ASC, month_key ASC
  `, [toSqlDate(start), toSqlDate(end)]);

  const hppByKey = new Map(hppRows.map((row) => [`${row.year_key}-${row.month_key}`, money(row.hpp)]));
  const trxByKey = new Map(trxRows.map((row) => [`${row.year_key}-${row.month_key}`, row]));

  return Array.from({ length: months }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth() + index, 1);
    const yearKey = date.getFullYear();
    const monthKey = date.getMonth() + 1;
    const key = `${yearKey}-${monthKey}`;
    const trx = trxByKey.get(key);
    const revenue = money(trx?.revenue);
    const hpp = hppByKey.get(key) || 0;
    const margin = revenue - hpp;

    return {
      period_key: key,
      label: `${MONTHS[monthKey - 1]} ${String(yearKey).slice(2)}`,
      total_trx: Number(trx?.total_trx || 0),
      revenue: Math.round(revenue),
      hpp: Math.round(hpp),
      margin: Math.round(margin),
      margin_pct: revenue > 0 ? pct((margin / revenue) * 100) : 0,
    };
  });
};

const getBestProducts = async (start, end, limit = 8) => {
  const [rows] = await db.query(`
    SELECT p.id, p.name,
           SUM(ti.qty) AS total_sold,
           SUM(ti.subtotal) AS revenue,
           COALESCE(SUM(ti.qty * COALESCE(ing.hpp_per_product, 0)), 0) AS hpp
    FROM transaction_items ti
    JOIN transactions t ON ti.transaction_id = t.id
    LEFT JOIN products p ON ti.product_id = p.id
    LEFT JOIN (
      SELECT pi.product_id, SUM(CAST(pi.qty AS DECIMAL(10,4)) * si.price_per_unit) AS hpp_per_product
      FROM product_ingredients pi
      JOIN stock_items si ON pi.stock_item_id = si.id
      GROUP BY pi.product_id
    ) ing ON ing.product_id = ti.product_id
    WHERE DATE(t.created_at) BETWEEN ? AND ?
    GROUP BY p.id, p.name
    ORDER BY total_sold DESC
    LIMIT ?
  `, [start, end, Number(limit)]);

  return rows.map((row) => {
    const revenue = money(row.revenue);
    const hpp = money(row.hpp);
    const margin = revenue - hpp;
    return {
      ...row,
      total_sold: Number(row.total_sold || 0),
      revenue: Math.round(revenue),
      hpp: Math.round(hpp),
      margin: Math.round(margin),
      margin_pct: revenue > 0 ? pct((margin / revenue) * 100) : 0,
    };
  });
};

const getCashierPerformance = async (start, end) => {
  const [rows] = await db.query(`
    SELECT u.id,
           COALESCE(u.name, 'Tidak diketahui') AS name,
           COUNT(DISTINCT t.id) AS total_trx,
           COALESCE(SUM(t.total_price), 0) AS revenue
    FROM transactions t
    LEFT JOIN users u ON u.id = COALESCE(t.source_user_id, t.created_by)
    WHERE DATE(t.created_at) BETWEEN ? AND ?
    GROUP BY u.id, u.name
    ORDER BY revenue DESC
    LIMIT 10
  `, [start, end]);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    total_trx: Number(row.total_trx || 0),
    revenue: Math.round(money(row.revenue)),
    avg_order_value: Number(row.total_trx || 0) > 0
      ? Math.round(money(row.revenue) / Number(row.total_trx))
      : 0,
  }));
};

const getPaymentMix = async (start, end) => {
  const [rows] = await db.query(`
    SELECT payment_method,
           COUNT(*) AS total_trx,
           COALESCE(SUM(total_price), 0) AS revenue
    FROM transactions
    WHERE DATE(created_at) BETWEEN ? AND ?
    GROUP BY payment_method
    ORDER BY revenue DESC
  `, [start, end]);

  return rows.map((row) => ({
    payment_method: row.payment_method || 'unknown',
    total_trx: Number(row.total_trx || 0),
    revenue: Math.round(money(row.revenue)),
  }));
};

const getDiscountSummary = async (start, end, branchId = null) => {
  const discountDate = jakartaDateExpr('COALESCE(t.created_at, co.created_at, dr.created_at)');
  const branchFilter = branchId ? 'AND COALESCE(t.branch_id, co.branch_id) = ?' : '';
  const params = branchId ? [start, end, branchId] : [start, end];

  const [[row]] = await db.query(`
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(dr.discount_amount), 0) AS total_discount,
      COALESCE(AVG(NULLIF((dr.discount_amount / NULLIF(dr.subtotal, 0)) * 100, 0)), 0) AS avg_discount_rate
    FROM discount_redemptions dr
    LEFT JOIN customer_orders co ON co.id = dr.order_id
    LEFT JOIN transactions t ON t.id = dr.transaction_id
    WHERE ${discountDate} BETWEEN ? AND ?
      AND COALESCE(dr.discount_amount, 0) > 0
      ${branchFilter}
  `, params);

  const [byType] = await db.query(`
    SELECT dp.type,
      COUNT(*) AS total_orders,
      COALESCE(SUM(dr.discount_amount), 0) AS total_discount
    FROM discount_redemptions dr
    JOIN discount_programs dp ON dp.id = dr.program_id
    LEFT JOIN customer_orders co ON co.id = dr.order_id
    LEFT JOIN transactions t ON t.id = dr.transaction_id
    WHERE ${discountDate} BETWEEN ? AND ?
      AND COALESCE(dr.discount_amount, 0) > 0
      ${branchFilter}
    GROUP BY dp.type
    ORDER BY total_discount DESC
  `, params);

  return {
    total_orders: Number(row?.total_orders || 0),
    total_discount: Math.round(money(row?.total_discount || 0)),
    avg_discount_rate: pct(row?.avg_discount_rate || 0),
    by_type: byType.map((item) => ({
      type: item.type,
      total_orders: Number(item.total_orders || 0),
      total_discount: Math.round(money(item.total_discount || 0)),
    })),
  };
};

const getLowStockItems = async () => {
  const [rows] = await db.query(`
    SELECT id, name, stock, min_stock, unit, price_per_unit
    FROM stock_items
    WHERE stock <= min_stock
    ORDER BY stock ASC
    LIMIT 10
  `);

  return rows.map((row) => ({
    ...row,
    stock: Number(row.stock || 0),
    min_stock: Number(row.min_stock || 0),
    price_per_unit: Number(row.price_per_unit || 0),
  }));
};

const getAttendanceSummary = async (start, end) => {
  const activeMinutesExpr = db.isPostgres
    ? `EXTRACT(EPOCH FROM (
        (
          CASE
            WHEN a.logout_at IS NOT NULL THEN a.logout_at
            WHEN a.date = CURRENT_DATE THEN NOW()
            ELSE a.date::timestamp + time '23:59:59'
          END
        ) - a.login_at
      )) / 60`
    : `TIMESTAMPDIFF(
        MINUTE,
        a.login_at,
        CASE
          WHEN a.logout_at IS NOT NULL THEN a.logout_at
          WHEN a.date = CURDATE() THEN NOW()
          ELSE TIMESTAMP(a.date, '23:59:59')
        END
      )`;

  const [rows] = await db.query(`
    SELECT u.id,
           u.name,
           COUNT(DISTINCT a.date) AS active_days,
           ROUND(SUM(
             LEAST(
               720,
               GREATEST(
                 0,
                 ${activeMinutesExpr}
               )
             )
           ) / 60, 1) AS active_hours
    FROM attendance a
    JOIN users u ON u.id = a.user_id
    WHERE a.date BETWEEN ? AND ?
    GROUP BY u.id, u.name
    ORDER BY active_hours DESC
    LIMIT 10
  `, [start, end]);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    active_days: Number(row.active_days || 0),
    active_hours: Number(row.active_hours || 0),
  }));
};

const buildInsights = ({ current, previous, series, bestProducts, lowStockItems, cashierPerformance, discounts }) => {
  const growth = previous.revenue > 0
    ? ((current.revenue - previous.revenue) / previous.revenue) * 100
    : current.revenue > 0 ? 100 : 0;

  const bestPeriod = [...series].sort((a, b) => b.revenue - a.revenue)[0] || null;
  const weakPeriod = [...series].filter((row) => row.revenue > 0).sort((a, b) => a.revenue - b.revenue)[0] || null;
  const topProduct = bestProducts[0] || null;
  const topCashier = cashierPerformance[0] || null;

  const insights = [];
  insights.push({
    title: growth >= 0 ? 'Pertumbuhan omzet positif' : 'Omzet turun dibanding periode sebelumnya',
    severity: growth >= 0 ? 'good' : 'risk',
    text: `Omzet ${growth >= 0 ? 'naik' : 'turun'} ${Math.abs(pct(growth))}% dibanding periode pembanding.`,
  });

  insights.push({
    title: current.margin_pct >= 45 ? 'Margin sehat' : 'Margin perlu dievaluasi',
    severity: current.margin_pct >= 45 ? 'good' : 'warning',
    text: `Gross margin saat ini ${current.margin_pct}%. ${current.margin_pct >= 45 ? 'Struktur harga dan HPP masih relatif sehat.' : 'Cek harga jual, penggunaan bahan, dan produk dengan margin rendah.'}`,
  });

  if (bestPeriod) {
    insights.push({
      title: 'Periode penjualan terbaik',
      severity: 'info',
      text: `${bestPeriod.label} menghasilkan omzet tertinggi sebesar ${formatCurrency(bestPeriod.revenue)} dari ${bestPeriod.total_trx} transaksi.`,
    });
  }

  if (weakPeriod) {
    insights.push({
      title: 'Periode perlu dorongan penjualan',
      severity: 'warning',
      text: `${weakPeriod.label} adalah titik terendah aktif dengan omzet ${formatCurrency(weakPeriod.revenue)}. Evaluasi promo, jam operasional, atau ketersediaan stok.`,
    });
  }

  if (topProduct) {
    insights.push({
      title: 'Produk unggulan',
      severity: 'good',
      text: `${topProduct.name} menjadi produk terlaris dengan ${topProduct.total_sold} terjual dan margin ${topProduct.margin_pct}%.`,
    });
  }

  if (lowStockItems.length > 0) {
    insights.push({
      title: 'Risiko stok kritis',
      severity: 'risk',
      text: `${lowStockItems.length} bahan berada di bawah atau sama dengan minimum stok. Prioritaskan restock untuk menjaga penjualan tidak terhambat.`,
    });
  }

  if (topCashier) {
    insights.push({
      title: 'Karyawan untuk diapresiasi',
      severity: 'good',
      text: `${topCashier.name} mencatat performa kasir tertinggi dengan omzet ${formatCurrency(topCashier.revenue)} dan ${topCashier.total_trx} transaksi.`,
    });
  }

  if (discounts?.total_discount > 0) {
    insights.push({
      title: 'Program review menghasilkan distribusi diskon',
      severity: 'info',
      text: `${discounts.total_orders} pesanan sudah direview dengan total distribusi diskon ${formatCurrency(discounts.total_discount)}. Ini bisa dibaca sebagai biaya kecil untuk mendapatkan feedback pelanggan.`,
    });
  }

  return {
    growth_pct: pct(growth),
    insights,
  };
};

const buildBusinessReportData = async ({ period = 'daily', month, year }) => {
  const range = getPeriodRange(period, month, year);
  const branchId = null;
  const [current, previous, series, bestProducts, cashierPerformance, paymentMix, discounts, lowStockItems, attendanceSummary, trend7Days, trend30Days, trend12Months] =
    await Promise.all([
      getTotals(range.start, range.end),
      getTotals(range.prevStart, range.prevEnd),
      getSeries(period, range.start, range.end),
      getBestProducts(range.start, range.end),
      getCashierPerformance(range.start, range.end),
      getPaymentMix(range.start, range.end),
      getDiscountSummary(range.start, range.end, branchId),
      getLowStockItems(),
      getAttendanceSummary(range.start, range.end),
      getTrailingDailyTrend(7),
      getTrailingDailyTrend(30),
      getTrailingMonthlyTrend(12),
    ]);

  const analysis = buildInsights({ current, previous, series, bestProducts, lowStockItems, cashierPerformance, discounts });

  return {
    period,
    range,
    generated_at: new Date().toISOString(),
    summary: {
      ...current,
      previous_revenue: previous.revenue,
      growth_pct: analysis.growth_pct,
    },
    series,
    best_products: bestProducts,
    cashier_performance: cashierPerformance,
    payment_mix: paymentMix,
    discounts,
    low_stock_items: lowStockItems,
    attendance_summary: attendanceSummary,
    trends: {
      last_7_days: trend7Days,
      last_30_days: trend30Days,
      last_12_months: trend12Months,
    },
    insights: analysis.insights,
  };
};

// Helper: hitung HPP per produk dari bahan baku
async function getProductHPP(productId, conn = null) {
  const q = conn || require('../config/db');
  const [ings] = await q.query(`
    SELECT CAST(pi.qty AS DECIMAL(10,4)) AS qty,
           si.price_per_unit
    FROM product_ingredients pi
    JOIN stock_items si ON pi.stock_item_id = si.id
    WHERE pi.product_id = ?
  `, [productId]);
  return ings.reduce((sum, i) => {
    return sum + (Number(i.price_per_unit) * parseFloat(i.qty));
  }, 0);
}

exports.sales = async (req, res) => {
  try {
    const { period = 'daily', month, year } = req.query;
    const y = year  || new Date().getFullYear();
    const m = month || new Date().getMonth() + 1;

    let sql, params = [y];

    if (period === 'monthly') {
      sql = `
        SELECT MONTH(t.created_at) AS month,
               COUNT(DISTINCT t.id) AS total_trx,
               SUM(t.total_price)   AS revenue
        FROM transactions t
        WHERE YEAR(t.created_at) = ?
        GROUP BY MONTH(t.created_at)
        ORDER BY month ASC
      `;
    } else {
      sql = `
        SELECT DATE(t.created_at)    AS date,
               COUNT(DISTINCT t.id)  AS total_trx,
               SUM(t.total_price)    AS revenue
        FROM transactions t
        WHERE YEAR(t.created_at) = ? AND MONTH(t.created_at) = ?
        GROUP BY DATE(t.created_at)
        ORDER BY date ASC
      `;
      params.push(m);
    }

    const [rows] = await db.query(sql, params);

    for (const row of rows) {
      // Filter per tanggal/bulan
      // ── Build filter per periode ──
      let dateFilter;
      if (period === 'monthly') {
        dateFilter = `YEAR(t.created_at) = ${y} AND MONTH(t.created_at) = ${Number(row.month)}`;
      } else {
        // ← Handle semua kemungkinan format tanggal dari MySQL
        let d;
        if (row.date instanceof Date) {
          // MySQL return Date object
          const yyyy = row.date.getFullYear();
          const mm   = String(row.date.getMonth() + 1).padStart(2, '0');
          const dd   = String(row.date.getDate()).padStart(2, '0');
          d = `${yyyy}-${mm}-${dd}`;
        } else {
          // MySQL return string — ambil bagian tanggal saja
          d = String(row.date).split('T')[0];
        }
        dateFilter = `DATE(t.created_at) = '${d}'`;
      }

      // Ambil semua item transaksi di periode ini
      const [items] = await db.query(`
        SELECT ti.product_id, ti.qty
        FROM transaction_items ti
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE ${dateFilter}
      `);

      // Hitung HPP DULU, baru assign ke row
      let totalHPP = 0;
      for (const item of items) {
        const hpp = await getProductHPP(item.product_id);
        totalHPP += hpp * Number(item.qty);
      }

      // Assign setelah HPP selesai dihitung
      row.hpp    = Math.round(totalHPP);
      row.margin = Math.round(Number(row.revenue) - totalHPP);
      if (isNaN(row.margin)) row.margin = 0;
      if (isNaN(row.hpp))    row.hpp    = 0;
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.todayStats = async (req, res) => {
  try {
    const jakartaNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const today = toSqlDate(jakartaNow);
    const branchId = getRequestBranchId(req) || req.user?.branch_id || null;
    const branchFilter = branchId ? 'AND t.branch_id = ?' : '';
    const params = branchId ? [today, branchId] : [today];
    const txDate = jakartaDateExpr('t.created_at');

    // Total transaksi & revenue hari ini
    const [[stat]] = await db.query(`
      SELECT
        COUNT(DISTINCT t.id)  AS total_trx,
        COALESCE(SUM(t.total_price), 0) AS revenue
      FROM transactions t
      WHERE ${txDate} = ?
      ${branchFilter}
    `, params);

    // Hitung HPP hari ini
    const [items] = await db.query(`
      SELECT ti.product_id, ti.qty
      FROM transaction_items ti
      JOIN transactions t ON ti.transaction_id = t.id
      WHERE ${txDate} = ?
      ${branchFilter}
    `, params);

    let totalHPP = 0;
    for (const item of items) {
      const hpp = await getProductHPP(item.product_id);
      totalHPP += hpp * item.qty;
    }

    const revenue = Number(stat.revenue);
    const margin  = revenue - totalHPP;

    res.json({
      total_trx:  Number(stat.total_trx),
      revenue:    Math.round(revenue),
      hpp:        Math.round(totalHPP),
      margin:     Math.round(margin),
      margin_pct: revenue > 0 ? Math.round((margin / revenue) * 100) : 0,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.discountSummary = async (req, res) => {
  try {
    const jakartaNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const today = toSqlDate(jakartaNow);
    const year = Number(req.query.year || jakartaNow.getFullYear());
    const month = Number(req.query.month || jakartaNow.getMonth() + 1);
    const branchId = getRequestBranchId(req) || req.user?.branch_id || null;
    const monthStart = toSqlDate(new Date(year, month - 1, 1));
    const monthEnd = toSqlDate(new Date(year, month, 0));
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const [todayData, monthData, yearData, allTime] = await Promise.all([
      getDiscountSummary(today, today, branchId),
      getDiscountSummary(monthStart, monthEnd, branchId),
      getDiscountSummary(yearStart, yearEnd, branchId),
      getDiscountSummary('1970-01-01', '2999-12-31', branchId),
    ]);

    res.json({
      today: todayData,
      month: monthData,
      year: yearData,
      all_time: allTime,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.bestSelling = async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const [rows] = await db.query(
      `SELECT p.id, p.name,
              SUM(ti.qty)      AS total_sold,
              SUM(ti.subtotal) AS revenue
       FROM transaction_items ti
       LEFT JOIN products p ON ti.product_id = p.id
       GROUP BY p.id, p.name
       ORDER BY total_sold DESC
       LIMIT ?`,
      [Number(limit)]
    );

    // Tambah HPP & margin per produk
    for (const row of rows) {
      const hpp       = await getProductHPP(row.id);
      row.hpp_per_pcs = Math.round(hpp);
      row.total_hpp   = Math.round(hpp * row.total_sold);
      row.margin      = Math.round(Number(row.revenue) - row.total_hpp);
      row.margin_pct  = Number(row.revenue) > 0
        ? Math.round((row.margin / Number(row.revenue)) * 100) : 0;
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.stockLow = async (req, res) => {
  try {
    const { threshold = 5 } = req.query;

    // Ambil stok bahan baku yang menipis
    const [stockItems] = await db.query(`
      SELECT s.id, s.name, s.stock, s.min_stock, s.unit, s.price_per_unit
      FROM stock_items s
      WHERE s.stock <= ?
      ORDER BY s.stock ASC
    `, [Number(threshold)]);

    // Untuk tiap bahan baku yang menipis, cari produk yang memakainya
    for (const item of stockItems) {
      const [prods] = await db.query(`
        SELECT p.name, pi.qty AS qty_per_produk,
          FLOOR(? / pi.qty) AS estimasi_porsi
        FROM product_ingredients pi
        JOIN products p ON pi.product_id = p.id
        WHERE pi.stock_item_id = ?
        ORDER BY estimasi_porsi ASC
      `, [item.stock, item.id]);
      item.affected_products = prods;
      item.min_porsi = prods.length > 0
        ? Math.min(...prods.map(p => p.estimasi_porsi)) : 0;
    }

    res.json(stockItems);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.yearlyStats = async (req, res) => {
  try {
    const y = req.query.year || new Date().getFullYear();

    const [rows] = await db.query(`
      SELECT MONTH(t.created_at) AS month,
             COUNT(DISTINCT t.id) AS total_trx,
             SUM(t.total_price)   AS revenue
      FROM transactions t
      WHERE YEAR(t.created_at) = ?
      GROUP BY MONTH(t.created_at)
      ORDER BY month ASC
    `, [y]);

    // Hitung HPP & margin per bulan
    for (const row of rows) {
      const [items] = await db.query(`
        SELECT ti.product_id, ti.qty
        FROM transaction_items ti
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE YEAR(t.created_at) = ? AND MONTH(t.created_at) = ?
      `, [y, row.month]);

      let totalHPP = 0;
      for (const item of items) {
        const hpp = await getProductHPP(item.product_id);
        totalHPP += hpp * Number(item.qty);
      }

      row.hpp    = Math.round(totalHPP);
      row.margin = Math.round(Number(row.revenue) - totalHPP);
    }

    // Lengkapi 12 bulan — bulan kosong = 0
    const months = Array.from({ length: 12 }, (_, i) => {
      const found = rows.find(r => Number(r.month) === i + 1);
      return {
        month:     i + 1,
        total_trx: found ? Number(found.total_trx) : 0,
        revenue:   found ? Number(found.revenue)   : 0,
        hpp:       found ? Number(found.hpp)        : 0,
        margin:    found ? Number(found.margin)     : 0,
      };
    });

    res.json(months);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getTransactionYears = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT DISTINCT YEAR(created_at) AS year
      FROM transactions
      ORDER BY year DESC
    `);
    const years = rows.map(r => r.year);
    // Kalau belum ada transaksi, return tahun sekarang
    if (years.length === 0) years.push(new Date().getFullYear());
    res.json(years);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.salesByProduct = async (req, res) => {
  try {
    const { period = 'daily', month, year } = req.query;
    const y = year  || new Date().getFullYear();
    const m = month || new Date().getMonth() + 1;

    let groupBy, dateSelect;
    if (period === 'monthly') {
      groupBy    = 'MONTH(t.created_at), ti.product_id, p.name';
      dateSelect = 'MONTH(t.created_at) AS period_key';
    } else {
      groupBy    = 'DATE(t.created_at), ti.product_id, p.name';
      dateSelect = 'DATE(t.created_at) AS period_key';
    }

    const whereYear  = `YEAR(t.created_at) = ${db.escape ? db.escape(y) : y}`;
    const whereMonth = period === 'daily'
      ? `AND MONTH(t.created_at) = ${db.escape ? db.escape(m) : m}` : '';

    const [rows] = await db.query(`
      SELECT
        ${dateSelect},
        ti.product_id,
        p.name AS product_name,
        SUM(ti.qty)      AS total_qty,
        SUM(ti.subtotal) AS total_revenue
      FROM transaction_items ti
      JOIN transactions t ON ti.transaction_id = t.id
      JOIN products p     ON ti.product_id = p.id
      WHERE ${whereYear} ${whereMonth}
      GROUP BY ${groupBy}
      ORDER BY period_key ASC, total_qty DESC
    `);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.businessAnalysis = async (req, res) => {
  try {
    const data = await buildBusinessReportData(req.query);
    res.json(data);
  } catch (err) {
    console.error('Business analysis error:', err.message);
    res.status(500).json({ message: err.message });
  }
};

const drawMetric = (doc, x, y, label, value, width = 125) => {
  doc
    .roundedRect(x, y, width, 58, 6)
    .fillAndStroke('#F8FAFC', '#E2E8F0');
  doc
    .fillColor('#64748B')
    .fontSize(8)
    .font('Helvetica')
    .text(label.toUpperCase(), x + 10, y + 10, { width: width - 20 });
  doc
    .fillColor('#0F172A')
    .fontSize(12)
    .font('Helvetica-Bold')
    .text(value, x + 10, y + 28, { width: width - 20 });
};

const drawSectionTitle = (doc, title, y) => {
  doc
    .fillColor('#0F172A')
    .font('Helvetica-Bold')
    .fontSize(13)
    .text(title, 42, y);
  doc
    .moveTo(42, y + 18)
    .lineTo(553, y + 18)
    .strokeColor('#E2E8F0')
    .stroke();
};

const ensureSpace = (doc, y, needed = 80) => {
  if (y + needed < 760) return y;
  doc.addPage();
  return 42;
};

const drawAccountingTable = (doc, y, data) => {
  const rows = [
    ['Total Revenue', data.summary.revenue],
    ['Review Discount Distributed', -data.discounts.total_discount],
    ['Cost of Goods Sold (HPP)', -data.summary.hpp],
    ['Gross Profit', data.summary.gross_profit],
    ['Average Order Value', data.summary.avg_order_value],
  ];

  doc
    .roundedRect(42, y, 511, 134, 6)
    .fillAndStroke('#FFFFFF', '#E2E8F0');

  doc
    .fillColor('#0F172A')
    .font('Helvetica-Bold')
    .fontSize(11)
    .text('Profit and Loss Summary', 58, y + 14);

  let rowY = y + 38;
  rows.forEach(([label, value], index) => {
    const isProfit = label === 'Gross Profit';
    if (index === 3) {
      doc.moveTo(58, rowY - 6).lineTo(537, rowY - 6).strokeColor('#CBD5E1').stroke();
    }

    doc
      .fillColor(isProfit ? '#0F172A' : '#475569')
      .font(isProfit ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(9)
      .text(label, 58, rowY, { width: 250 });
    doc
      .fillColor(value < 0 ? '#DC2626' : '#0F172A')
      .font(isProfit ? 'Helvetica-Bold' : 'Helvetica')
      .text(value < 0 ? `(${formatCurrency(Math.abs(value))})` : formatCurrency(value), 350, rowY, { width: 185, align: 'right' });
    rowY += 17;
  });

  doc
    .fillColor('#64748B')
    .font('Helvetica')
    .fontSize(8)
    .text(`Gross margin: ${data.summary.margin_pct}% · Review discount: ${formatCurrency(data.discounts.total_discount)} from ${data.discounts.total_orders} reviewed orders`, 58, y + 114);

  return y + 152;
};

const drawLineChart = (doc, title, rows, x, y, width, height) => {
  const chartTop = y + 28;
  const chartHeight = height - 48;
  const chartBottom = chartTop + chartHeight;
  const maxValue = Math.max(...rows.map((row) => Math.max(money(row.revenue), money(row.margin), 0)), 1);
  const stepX = rows.length > 1 ? width / (rows.length - 1) : width;

  const point = (row, index, key) => ({
    x: x + (rows.length > 1 ? index * stepX : width / 2),
    y: chartBottom - ((Math.max(0, money(row[key])) / maxValue) * chartHeight),
  });

  doc
    .roundedRect(x - 8, y, width + 16, height, 6)
    .fillAndStroke('#FFFFFF', '#E2E8F0');
  doc
    .fillColor('#0F172A')
    .font('Helvetica-Bold')
    .fontSize(10)
    .text(title, x, y + 10);

  for (let i = 0; i <= 3; i += 1) {
    const gy = chartTop + (chartHeight / 3) * i;
    doc.moveTo(x, gy).lineTo(x + width, gy).strokeColor('#E2E8F0').lineWidth(0.6).stroke();
  }

  const drawSeries = (key, color) => {
    rows.forEach((row, index) => {
      const p = point(row, index, key);
      if (index === 0) {
        doc.moveTo(p.x, p.y);
      } else {
        doc.lineTo(p.x, p.y);
      }
    });
    doc.strokeColor(color).lineWidth(1.8).stroke();

    rows.forEach((row, index) => {
      const p = point(row, index, key);
      doc.circle(p.x, p.y, 1.8).fillColor(color).fill();
    });
  };

  drawSeries('revenue', '#D97706');
  drawSeries('margin', '#16A34A');

  doc
    .fillColor('#D97706')
    .font('Helvetica')
    .fontSize(7)
    .text('Omzet', x, y + height - 15);
  doc
    .fillColor('#16A34A')
    .text('Margin', x + 45, y + height - 15);
  doc
    .fillColor('#64748B')
    .text(rows[0]?.label || '-', x + width - 90, y + height - 15, { width: 40, align: 'right' })
    .text(rows[rows.length - 1]?.label || '-', x + width - 45, y + height - 15, { width: 45, align: 'right' });
};

exports.businessAnalysisPdf = async (req, res) => {
  try {
    const data = await buildBusinessReportData(req.query);
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true });
    const filename = `business-report-${data.range.label.replace(/\s+/g, '-').toLowerCase()}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    doc
      .fillColor('#0F172A')
      .font('Helvetica-Bold')
      .fontSize(22)
      .text('Laporan Analisis Bisnis', 42, 42);
    doc
      .fillColor('#64748B')
      .font('Helvetica')
      .fontSize(10)
      .text(`Sultan Kebab POS - ${data.range.label}`, 42, 70)
      .text(`Dibuat: ${new Date(data.generated_at).toLocaleString('id-ID')}`, 42, 86);

    doc
      .roundedRect(410, 42, 143, 56, 8)
      .fillAndStroke('#111827', '#111827');
    doc
      .fillColor('#FACC15')
      .font('Helvetica-Bold')
      .fontSize(18)
      .text(`${data.summary.growth_pct >= 0 ? '+' : ''}${data.summary.growth_pct}%`, 426, 54, { width: 110, align: 'right' });
    doc
      .fillColor('#CBD5E1')
      .fontSize(8)
      .text('GROWTH VS PERIODE SEBELUMNYA', 426, 78, { width: 110, align: 'right' });

    let y = 125;
    drawMetric(doc, 42, y, 'Total Omzet', formatCurrency(data.summary.revenue), 96);
    drawMetric(doc, 145, y, 'Gross Profit', formatCurrency(data.summary.gross_profit), 96);
    drawMetric(doc, 248, y, 'Margin', `${data.summary.margin_pct}%`, 96);
    drawMetric(doc, 351, y, 'Transaksi', `${data.summary.total_trx} trx`, 96);
    drawMetric(doc, 454, y, 'Diskon Review', formatCurrency(data.discounts.total_discount), 99);

    y += 82;
    y = drawAccountingTable(doc, y, data);

    y = ensureSpace(doc, y, 390);
    drawSectionTitle(doc, 'Sales Performance Trend', y);
    y += 30;
    drawLineChart(doc, 'Last 7 Days - Revenue and Gross Profit', data.trends.last_7_days, 50, y, 495, 105);
    y += 126;
    y = ensureSpace(doc, y, 126);
    drawLineChart(doc, 'Last 30 Days - Revenue and Gross Profit', data.trends.last_30_days, 50, y, 495, 105);
    y += 126;
    y = ensureSpace(doc, y, 126);
    drawLineChart(doc, 'Last 12 Months - Revenue and Gross Profit', data.trends.last_12_months, 50, y, 495, 105);
    y += 130;

    y = ensureSpace(doc, y, 230);
    drawSectionTitle(doc, 'Executive Summary', y);
    y += 30;
    data.insights.slice(0, 7).forEach((insight, index) => {
      y = ensureSpace(doc, y, 58);
      const color = insight.severity === 'risk' ? '#DC2626' : insight.severity === 'warning' ? '#D97706' : insight.severity === 'good' ? '#16A34A' : '#2563EB';
      doc
        .fillColor(color)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(`${index + 1}. ${insight.title}`, 42, y);
      doc
        .fillColor('#334155')
        .font('Helvetica')
        .fontSize(9)
        .text(insight.text, 58, y + 15, { width: 480, lineGap: 2 });
      y += 48;
    });

    y = ensureSpace(doc, y + 8, 170);
    drawSectionTitle(doc, 'Produk Terlaris dan Kontribusi Margin', y);
    y += 28;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#475569');
    doc.text('Produk', 42, y).text('Terjual', 245, y, { width: 55, align: 'right' }).text('Omzet', 315, y, { width: 85, align: 'right' }).text('Margin', 430, y, { width: 70, align: 'right' });
    y += 14;
    data.best_products.slice(0, 8).forEach((item) => {
      y = ensureSpace(doc, y, 24);
      doc.font('Helvetica').fillColor('#0F172A').fontSize(8.5);
      doc.text(item.name || '-', 42, y, { width: 190 });
      doc.text(String(item.total_sold), 245, y, { width: 55, align: 'right' });
      doc.text(formatCurrency(item.revenue), 315, y, { width: 85, align: 'right' });
      doc.text(`${item.margin_pct}%`, 430, y, { width: 70, align: 'right' });
      y += 18;
    });

    y = ensureSpace(doc, y + 16, 150);
    drawSectionTitle(doc, 'Performa Kasir', y);
    y += 28;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#475569');
    doc.text('Kasir', 42, y).text('Transaksi', 255, y, { width: 70, align: 'right' }).text('Omzet', 360, y, { width: 105, align: 'right' }).text('AOV', 485, y, { width: 68, align: 'right' });
    y += 14;
    data.cashier_performance.slice(0, 8).forEach((item) => {
      y = ensureSpace(doc, y, 24);
      doc.font('Helvetica').fillColor('#0F172A').fontSize(8.5);
      doc.text(item.name || '-', 42, y, { width: 190 });
      doc.text(String(item.total_trx), 255, y, { width: 70, align: 'right' });
      doc.text(formatCurrency(item.revenue), 360, y, { width: 105, align: 'right' });
      doc.text(formatCurrency(item.avg_order_value), 485, y, { width: 68, align: 'right' });
      y += 18;
    });

    y = ensureSpace(doc, y + 16, 140);
    drawSectionTitle(doc, 'Risiko Stok dan Rekomendasi', y);
    y += 28;
    if (data.low_stock_items.length === 0) {
      doc.fillColor('#16A34A').font('Helvetica').fontSize(9).text('Tidak ada bahan baku yang berada di bawah minimum stok.', 42, y);
      y += 20;
    } else {
      data.low_stock_items.slice(0, 8).forEach((item) => {
        y = ensureSpace(doc, y, 22);
        doc.fillColor('#0F172A').font('Helvetica').fontSize(8.5)
          .text(`${item.name}: ${item.stock} ${item.unit || ''} (minimum ${item.min_stock})`, 42, y);
        y += 16;
      });
    }

    y = ensureSpace(doc, y + 18, 110);
    drawSectionTitle(doc, 'Catatan Evaluasi untuk Owner dan Investor', y);
    y += 28;
    const notes = [
      `Kesehatan bisnis saat ini terbaca dari omzet ${formatCurrency(data.summary.revenue)}, gross profit ${formatCurrency(data.summary.gross_profit)}, dan margin ${data.summary.margin_pct}%.`,
      'Fokus evaluasi berikutnya: menjaga produk margin tinggi tetap tersedia, mengurangi risiko stok kosong, dan memberi apresiasi pada kasir dengan performa terbaik.',
      'Untuk keputusan ekspansi, pantau tren growth, average order value, stabilitas margin, serta konsistensi performa karyawan lintas periode.',
    ];
    notes.forEach((note) => {
      y = ensureSpace(doc, y, 34);
      doc.fillColor('#334155').font('Helvetica').fontSize(9).text(`- ${note}`, 42, y, { width: 500, lineGap: 2 });
      y += 32;
    });

    const pageRange = doc.bufferedPageRange();
    const pageCount = pageRange.count;
    for (let i = pageRange.start; i < pageRange.start + pageRange.count; i += 1) {
      doc.switchToPage(i);
      doc
        .fillColor('#94A3B8')
        .font('Helvetica')
        .fontSize(8)
        .text(
          `Halaman ${i - pageRange.start + 1} dari ${pageCount}`,
          42,
          doc.page.height - doc.page.margins.bottom - 12,
          {
            align: 'center',
            width: doc.page.width - 84,
            lineBreak: false,
          },
        );
    }

    doc.end();
  } catch (err) {
    console.error('Business PDF error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ message: err.message });
    }
  }
};
