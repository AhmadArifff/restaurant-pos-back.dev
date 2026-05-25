/**
 * Controller untuk menyediakan data kepada AI untuk memberikan response yang lebih informatif
 * Endpoint ini menghubungkan user query dengan data real dari database
 */

const db = require('../config/db');

/**
 * GET /api/ai/data
 * Fetch data berdasarkan context dari user query
 * Query params: context (low-stock, sales, products, dll)
 */
exports.getDataByContext = async (req, res) => {
  try {
    const { context, days = 7, limit = 10 } = req.query;

    if (!context) {
      return res.status(400).json({
        success: false,
        message: 'Context parameter diperlukan (low-stock, sales, products, etc)',
      });
    }

    let data = null;

    try {
      switch (context.toLowerCase()) {
        case 'low-stock':
          data = await getLowStockItems();
          break;

        case 'stock-overview':
          data = await getStockOverview();
          break;

        case 'stock-movements':
          data = await getRecentStockMovements(limit);
          break;

        case 'stock-requests':
          data = await getStockRequestSummary(limit);
          break;

        case 'sales':
          data = await getSalesData(days);
          break;

        case 'staff-performance':
          data = await getStaffPerformanceSummary(req.query);
          break;

        case 'best-selling':
          data = await getBestSellingProducts(limit);
          break;

        case 'products':
          data = await getAllProducts();
          break;

        case 'transactions':
          data = await getRecentTransactions(limit);
          break;

        case 'attendance':
          data = await getTodayAttendance();
          break;

        default:
          return res.status(400).json({
            success: false,
            message: `Context '${context}' tidak dikenali`,
            validContexts: ['low-stock', 'stock-overview', 'stock-movements', 'stock-requests', 'sales', 'staff-performance', 'best-selling', 'products', 'transactions', 'attendance'],
          });
      }
    } catch (queryError) {
      console.error(`Query error for context '${context}':`, queryError);
      return res.json({
        success: true,
        context,
        data: { message: 'Data tidak tersedia saat ini', error: queryError.message },
        timestamp: new Date(),
      });
    }

    res.json({
      success: true,
      context,
      data: data || { message: 'No data found' },
      timestamp: new Date(),
    });
  } catch (error) {
    console.error('Error in getDataByContext:', error);
    res.status(500).json({
      success: false,
      message: '❌ Gagal mengambil data dari database',
      error: error.message,
    });
  }
};

/**
 * Get low stock items (stock <= min_stock)
 */
async function getLowStockItems() {
  const query = `
    SELECT 
      id, name, stock, unit, min_stock, total_price, price_per_unit,
      ROUND((stock / NULLIF(min_stock, 0)) * 100, 1) as stock_percentage,
      CASE 
        WHEN stock <= 0 THEN '🔴 HABIS'
        WHEN stock < min_stock / 2 THEN '🟠 SANGAT RENDAH'
        ELSE '🟡 PERLU DIPESAN'
      END as status
    FROM stock_items
    WHERE stock <= min_stock
    ORDER BY stock_percentage ASC
    LIMIT 20
  `;

  try {
    const [results] = await db.query(query);
    const items = results.map((item) => ({
      bahan: item.name,
      sisa: Number(item.stock || 0),
      satuan: item.unit,
      batas_minimum: Number(item.min_stock || 0),
      kondisi: item.status,
    }));

    return {
      ringkasan: results.length > 0
        ? `${results.length} bahan perlu perhatian karena stoknya berada di batas minimum atau lebih rendah.`
        : 'Tidak ada bahan yang berada di bawah batas minimum.',
      jumlah_bahan_perlu_perhatian: results.length,
      bahan: items,
    };
  } catch (error) {
    console.error('Query error getLowStockItems:', error);
    throw error;
  }
}

