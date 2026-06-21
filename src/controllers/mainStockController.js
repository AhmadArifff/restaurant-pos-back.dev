const db = require('../config/db');
const { getRequestBranchId } = require('../utils/branchContext');
const {
  mergeNotes,
  normalizeRequestItems,
} = require('../utils/stockRequestMerge');

const jakartaDateExpr = (column) =>
  db.isPostgres
    ? `CAST(${column} AT TIME ZONE 'Asia/Jakarta' AS DATE)`
    : `DATE(${column})`;

// ── Summary stok master (saldo saat ini per bahan) ────────────
exports.getSummary = async (req, res) => {
  try {
    const requestedBranchId = getRequestBranchId(req);
    const branchId = requestedBranchId === 'all' ? null : (requestedBranchId || req.user.branch_id || null);
    const branchJoin = branchId ? 'AND ms.branch_id = ?' : '';
    const latestBranchWhere = branchId ? 'AND ms2.branch_id = ?' : '';
    const params = branchId ? [branchId, branchId] : [];
    const [rows] = await db.query(`
      SELECT
        si.id, si.name, si.unit, si.min_stock,
        si.price_per_unit,
        COALESCE(SUM(CASE WHEN ms.type='in'  THEN ms.qty       ELSE 0 END), 0) AS total_in,
        COALESCE(SUM(CASE WHEN ms.type='out' THEN ms.qty       ELSE 0 END), 0) AS total_out,
        COALESCE(SUM(CASE WHEN ms.type='in'  THEN ms.qty       ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN ms.type='out' THEN ms.qty       ELSE 0 END), 0) AS current_stock,
        COALESCE(SUM(CASE WHEN ms.type='in'  THEN ms.total_cost ELSE 0 END), 0) AS total_cost_in,
        COALESCE(SUM(CASE WHEN ms.type='out' THEN ms.total_cost ELSE 0 END), 0) AS total_cost_out,
        -- Harga per unit dari pembelian terakhir
        (SELECT ms2.cost_per_unit FROM main_stock ms2
         WHERE ms2.stock_item_id = si.id AND ms2.type = 'in' ${latestBranchWhere}
         ORDER BY ms2.created_at DESC LIMIT 1) AS latest_cost_per_unit
      FROM stock_items si
      LEFT JOIN main_stock ms ON ms.stock_item_id = si.id ${branchJoin}
      GROUP BY si.id, si.name, si.unit, si.min_stock, si.price_per_unit
      ORDER BY si.name ASC
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

exports.getMonthly = async (req, res) => {
  try {
    const { month, year, date_from, date_to } = req.query;
    const requestedBranchId = getRequestBranchId(req);
    const branchId = requestedBranchId === 'all' ? null : (requestedBranchId || req.user.branch_id || null);
    const y = Number(year  || new Date().getFullYear());
    const m = Number(month || new Date().getMonth() + 1);
    const params = [];
    const branchWhere = branchId ? 'AND ms.branch_id = ?' : '';
    const dateExpr = jakartaDateExpr('ms.created_at');
    const dateWhere = (date_from || date_to)
      ? `AND ${dateExpr} BETWEEN ? AND ?`
      : db.isPostgres
        ? `AND EXTRACT(YEAR FROM ms.created_at AT TIME ZONE 'Asia/Jakarta') = ? AND EXTRACT(MONTH FROM ms.created_at AT TIME ZONE 'Asia/Jakarta') = ?`
        : `AND YEAR(ms.created_at) = ? AND MONTH(ms.created_at) = ?`;

    if (date_from || date_to) {
      const from = date_from || date_to;
      const to = date_to || date_from;
      params.push(from, to);
    } else {
      params.push(y, m);
    }
    if (branchId) params.push(branchId);

    const [rows] = await db.query(`
      SELECT
        ms.id, ms.type, ms.source, ms.qty, ms.cost_per_unit,
        ms.total_cost, ms.note, ms.created_at,
        si.name AS item_name, si.unit,
        u.name  AS created_by_name
      FROM main_stock ms
      JOIN stock_items si ON ms.stock_item_id = si.id
      JOIN users u         ON ms.created_by = u.id
      WHERE 1=1
        ${dateWhere}
        ${branchWhere}
      ORDER BY ms.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

exports.getPriceTrends = async (req, res) => {
  try {
    const year = Number(req.query.year || new Date().getFullYear());

    const [rows] = await db.query(`
      SELECT
        si.id,
        si.name,
        si.unit,
        COALESCE((
          SELECT ms.cost_per_unit
          FROM main_stock ms
          WHERE ms.stock_item_id = si.id
            AND ms.type = 'in'
            AND YEAR(ms.created_at) = ?
          ORDER BY ms.created_at ASC, ms.id ASC
          LIMIT 1
        ), 0) AS year_first_price,
        COALESCE((
          SELECT ms.cost_per_unit
          FROM main_stock ms
          WHERE ms.stock_item_id = si.id
            AND ms.type = 'in'
            AND YEAR(ms.created_at) = ?
          ORDER BY ms.created_at DESC, ms.id DESC
          LIMIT 1
        ), 0) AS year_last_price,
        COALESCE((
          SELECT ms.cost_per_unit
          FROM main_stock ms
          WHERE ms.stock_item_id = si.id
            AND ms.type = 'in'
          ORDER BY ms.created_at ASC, ms.id ASC
          LIMIT 1
        ), 0) AS all_first_price,
        COALESCE((
          SELECT ms.cost_per_unit
          FROM main_stock ms
          WHERE ms.stock_item_id = si.id
            AND ms.type = 'in'
          ORDER BY ms.created_at DESC, ms.id DESC
          LIMIT 1
        ), 0) AS all_last_price,
        COALESCE((
          SELECT COUNT(*)
          FROM main_stock ms
          WHERE ms.stock_item_id = si.id
            AND ms.type = 'in'
            AND YEAR(ms.created_at) = ?
        ), 0) AS year_purchase_count,
        COALESCE((
          SELECT COUNT(*)
          FROM main_stock ms
          WHERE ms.stock_item_id = si.id
            AND ms.type = 'in'
        ), 0) AS all_purchase_count
      FROM stock_items si
      ORDER BY si.name ASC
    `, [year, year, year]);

    const withPercent = rows.map((row) => {
      const yearFirst = Number(row.year_first_price || 0);
      const yearLast = Number(row.year_last_price || 0);
      const allFirst = Number(row.all_first_price || 0);
      const allLast = Number(row.all_last_price || 0);

      return {
        ...row,
        year,
        year_change_percent: yearFirst > 0 ? Number((((yearLast - yearFirst) / yearFirst) * 100).toFixed(2)) : 0,
        all_change_percent: allFirst > 0 ? Number((((allLast - allFirst) / allFirst) * 100).toFixed(2)) : 0,
      };
    });

    res.json(withPercent);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Rekap harian pengeluaran ──────────────────────────────────
// exports.getDaily = async (req, res) => {
//   try {
//     const { date } = req.query;
//     const d = date || new Date().toISOString().split('T')[0];

//     const [rows] = await db.query(`
//       SELECT
//         ms.id, ms.type, ms.source, ms.qty, ms.cost_per_unit,
//         ms.total_cost, ms.note, ms.created_at,
//         si.name AS item_name, si.unit,
//         u.name  AS created_by_name
//       FROM main_stock ms
//       JOIN stock_items si ON ms.stock_item_id = si.id
//       JOIN users u         ON ms.created_by = u.id
//       WHERE DATE(ms.created_at) = ? AND ms.type = 'out'
//       ORDER BY ms.created_at DESC
//     `, [d]);
//     res.json(rows);
//   } catch (err) { res.status(500).json({ message: err.message }); }
// };

// exports.getDaily = async (req, res) => {
//   try {
//     const { date_from, date_to } = req.query;
//     const from = date_from || new Date().toISOString().split('T')[0];
//     const to   = date_to   || from;

//     const [rows] = await db.query(`
//       SELECT
//         ms.*,
//         si.name  AS item_name,
//         si.unit,
//         u.name   AS created_by_name,
//         -- Cari user target dari stock_requests jika source=request atau adjustment
//         COALESCE(
//           (SELECT ru.name FROM stock_requests sr
//            JOIN users ru ON sr.user_id = ru.id
//            WHERE sr.id = ms.reference_id LIMIT 1),
//           u.name
//         ) AS target_user_name,
//         COALESCE(
//           (SELECT sra.name FROM stock_requests sr
//            JOIN users sra ON sr.created_by_admin = sra.id
//            WHERE sr.id = ms.reference_id AND sr.created_by_admin IS NOT NULL LIMIT 1),
//           NULL
//         ) AS admin_name
//       FROM main_stock ms
//       JOIN stock_items si ON ms.stock_item_id = si.id
//       JOIN users u         ON ms.created_by = u.id
//       WHERE ms.type = 'out' AND DATE(ms.created_at) BETWEEN ? AND ?
//       ORDER BY ms.created_at DESC
//     `, [from, to]);
//     res.json(rows);
//   } catch (err) { res.status(500).json({ message: err.message }); }
// };

// Di getDaily controller, tambah filter user_id opsional
// exports.getDaily = async (req, res) => {
//   try {
//     const { date_from, date_to, user_id } = req.query;
//     const from = date_from || new Date().toISOString().split('T')[0];
//     const to   = date_to   || from;

//     // Untuk filter kasir: filter berdasarkan user_id di stock_requests
//     const userJoinCondition = user_id
//       ? `AND (
//           sr.user_id = ${Number(user_id)}
//           OR (sr.id IS NULL AND ms.created_by = ${Number(user_id)})
//          )`
//       : '';

//     const [rows] = await db.query(`
//       SELECT
//         ms.id,
//         ms.qty,
//         ms.cost_per_unit,
//         ms.total_cost,
//         ms.note,
//         ms.created_at,
//         'out'      AS type,
//         'approved' AS request_status,
//         si.name    AS item_name,
//         si.unit,
//         approver.name     AS approver_name,
//         COALESCE(kasir_u.name, creator.name) AS target_user_name,
//         CASE
//           WHEN sr.created_by_admin IS NOT NULL THEN admin_creator.name
//           ELSE NULL
//         END AS admin_name
//       FROM main_stock ms
//       JOIN stock_items si         ON ms.stock_item_id = si.id
//       JOIN users creator          ON ms.created_by = creator.id
//       LEFT JOIN stock_requests sr ON sr.id = ms.reference_id
//                                   AND ms.source = 'request'
//       LEFT JOIN users kasir_u     ON sr.user_id = kasir_u.id
//       LEFT JOIN users admin_creator ON sr.created_by_admin = admin_creator.id
//       LEFT JOIN users approver    ON sr.approved_by = approver.id
//       WHERE ms.type = 'out'
//         AND DATE(ms.created_at) BETWEEN ? AND ?
//         ${userJoinCondition}
//       ORDER BY ms.created_at DESC
//     `, [from, to]);

//     // Pending & rejected (hanya untuk admin view — user_id kosong)
//     let pendingRows = [];
//     if (!user_id) {
//       const [pending] = await db.query(`
//         SELECT
//           sri.id,
//           sri.qty_requested AS qty,
//           sri.cost_per_unit,
//           (sri.qty_requested * sri.cost_per_unit) AS total_cost,
//           sr.note,
//           sr.created_at,
//           'pending_out' AS type,
//           sr.status     AS request_status,
//           si.name       AS item_name,
//           si.unit,
//           approver.name       AS approver_name,
//           kasir_u.name        AS target_user_name,
//           CASE
//             WHEN sr.created_by_admin IS NOT NULL THEN admin_creator.name
//             ELSE NULL
//           END AS admin_name
//         FROM stock_requests sr
//         JOIN stock_request_items sri   ON sri.request_id = sr.id
//         JOIN stock_items si            ON sri.stock_item_id = si.id
//         JOIN users kasir_u             ON sr.user_id = kasir_u.id
//         LEFT JOIN users admin_creator  ON sr.created_by_admin = admin_creator.id
//         LEFT JOIN users approver       ON sr.approved_by = approver.id
//         WHERE sr.status IN ('pending', 'rejected')
//           AND DATE(sr.created_at) BETWEEN ? AND ?
//         ORDER BY sr.created_at DESC
//       `, [from, to]);
//       pendingRows = pending;
//     }

//     res.json([...rows, ...pendingRows]);
//   } catch (err) { res.status(500).json({ message: err.message }); }
// };

// Di mainstockcontroller.js — getDaily yang diperluas
// ── Di mainstockcontroller.js — getDaily yang diperluas ──
exports.getDaily = async (req, res) => {
  try {
    const { date_from, date_to, user_id, type_filter } = req.query;
    const requestedBranchId = getRequestBranchId(req);
    const branchId = requestedBranchId === 'all' ? null : (requestedBranchId || req.user.branch_id || null);
    const from = date_from || new Date().toISOString().split('T')[0];
    const to   = date_to   || from;
    const uid  = user_id ? Number(user_id) : null;
    const msDate = jakartaDateExpr('ms.created_at');
    const srDate = jakartaDateExpr('sr.created_at');
    const txDate = jakartaDateExpr('t.created_at');

    const results = [];

    // ── 1. Pengeluaran approved dari main_stock ──────────────────────────
    // if (!type_filter || ['all', 'approved', 'manual'].includes(type_filter)) {
    //   let userCond     = '';
    //   let manualCond   = '';

    //   if (uid) {
    //     userCond = `AND (sr.user_id = ${uid} OR (sr.id IS NULL AND ms.created_by = ${uid}))`;
    //   }
    //   if (type_filter === 'manual') {
    //     manualCond = `AND ms.source = 'request'`;
    //   }

    //   const [rows] = await db.query(`
    //     SELECT
    //       ms.id,
    //       ms.qty,
    //       ms.cost_per_unit,
    //       ms.total_cost,
    //       ms.note,
    //       ms.created_at,
    //       'approved'  AS request_status,
    //       'out'       AS type,
    //       si.name     AS item_name,
    //       si.unit,
    //       creator.name                                             AS created_by_name,
    //       approver.name                                            AS approver_name,
    //       COALESCE(kasir_u.name, creator.name)                    AS target_user_name,
    //       CASE WHEN sr.created_by_admin IS NOT NULL
    //            THEN admin_c.name ELSE NULL END                    AS admin_name,
    //       COALESCE(kasir_u.name, creator.name)                    AS stock_owner_name
    //     FROM main_stock ms
    //     JOIN  stock_items si         ON ms.stock_item_id = si.id
    //     JOIN  users creator          ON ms.created_by    = creator.id
    //     LEFT JOIN stock_requests  sr ON sr.id = ms.reference_id AND ms.source = 'request'
    //     LEFT JOIN users kasir_u      ON sr.user_id          = kasir_u.id
    //     LEFT JOIN users admin_c      ON sr.created_by_admin = admin_c.id
    //     LEFT JOIN users approver     ON sr.approved_by      = approver.id
    //     WHERE ms.type = 'out'
    //       AND DATE(ms.created_at) BETWEEN ? AND ?
    //       ${manualCond}
    //       ${userCond}
    //     ORDER BY ms.created_at DESC
    //   `, [from, to]);

    //   results.push(...rows);
    // }

    
    // ── 1. Pengeluaran approved dari main_stock ──────────────────────────
if (!type_filter || ['all', 'approved', 'manual'].includes(type_filter)) {
  let userCond   = '';
  let manualCond = '';

  if (uid) {
    userCond = `AND (
      sr.user_id = ${uid}
      OR (ms.source = 'transaction' AND COALESCE(tx.source_user_id, tx.created_by) = ${uid})
      OR (ms.source NOT IN ('request','transaction') AND ms.created_by = ${uid})
    )`;
  }
  if (type_filter === 'manual') {
    manualCond = `AND ms.source = 'request'`;
  }
  const branchMainWhere = branchId ? 'AND ms.branch_id = ?' : '';
  const mainParams = [from, to];
  if (branchId) mainParams.push(branchId);

  const [rows] = await db.query(`
    SELECT
      ms.id,
      ms.qty,
      ms.cost_per_unit,
      ms.total_cost,
      ms.note,
      ms.created_at,
      b.name       AS branch_name,
      'approved'  AS request_status,
      'out'       AS type,
      si.name     AS item_name,
      si.unit,
      creator.name  AS created_by_name,
      approver.name AS approver_name,

      -- Sumber Stok: siapa pemilik stok yang dipakai
      -- Jika dari transaksi POS → pakai source_user_id transaksi (kasir pemilik stok)
      -- Jika dari request → pakai user kasir di stock_requests
      -- Fallback → creator (yang catat di main_stock)
      CASE
        WHEN ms.source = 'transaction'
          THEN COALESCE(tx_kasir_src.name, tx_kasir.name)
        WHEN ms.source = 'request'
          THEN kasir_u.name
        ELSE creator.name
      END AS stock_owner_name,

      CASE
        WHEN ms.source = 'transaction'
          THEN COALESCE(tx_kasir_src.name, tx_kasir.name)
        WHEN ms.source = 'request'
          THEN kasir_u.name
        ELSE creator.name
      END AS target_user_name,

      -- Admin name: hanya jika yang catat berbeda dari pemilik stok
      CASE
        WHEN ms.source = 'transaction'
          AND tx.source_user_id IS NOT NULL
          AND tx.created_by != tx.source_user_id
          THEN creator.name
        WHEN ms.source = 'request'
          AND sr.created_by_admin IS NOT NULL
          THEN admin_c.name
        ELSE NULL
      END AS admin_name

    FROM main_stock ms
    JOIN  stock_items si         ON ms.stock_item_id = si.id
    JOIN  users creator          ON ms.created_by    = creator.id
    LEFT JOIN branches b         ON b.id             = ms.branch_id

    -- Join ke transactions jika source = transaction
    LEFT JOIN transactions tx         ON tx.id = ms.reference_id AND ms.source = 'transaction'
    LEFT JOIN users tx_kasir          ON tx_kasir.id  = tx.created_by
    LEFT JOIN users tx_kasir_src      ON tx_kasir_src.id = tx.source_user_id

    -- Join ke stock_requests jika source = request
    LEFT JOIN stock_requests  sr ON sr.id = ms.reference_id AND ms.source = 'request'
    LEFT JOIN users kasir_u      ON kasir_u.id = sr.user_id
    LEFT JOIN users admin_c      ON admin_c.id = sr.created_by_admin
    LEFT JOIN users approver     ON approver.id = sr.approved_by

    WHERE ms.type = 'out'
      AND ${msDate} BETWEEN ? AND ?
      ${branchMainWhere}
      ${manualCond}
      ${userCond}
    ORDER BY ms.created_at DESC
  `, mainParams);

  results.push(...rows);
}

    // ── 2. Pengajuan pending & rejected ──────────────────────────────────
    if (!type_filter || ['all', 'pending', 'rejected'].includes(type_filter)) {
      const userReqCond = uid ? `AND sr.user_id = ${uid}` : '';
      const statusCond  =
        type_filter === 'pending'  ? `AND sr.status = 'pending'`  :
        type_filter === 'rejected' ? `AND sr.status = 'rejected'` :
                                     `AND sr.status IN ('pending','rejected')`;
      const branchRequestWhere = branchId ? 'AND sr.branch_id = ?' : '';
      const requestParams = [from, to];
      if (branchId) requestParams.push(branchId);

      const [rows] = await db.query(`
        SELECT
          sri.id,
          sri.qty_requested                               AS qty,
          sri.cost_per_unit,
          (sri.qty_requested * sri.cost_per_unit)         AS total_cost,
          sr.note,
          sr.created_at,
          b_req.name                                      AS branch_name,
          sr.status                                       AS request_status,
          'pending_out'                                   AS type,
          si.name                                         AS item_name,
          si.unit,
          kasir_u.name                                    AS created_by_name,
          approver.name                                   AS approver_name,
          kasir_u.name                                    AS target_user_name,
          CASE WHEN sr.created_by_admin IS NOT NULL
               THEN admin_c.name ELSE NULL END            AS admin_name
        FROM stock_requests sr
        JOIN  stock_request_items sri ON sri.request_id    = sr.id
        JOIN  stock_items si          ON sri.stock_item_id = si.id
        JOIN  users kasir_u           ON sr.user_id        = kasir_u.id
        LEFT JOIN users admin_c       ON sr.created_by_admin = admin_c.id
        LEFT JOIN users approver      ON sr.approved_by    = approver.id
        LEFT JOIN branches b_req      ON b_req.id          = sr.branch_id
        WHERE 1=1
          ${statusCond}
          AND ${srDate} BETWEEN ? AND ?
          ${branchRequestWhere}
          ${userReqCond}
        ORDER BY sr.created_at DESC
      `, requestParams);

      results.push(...rows);
    }

    // ── 3. Transaksi POS ─────────────────────────────────────────────────
    // Dibungkus try-catch terpisah agar error di sini tidak crash seluruh endpoint
    if (!type_filter || ['all', 'transaction'].includes(type_filter)) {
      try {
        const found = 'created_by';

        if (!found) {
          // Tidak ada kolom user yang dikenal → skip section ini, jangan crash
          console.warn('[getDaily] Tabel transactions tidak memiliki kolom user yang dikenal:', cols.map(c=>c.COLUMN_NAME));
        } else {
          const piQtyCol = 'qty';

          // BUG FIX: Use COALESCE to include both admin-created transactions FOR this kasir (source_user_id)
          // and kasir's own transactions (created_by). This ensures kasir sees all pengeluaran.
          const userTxCond = uid
            ? `AND COALESCE(t.source_user_id, t.${found}) = ${uid}`
            : '';
          const branchTxWhere = branchId ? 'AND t.branch_id = ?' : '';
          const txParams = [from, to];
          if (branchId) txParams.push(branchId);

          const [rows] = await db.query(`
            SELECT
              CONCAT('tx-', t.id, '-', pi.stock_item_id)   AS id,
              (ti.qty * pi.${piQtyCol})                     AS qty,
              COALESCE(si.price_per_unit, 0)                AS cost_per_unit,
              (ti.qty * pi.${piQtyCol} * COALESCE(si.price_per_unit, 0)) AS total_cost,
              CONCAT('Transaksi · ', p.name, ' ×', ti.qty) AS note,
              t.created_at,
              b_tx.name                                      AS branch_name,
              'approved'    AS request_status,
              'transaction' AS type,
              si.name       AS item_name,
              si.unit,
              COALESCE(kasir_src.name, kasir_u.name)        AS created_by_name,
              creator_u.name                                AS approver_name,
              COALESCE(kasir_src.name, kasir_u.name)        AS target_user_name,
              CASE 
  WHEN t.source_user_id IS NOT NULL 
   AND t.created_by != t.source_user_id 
  THEN creator_u.name 
  ELSE NULL 
END AS admin_name,

              COALESCE(kasir_src.name, kasir_u.name)        AS stock_owner_name
            FROM transactions t
            JOIN  transaction_items ti    ON ti.transaction_id = t.id
            JOIN  products p              ON p.id              = ti.product_id
            JOIN  product_ingredients pi  ON pi.product_id     = ti.product_id
            JOIN  stock_items si          ON si.id             = pi.stock_item_id
            JOIN  users kasir_u           ON kasir_u.id        = t.${found}
            LEFT JOIN users kasir_src     ON kasir_src.id      = t.source_user_id
            LEFT JOIN users creator_u     ON creator_u.id      = t.created_by
            LEFT JOIN branches b_tx       ON b_tx.id           = t.branch_id
            WHERE ${txDate} BETWEEN ? AND ?
              ${branchTxWhere}
              ${userTxCond}
            ORDER BY t.created_at DESC
          `, txParams);

          results.push(...rows);
        }
      } catch (txErr) {
        // Log error transaksi POS tapi jangan crash seluruh response
        console.error('[getDaily] Error saat query transaksi POS:', txErr.message);
        // Tetap lanjut, results dari section 1 & 2 tetap dikirim
      }
    }

    // Sort gabungan DESC berdasarkan tanggal
    results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json(results);

  } catch (err) {
    console.error('[getDaily] Fatal error:', err);
    res.status(500).json({ message: err.message, stack: process.env.NODE_ENV === 'development' ? err.stack : undefined });
  }
};

// ── Helper: recalculate stock & avg price untuk satu bahan ──
async function recalcStockItem(conn, stockItemId) {
  const [[calc]] = await conn.query(`
    SELECT
      GREATEST(0,
        COALESCE(SUM(CASE WHEN type='in'  THEN qty        ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN type='out' THEN qty        ELSE 0 END), 0)
      ) AS correct_stock,
      COALESCE(SUM(CASE WHEN type='in' THEN total_cost ELSE 0 END), 0) AS total_cost_in,
      COALESCE(SUM(CASE WHEN type='in' THEN qty        ELSE 0 END), 0) AS total_qty_in
    FROM main_stock
    WHERE stock_item_id = ?
  `, [stockItemId]);

  const correctStock  = Number(calc.correct_stock);
  const totalCostIn   = Number(calc.total_cost_in);
  const totalQtyIn    = Number(calc.total_qty_in);
  const avgPrice      = totalQtyIn > 0
    ? Math.round(totalCostIn / totalQtyIn)
    : 0;

  await conn.query(`
    UPDATE stock_items
    SET stock          = ?,
        price_per_unit = ?,
        total_price    = ?
    WHERE id = ?
  `, [correctStock, avgPrice, correctStock * avgPrice, stockItemId]);

  return { correctStock, avgPrice };
}

// ── Tambah pemasukan stok (pembelanjaan) ──────────────────────
exports.addPurchase = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { items, note } = req.body;
    const branchId = getRequestBranchId(req) || req.user.branch_id || null;

    const inserted = [];
    for (const item of items) {
      // 1. Insert ke main_stock
      const [r] = await conn.query(`
        INSERT INTO main_stock
          (stock_item_id, qty, cost_per_unit, type, source, note, branch_id, created_by)
        VALUES (?, ?, ?, 'in', 'purchase', ?, ?, ?)
      `, [item.stock_item_id, item.qty, item.cost_per_unit, note || null, branchId, req.user.id]);

      // 2. Recalculate otomatis
      await recalcStockItem(conn, item.stock_item_id);

      inserted.push(r.insertId);
    }

    await conn.commit();
    res.json({ message: 'Pemasukan stok berhasil', inserted });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.updatePurchase = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;
    const { qty, cost_per_unit, note } = req.body;
    const branchId = getRequestBranchId(req) || req.user.branch_id || null;
    const oldParams = [id];
    const oldBranchWhere = branchId ? 'AND branch_id = ?' : '';
    if (branchId) oldParams.push(branchId);

    const [[old]] = await conn.query(
      `SELECT * FROM main_stock WHERE id = ? AND type = 'in' AND source = 'purchase' ${oldBranchWhere}`, oldParams
    );
    if (!old) {
      await conn.rollback();
      return res.status(404).json({ message: 'Tidak ditemukan' });
    }

    // 1. Update main_stock
    await conn.query(
      `UPDATE main_stock SET qty = ?, cost_per_unit = ?, note = ? WHERE id = ?`,
      [qty, cost_per_unit, note || null, id]
    );

    // 2. Recalculate otomatis
    await recalcStockItem(conn, old.stock_item_id);

    await conn.commit();
    res.json({ message: 'Berhasil diupdate' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.deletePurchase = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;
    const branchId = getRequestBranchId(req) || req.user.branch_id || null;
    const rowParams = [id];
    const rowBranchWhere = branchId ? 'AND branch_id = ?' : '';
    if (branchId) rowParams.push(branchId);

    const [[row]] = await conn.query(
      `SELECT * FROM main_stock WHERE id = ? AND type = 'in' AND source = 'purchase' ${rowBranchWhere}`, rowParams
    );
    if (!row) {
      await conn.rollback();
      return res.status(404).json({ message: 'Tidak ditemukan' });
    }

    // 1. Hapus dari main_stock
    await conn.query('DELETE FROM main_stock WHERE id = ?', [id]);

    // 2. Recalculate otomatis
    await recalcStockItem(conn, row.stock_item_id);

    await conn.commit();
    res.json({ message: 'Berhasil dihapus' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.addManualOut = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { items, note, user_id } = req.body;
    const branchId = getRequestBranchId(req) || req.user.branch_id || null;
    const targetUserId = (req.user.role === 'admin' && user_id) ? Number(user_id) : req.user.id;
    const adminId      = req.user.id;
    const normalizedItems = normalizeRequestItems(items);

    if (!normalizedItems.length) {
      await conn.rollback();
      return res.status(400).json({ message: 'Minimal 1 item' });
    }

    // ── Validasi stok dulu ──
    for (const item of normalizedItems) {
      const stockJoinBranch = branchId ? 'AND ms.branch_id = ?' : '';
      const stockParams = branchId ? [branchId, item.stock_item_id] : [item.stock_item_id];
      const [[si]] = await conn.query(
        `SELECT si.id, si.name,
          COALESCE(SUM(CASE WHEN ms.type='in' THEN ms.qty ELSE 0 END), 0) -
          COALESCE(SUM(CASE WHEN ms.type='out' THEN ms.qty ELSE 0 END), 0) AS stock
         FROM stock_items si
         LEFT JOIN main_stock ms ON ms.stock_item_id = si.id ${stockJoinBranch}
         WHERE si.id = ?
         GROUP BY si.id, si.name`,
        stockParams
      );
      if (!si) {
        await conn.rollback();
        return res.status(404).json({ message: `Bahan id ${item.stock_item_id} tidak ditemukan` });
      }
      if (Number(si.stock) < Number(item.qty)) {
        await conn.rollback();
        return res.status(400).json({
          message: `Stok ${si.name} tidak cukup (tersedia: ${si.stock})`
        });
      }
    }

    // ── Cari request PENDING hari ini untuk user ini ──
    const today = new Date().toISOString().split('T')[0];
    // const [[existingPending]] = await conn.query(
    //   'SELECT id FROM stock_requests WHERE user_id = ? AND date = ? AND status = "pending"',
    //   [targetUserId, today]
    // );
    // Cek pending saja — boleh buat baru jika sebelumnya rejected/approved
    const pendingBranchWhere = branchId ? 'AND branch_id = ?' : '';
    const pendingParams = [targetUserId, today];
    if (branchId) pendingParams.push(branchId);
    const [[existingPending]] = await conn.query(
      `SELECT id, note FROM stock_requests WHERE user_id = ? AND date = ? AND status = 'pending' ${pendingBranchWhere}`,
      pendingParams
    );

    let reqId;

    if (existingPending) {
      reqId = existingPending.id;

      // Update note saja
      if (note) {
        await conn.query(
          'UPDATE stock_requests SET note = ? WHERE id = ?',
          [mergeNotes(existingPending.note, note), reqId]
        );
      }

      // ── MERGE items: update qty jika sudah ada, insert jika belum ──
      for (const item of normalizedItems) {
        const [[si]] = await conn.query(
          'SELECT price_per_unit FROM stock_items WHERE id = ?',
          [item.stock_item_id]
        );

        // Cek apakah stock_item_id ini sudah ada di request
        const [[existing]] = await conn.query(
          'SELECT id, qty_requested FROM stock_request_items WHERE request_id = ? AND stock_item_id = ?',
          [reqId, item.stock_item_id]
        );

        if (existing) {
          // Tambahkan qty — bukan replace
          const newQty = Number(existing.qty_requested) + Number(item.qty);
          await conn.query(
            'UPDATE stock_request_items SET qty_requested = ? WHERE id = ?',
            [newQty, existing.id]
          );
        } else {
          // Insert baru
          await conn.query(`
            INSERT INTO stock_request_items
              (request_id, stock_item_id, qty_requested, cost_per_unit)
            VALUES (?, ?, ?, ?)
          `, [reqId, item.stock_item_id, Number(item.qty), si?.price_per_unit || 0]);
        }
      }

    } else {
      // ── Tidak ada pending → buat request baru ──
      // (Boleh buat baru meski sudah ada yang approved di hari yang sama)
      const [reqResult] = await conn.query(
        "INSERT INTO stock_requests (user_id, date, status, note, branch_id, created_by_admin) VALUES (?, ?, 'pending', ?, ?, ?)",
        [targetUserId, today, note || null, branchId, adminId]
      );
      reqId = reqResult.insertId;

      // Insert semua items
      for (const item of normalizedItems) {
        const [[si]] = await conn.query(
          'SELECT price_per_unit FROM stock_items WHERE id = ?',
          [item.stock_item_id]
        );
        await conn.query(`
          INSERT INTO stock_request_items
            (request_id, stock_item_id, qty_requested, cost_per_unit)
          VALUES (?, ?, ?, ?)
        `, [reqId, item.stock_item_id, Number(item.qty), si?.price_per_unit || 0]);
      }
    }

    await conn.commit();
    res.json({
      message: existingPending
        ? 'Pengajuan diperbarui (item ditambahkan ke pengajuan yang ada)'
        : 'Pengajuan pengeluaran berhasil dibuat',
      request_id: reqId,
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

// ══════════════════════════════════════════════════════════════════════════
// 🔄 BULK RECALCULATION ENDPOINT
// ══════════════════════════════════════════════════════════════════════════
// Purpose: Sync all stock_items.stock values with main_stock calculations
// Use Case: After major data fixes or migrations to ensure database consistency
// Security: Admin only
// ══════════════════════════════════════════════════════════════════════════

/**
 * Recalculate all stock balances from main_stock movements
 * Syncs stock_items.stock column with formula: SUM(IN) - SUM(OUT)
 * 
 * @param {number} stockItemId - Optional: recalculate only one item
 * @returns {Object} Summary of recalculated items
 */
async function recalculateAllBalances(conn, specificItemId = null) {
  try {
    // Get list of items to recalculate
    let itemQuery = 'SELECT id FROM stock_items';
    const params = [];
    
    if (specificItemId) {
      itemQuery += ' WHERE id = ?';
      params.push(specificItemId);
    }

    const [items] = await conn.query(itemQuery, params);
    
    let successCount = 0;
    let errorCount = 0;
    const results = [];

    for (const item of items) {
      try {
        const { correctStock, avgPrice } = await recalcStockItem(conn, item.id);
        successCount++;
        results.push({
          item_id: item.id,
          status: 'success',
          calculated_stock: correctStock,
          avg_price: avgPrice
        });
      } catch (err) {
        errorCount++;
        results.push({
          item_id: item.id,
          status: 'error',
          error: err.message
        });
      }
    }

    return {
      total_items: items.length,
      success_count: successCount,
      error_count: errorCount,
      results: results
    };
  } catch (err) {
    throw err;
  }
}

/**
 * HTTP Endpoint: Recalculate all stock balances
 * POST /api/stock/recalculate-all
 * 
 * Returns detailed report of recalculation
 */
exports.recalculateAllBalances = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    // Verify admin permission
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        error_code: 'FORBIDDEN',
        message: 'Hanya admin yang dapat menjalankan recalculation'
      });
    }

    await conn.beginTransaction();

    const result = await recalculateAllBalances(conn);

    await conn.commit();

    // Log the operation
    console.log(`✓ Stock recalculation completed: ${result.success_count}/${result.total_items} items`);

    res.json({
      message: 'Recalculation berhasil',
      success: true,
      summary: {
        total_items: result.total_items,
        success: result.success_count,
        errors: result.error_count,
        timestamp: new Date().toISOString()
      },
      details: result.results.slice(0, 50), // Return first 50 for brevity
      ...(result.results.length > 50 && { 
        note: `Menampilkan 50 dari ${result.results.length} items. Lihat log untuk detail lengkap.` 
      })
    });

  } catch (err) {
    await conn.rollback();

    res.status(500).json({
      error_code: 'RECALCULATION_FAILED',
      message: 'Gagal melakukan recalculation',
      error: err.message,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });

  } finally {
    conn.release();
  }
};

/**
 * HTTP Endpoint: Recalculate single stock item balance
 * POST /api/stock/:itemId/recalculate
 */
exports.recalculateItemBalance = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    const { itemId } = req.params;

    // Verify item exists
    const [[item]] = await conn.query(
      'SELECT id, name FROM stock_items WHERE id = ?',
      [itemId]
    );

    if (!item) {
      return res.status(404).json({
        error_code: 'NOT_FOUND',
        message: 'Bahan baku tidak ditemukan'
      });
    }

    await conn.beginTransaction();

    const { correctStock, avgPrice } = await recalcStockItem(conn, itemId);

    await conn.commit();

    res.json({
      message: 'Recalculation berhasil',
      success: true,
      item: {
        id: itemId,
        name: item.name,
        current_stock: correctStock,
        avg_price: avgPrice,
        total_value: correctStock * avgPrice
      }
    });

  } catch (err) {
    await conn.rollback();

    res.status(500).json({
      error_code: 'RECALCULATION_FAILED',
      message: err.message,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });

  } finally {
    conn.release();
  }
};