async function getStockOverview() {
  const query = `
    SELECT 
      name, stock, unit, min_stock, price_per_unit,
      (stock * COALESCE(price_per_unit, 0)) as total_value
    FROM stock_items
    ORDER BY stock DESC, name ASC
    LIMIT 100
  `;

  try {
    const [rows] = await db.query(query);
    const items = rows || [];
    const totalItems = items.length;
    const availableItems = items.filter((item) => Number(item.stock || 0) > 0);
    const emptyItems = items.filter((item) => Number(item.stock || 0) <= 0);
    const attentionItems = items.filter((item) => Number(item.stock || 0) <= Number(item.min_stock || 0));
    const totalValue = items.reduce((sum, item) => sum + Number(item.total_value || 0), 0);

    return {
      ringkasan: `${availableItems.length} dari ${totalItems} bahan masih memiliki sisa stok.`,
      total_bahan: totalItems,
      bahan_masih_tersedia: availableItems.length,
      bahan_habis: emptyItems.length,
      bahan_perlu_perhatian: attentionItems.length,
      estimasi_nilai_stok: Math.round(totalValue),
      stok_terbanyak: availableItems.slice(0, 10).map((item) => ({
        bahan: item.name,
        sisa: Number(item.stock || 0),
        satuan: item.unit,
        batas_minimum: Number(item.min_stock || 0),
      })),
      stok_habis: emptyItems.slice(0, 10).map((item) => ({
        bahan: item.name,
        sisa: Number(item.stock || 0),
        satuan: item.unit,
      })),
      stok_perlu_perhatian: attentionItems.slice(0, 10).map((item) => ({
        bahan: item.name,
        sisa: Number(item.stock || 0),
        satuan: item.unit,
        batas_minimum: Number(item.min_stock || 0),
      })),
    };
  } catch (error) {
    console.error('Query error getStockOverview:', error);
    throw error;
  }
}

async function getRecentStockMovements(limit = 10) {
  const safeLimit = Math.min(Number(limit) || 10, 25);
  const query = `
    SELECT
      ms.type, ms.source, ms.qty, ms.total_cost, ms.created_at,
      si.name as item_name, si.unit
    FROM main_stock ms
    JOIN stock_items si ON ms.stock_item_id = si.id
    ORDER BY ms.created_at DESC
    LIMIT ?
  `;

  try {
    const [rows] = await db.query(query, [safeLimit]);
    const movements = rows || [];
    const incoming = movements.filter((item) => item.type === 'in');
    const outgoing = movements.filter((item) => item.type === 'out');

    return {
      ringkasan: movements.length > 0
        ? `Ada ${incoming.length} catatan stok masuk dan ${outgoing.length} catatan stok keluar pada aktivitas terbaru.`
        : 'Belum ada aktivitas stok masuk atau keluar yang tercatat.',
      stok_masuk_terbaru: incoming.slice(0, 8).map((item) => ({
        bahan: item.item_name,
        jumlah: Number(item.qty || 0),
        satuan: item.unit,
        nilai: Math.round(Number(item.total_cost || 0)),
        waktu: item.created_at,
      })),
      stok_keluar_terbaru: outgoing.slice(0, 8).map((item) => ({
        bahan: item.item_name,
        jumlah: Number(item.qty || 0),
        satuan: item.unit,
        nilai: Math.round(Number(item.total_cost || 0)),
        waktu: item.created_at,
      })),
      aktivitas_terbaru: movements.slice(0, 10).map((item) => ({
        tipe: item.type === 'in' ? 'masuk' : 'keluar',
        bahan: item.item_name,
        jumlah: Number(item.qty || 0),
        satuan: item.unit,
        nilai: Math.round(Number(item.total_cost || 0)),
        waktu: item.created_at,
      })),
    };
  } catch (error) {
    console.error('Query error getRecentStockMovements:', error);
    throw error;
  }
}

async function getStockRequestSummary(limit = 20) {
  const safeLimit = Math.min(Number(limit) || 20, 50);
  const query = `
    SELECT
      sr.id, sr.status, sr.date, sr.created_at,
      u.name as cashier_name, u.role as cashier_role,
      si.name as item_name, si.unit,
      sri.qty_requested, sri.qty_approved
    FROM stock_requests sr
    JOIN users u ON sr.user_id = u.id
    JOIN stock_request_items sri ON sri.request_id = sr.id
    JOIN stock_items si ON sri.stock_item_id = si.id
    ORDER BY sr.created_at DESC
    LIMIT ?
  `;

  try {
    const [rows] = await db.query(query, [safeLimit]);
    const requests = rows || [];
    const approved = requests.filter((item) => item.status === 'approved' || Number(item.qty_approved || 0) > 0);
    const byCashier = new Map();

    for (const item of approved) {
      const key = item.cashier_name || 'Kasir';
      if (!byCashier.has(key)) {
        byCashier.set(key, {
          kasir: key,
          role: item.cashier_role || 'kasir',
          bahan: [],
        });
      }

      byCashier.get(key).bahan.push({
        bahan: item.item_name,
        diminta: Number(item.qty_requested || 0),
        disetujui: Number(item.qty_approved || item.qty_requested || 0),
        satuan: item.unit,
        status: item.status,
        tanggal: item.date || item.created_at,
      });
    }

    return {
      ringkasan: approved.length > 0
        ? `${byCashier.size} kasir memiliki pengajuan stok yang sudah disetujui/diambil pada data terbaru.`
        : 'Belum ada pengajuan stok kasir yang sudah disetujui/diambil pada data terbaru.',
      jumlah_kasir_dengan_pengajuan_disetujui: byCashier.size,
      kasir_dan_bahan: Array.from(byCashier.values()),
      pengajuan_terbaru: requests.slice(0, 10).map((item) => ({
        kasir: item.cashier_name,
        role: item.cashier_role,
        bahan: item.item_name,
        diminta: Number(item.qty_requested || 0),
        disetujui: item.qty_approved === null ? null : Number(item.qty_approved || 0),
        satuan: item.unit,
        status: item.status,
        tanggal: item.date || item.created_at,
      })),
    };
  } catch (error) {
    console.error('Query error getStockRequestSummary:', error);
    throw error;
  }
}

async function buildHPPMap(productIds) {
  const uniqueIds = [...new Set(productIds.map(Number).filter(Boolean))];
  if (uniqueIds.length === 0) return {};

  const placeholders = uniqueIds.map(() => '?').join(',');
  const [ingredients] = await db.query(`
    SELECT
      pi.product_id,
      CAST(pi.qty AS DECIMAL(10,4)) AS qty,
      si.price_per_unit
    FROM product_ingredients pi
    JOIN stock_items si ON pi.stock_item_id = si.id
    WHERE pi.product_id IN (${placeholders})
  `, uniqueIds);

  return (ingredients || []).reduce((map, item) => {
    const productId = Number(item.product_id);
    map[productId] = (map[productId] || 0) + (Number(item.price_per_unit || 0) * Number(item.qty || 0));
    return map;
  }, {});
}

async function getStaffPerformanceSummary({ month, year } = {}) {
  const now = new Date();
  const safeYear = Number(year || now.getFullYear());
  const safeMonth = Number(month || now.getMonth() + 1);

  const [userRows] = await db.query(`
    SELECT
      u.id AS user_id,
      u.name,
      u.role,
      COUNT(DISTINCT t.id) AS total_trx,
      COALESCE(SUM(t.total_price), 0) AS total_revenue
    FROM transactions t
    JOIN users u ON t.created_by = u.id
    WHERE YEAR(t.created_at) = ? AND MONTH(t.created_at) = ?
    GROUP BY u.id, u.name, u.role
    ORDER BY total_revenue DESC, total_trx DESC, u.name ASC
  `, [safeYear, safeMonth]);

  const [productRows] = await db.query(`
    SELECT
      u.id AS user_id,
      u.name AS user_name,
      u.role,
      p.id AS product_id,
      p.name AS product_name,
      SUM(ti.qty) AS total_qty,
      COALESCE(SUM(COALESCE(ti.subtotal, ti.qty * ti.price)), 0) AS total_revenue
    FROM transaction_items ti
    JOIN transactions t ON ti.transaction_id = t.id
    JOIN users u ON t.created_by = u.id
    JOIN products p ON ti.product_id = p.id
    WHERE YEAR(t.created_at) = ? AND MONTH(t.created_at) = ?
    GROUP BY u.id, u.name, u.role, p.id, p.name
    ORDER BY total_revenue DESC, total_qty DESC, u.name ASC, p.name ASC
  `, [safeYear, safeMonth]);

  const hppMap = await buildHPPMap((productRows || []).map((item) => item.product_id));
  const users = new Map();

  for (const row of userRows || []) {
    users.set(Number(row.user_id), {
      user_id: Number(row.user_id),
      nama: row.name,
      role: row.role,
      transaksi: Number(row.total_trx || 0),
      omzet: Math.round(Number(row.total_revenue || 0)),
      hpp: 0,
      margin: 0,
      margin_persen: 0,
      produk: [],
    });
  }

  for (const row of productRows || []) {
    const userId = Number(row.user_id);
    const qty = Number(row.total_qty || 0);
    const omzet = Math.round(Number(row.total_revenue || 0));
    const hpp = Math.round((hppMap[Number(row.product_id)] || 0) * qty);
    const margin = Math.round(omzet - hpp);

    if (!users.has(userId)) {
      users.set(userId, {
        user_id: userId,
        nama: row.user_name,
        role: row.role,
        transaksi: 0,
        omzet: 0,
        hpp: 0,
        margin: 0,
        margin_persen: 0,
        produk: [],
      });
    }

    const user = users.get(userId);
    user.hpp += hpp;
    user.margin += margin;
    user.produk.push({
      produk: row.product_name,
      qty,
      omzet,
      hpp,
      margin,
      margin_persen: omzet > 0 ? Math.round((margin / omzet) * 100) : 0,
    });
  }

  const perUser = Array.from(users.values()).map((user) => ({
    ...user,
    hpp: Math.round(user.hpp),
    margin: Math.round(user.margin),
    margin_persen: user.omzet > 0 ? Math.round((user.margin / user.omzet) * 100) : 0,
  }));

  const productTotals = new Map();
  for (const user of perUser) {
    for (const product of user.produk) {
      if (!productTotals.has(product.produk)) {
        productTotals.set(product.produk, {
          produk: product.produk,
          qty: 0,
          omzet: 0,
          hpp: 0,
          margin: 0,
        });
      }
      const total = productTotals.get(product.produk);
      total.qty += product.qty;
      total.omzet += product.omzet;
      total.hpp += product.hpp;
      total.margin += product.margin;
    }
  }

  const perProduct = Array.from(productTotals.values()).map((product) => ({
    ...product,
    qty: Number(product.qty),
    omzet: Math.round(product.omzet),
    hpp: Math.round(product.hpp),
    margin: Math.round(product.margin),
    margin_persen: product.omzet > 0 ? Math.round((product.margin / product.omzet) * 100) : 0,
  }));

  const totalRevenue = perUser.reduce((sum, user) => sum + user.omzet, 0);
  const totalTransactions = perUser.reduce((sum, user) => sum + user.transaksi, 0);
  const totalHpp = perUser.reduce((sum, user) => sum + user.hpp, 0);
  const totalMargin = perUser.reduce((sum, user) => sum + user.margin, 0);

  return {
    periode: `${String(safeMonth).padStart(2, '0')}/${safeYear}`,
    definisi: 'Omzet adalah total nilai transaksi produk. Margin adalah omzet dikurangi estimasi HPP bahan/resep produk.',
    total_transaksi: totalTransactions,
    total_omzet: Math.round(totalRevenue),
    total_hpp: Math.round(totalHpp),
    total_margin: Math.round(totalMargin),
    margin_persen: totalRevenue > 0 ? Math.round((totalMargin / totalRevenue) * 100) : 0,
    per_user: perUser,
    per_produk: perProduct.sort((a, b) => b.omzet - a.omzet),
  };
}

/**
 * Get sales data for last N days
 */
async function getSalesData(days = 7) {
  const query = `
    SELECT 
      DATE(t.created_at) as date,
      COUNT(DISTINCT t.id) as transaction_count,
      COALESCE(SUM(t.total_price), 0) as total_sales,
      COALESCE(AVG(t.total_price), 0) as avg_transaction,
      COALESCE(MIN(t.total_price), 0) as min_transaction,
      COALESCE(MAX(t.total_price), 0) as max_transaction
    FROM transactions t
    WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
    GROUP BY DATE(t.created_at)
    ORDER BY date DESC
  `;

  try {
    const [results] = await db.query(query, [days]);
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayRow = results.find((row) => {
      const rowDate = row.date instanceof Date
        ? row.date.toISOString().slice(0, 10)
        : String(row.date).slice(0, 10);
      return rowDate === todayKey;
    });
    const todaySales = Math.round(Number(todayRow?.total_sales || 0));
    const todayTransactions = Number(todayRow?.transaction_count || 0);
    
    if (results.length === 0) {
      return {
        periode: `${days} hari terakhir`,
        'tanggal hari ini': todayKey,
        'omzet hari ini': 0,
        'transaksi hari ini': 0,
        'ringkasan hari ini': `Belum ada penjualan yang tercatat untuk hari ini (${todayKey}).`,
        'ringkasan periode': 'Belum ada penjualan yang tercatat pada periode ini.',
        'total omzet periode': 0,
        'jumlah transaksi periode': 0,
        'rata-rata omzet harian': 0,
        'performa harian': [],
      };
    }

    const totalSales = results.reduce((sum, row) => sum + (row.total_sales || 0), 0);
    const totalTransactions = results.reduce((sum, row) => sum + (row.transaction_count || 0), 0);

    return {
      periode: `${days} hari terakhir`,
      'tanggal hari ini': todayKey,
      'omzet hari ini': todaySales,
      'transaksi hari ini': todayTransactions,
      'ringkasan hari ini': todayTransactions > 0
        ? `Omzet hari ini (${todayKey}) sebesar Rp ${todaySales.toLocaleString('id-ID')} dari ${todayTransactions} transaksi.`
        : `Belum ada penjualan yang tercatat untuk hari ini (${todayKey}).`,
      'ringkasan periode': `Omzet ${days} hari terakhir sebesar Rp ${Math.round(totalSales).toLocaleString('id-ID')} dari ${totalTransactions} transaksi.`,
      'total omzet periode': Math.round(totalSales),
      'jumlah transaksi periode': totalTransactions,
      'rata-rata omzet harian': Math.round(totalSales / results.length),
      'performa harian': results.map((row) => ({
        tanggal: row.date,
        omzet: Math.round(Number(row.total_sales || 0)),
        transaksi: Number(row.transaction_count || 0),
        'rata-rata per transaksi': Math.round(Number(row.avg_transaction || 0)),
      })),
    };
  } catch (error) {
    console.error('Query error getSalesData:', error);
    throw error;
  }
}

/**
 * Get best selling products
 */
async function getBestSellingProducts(limit = 10) {
  const query = `
    SELECT 
      p.id, p.name, COALESCE(c.name, 'Uncategorized') as category, p.price,
      COUNT(ti.id) as total_sold,
      SUM(ti.qty) as total_quantity,
      SUM(ti.qty * ti.price) as revenue
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN transaction_items ti ON p.id = ti.product_id
    LEFT JOIN transactions t ON ti.transaction_id = t.id
    WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) OR t.id IS NULL
    GROUP BY p.id, p.name, c.name, p.price
    ORDER BY total_sold DESC
    LIMIT ?
  `;

  try {
    const [results] = await db.query(query, [limit]);
    return {
      periode: '30 hari terakhir',
      produk_terlaris: (results || []).map((item) => ({
        produk: item.name,
        kategori: item.category,
        harga_jual: Number(item.price || 0),
        jumlah_terjual: Number(item.total_quantity || 0),
        omzet: Math.round(Number(item.revenue || 0)),
      })),
      jumlah_produk_ditampilkan: (results || []).length,
    };
  } catch (error) {
    console.error('Query error getBestSellingProducts:', error);
    throw error;
  }
}

/**
 * Get all products with stock info
 */
async function getAllProducts() {
  const query = `
    SELECT 
      p.id, p.name, COALESCE(c.name, 'Uncategorized') as category, p.price,
      COALESCE(s.stock, 0) as stock,
      COALESCE(s.min_stock, 0) as min_stock,
      COALESCE(s.unit, '-') as unit
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN stock_items s ON p.name = s.name
    ORDER BY c.name, p.name
    LIMIT 50
  `;

  try {
    const [results] = await db.query(query);
    return {
      jumlah_produk: (results || []).length,
      produk: (results || []).map((item) => ({
        produk: item.name,
        kategori: item.category,
        harga_jual: Number(item.price || 0),
        sisa_stok_terkait: Number(item.stock || 0),
        satuan: item.unit,
        batas_minimum: Number(item.min_stock || 0),
      })),
    };
  } catch (error) {
    console.error('Query error getAllProducts:', error);
    throw error;
  }
}

/**
 * Get recent transactions
 */
async function getRecentTransactions(limit = 10) {
  const query = `
    SELECT 
      t.id, t.total_price, t.payment_method, t.created_at,
      COUNT(ti.id) as item_count
    FROM transactions t
    LEFT JOIN transaction_items ti ON t.id = ti.transaction_id
    GROUP BY t.id, t.total_price, t.payment_method, t.created_at
    ORDER BY t.created_at DESC
    LIMIT ?
  `;

  try {
    const [results] = await db.query(query, [limit]);
    
    if (!results || results.length === 0) {
      return {
        ringkasan: 'Belum ada transaksi terbaru yang tercatat.',
        transaksi_terbaru: [],
        jumlah_transaksi: 0,
        total_omzet_dari_transaksi_terbaru: 0,
      };
    }

    const totalAmount = results.reduce((sum, t) => sum + (t.total_price || 0), 0);

    return {
      ringkasan: `${results.length} transaksi terbaru memiliki total omzet Rp ${Math.round(totalAmount).toLocaleString('id-ID')}.`,
      transaksi_terbaru: results.map((item) => ({
        waktu: item.created_at,
        total_belanja: Math.round(Number(item.total_price || 0)),
        metode_bayar: item.payment_method,
        jumlah_item: Number(item.item_count || 0),
      })),
      jumlah_transaksi: results.length,
      total_omzet_dari_transaksi_terbaru: Math.round(totalAmount),
    };
  } catch (error) {
    console.error('Query error getRecentTransactions:', error);
    throw error;
  }
}

/**
 * Get today's attendance
 */
async function getTodayAttendance() {
  const query = `
    SELECT 
      u.id, u.name,
      a.login_at, a.logout_at,
      CASE WHEN a.login_at IS NOT NULL THEN 'hadir' ELSE 'belum absen' END as status
    FROM users u
    LEFT JOIN attendance a ON u.id = a.user_id AND DATE(a.date) = CURDATE()
    WHERE u.role IN ('admin', 'kasir')
    ORDER BY u.name
  `;

  try {
    const [results] = await db.query(query);
    
    if (!results || results.length === 0) {
      return {
        tanggal: new Date().toLocaleDateString('id-ID'),
        ringkasan: 'Belum ada data kehadiran tim hari ini.',
        total_staff: 0,
        hadir: 0,
        belum_absen: 0,
        daftar_kehadiran: [],
      };
    }

    const present = results.filter(r => r.login_at).length;
    const absent = results.length - present;

    return {
      tanggal: new Date().toLocaleDateString('id-ID'),
      ringkasan: `${present} dari ${results.length} staff sudah absen hari ini.`,
      total_staff: results.length,
      hadir: present,
      belum_absen: absent,
      daftar_kehadiran: results.map((item) => ({
        nama: item.name,
        jam_masuk: item.login_at,
        jam_keluar: item.logout_at,
        status: item.status || (item.login_at ? 'hadir' : 'belum absen'),
      })),
    };
  } catch (error) {
    console.error('Query error getTodayAttendance:', error);
    throw error;
  }
}
