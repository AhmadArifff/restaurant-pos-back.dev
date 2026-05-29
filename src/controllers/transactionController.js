const db = require('../config/db');
const { createTransaction } = require('../services/transactionService');
const { getRequestBranchId } = require('../utils/branchContext');

const jakartaDateExpr = (column) =>
  db.isPostgres
    ? `CAST(${column} AT TIME ZONE 'Asia/Jakarta' AS DATE)`
    : `DATE(${column})`;

exports.create = async (req, res) => {
  try {
    const { items, payment_method, sourceUserId, table_id, customer_phone, voucher_code } = req.body;
    if (!items || !items.length)
      return res.status(400).json({ message: 'Items tidak boleh kosong' });

    // sourceUserId: ketika admin membuat transaksi dari kasir tertentu
    // jika tidak ada, berarti kasir membuat transaksi sendiri
    const result = await createTransaction({
      items,
      payment_method: payment_method || 'cash',
      userId: req.user.id,
      sourceUserId: sourceUserId || null,
      branchId: getRequestBranchId(req) || req.user.branch_id || null,
      tableId: table_id || null,
      customerPhone: customer_phone || '',
      voucherCode: voucher_code || '',
    });

    res.status(201).json({ 
      message: 'Transaksi berhasil', 
      data: result 
    });
  } catch (err) {
    console.error('Transaction creation error:', err.message);
    res.status(err.status_code || 400).json({ 
      message: err.message,
      validation_errors: err.validation_errors || undefined
    });
  }
};

exports.getAll = async (req, res) => {
  try {
    const { dateFrom, dateTo, search, limit = 100 } = req.query;
    const branchId = getRequestBranchId(req) || req.user.branch_id || null;
    const txDate = jakartaDateExpr('t.created_at');
    
    // Logging untuk debug
    console.log('Fetching transactions:', { dateFrom, dateTo, search, limit });
    
    let sql = `
      SELECT 
        t.id,
        t.invoice_number,
        t.total_price,
        t.payment_method,
        t.created_at,
        u_creator.id AS creator_id,
        u_creator.name AS creator_name,
        u_creator.role AS creator_role,
        u_source.id AS source_user_id,
        u_source.name AS source_user_name,
        u_source.role AS source_user_role,
        co.order_code AS customer_order_code,
        COALESCE(co.discount_amount, t.discount_amount, 0) AS customer_discount_amount,
        COALESCE(co.discount_rate, t.discount_rate, 0) AS customer_discount_rate,
        COALESCE(co.discount_label, t.discount_label) AS discount_label,
        COALESCE(co.voucher_code, t.voucher_code) AS voucher_code,
        co.reviewed_at AS customer_reviewed_at,
        dt.table_number AS table_number
      FROM transactions t
      LEFT JOIN users u_creator ON t.created_by = u_creator.id
      LEFT JOIN users u_source ON t.source_user_id = u_source.id
      LEFT JOIN customer_orders co ON co.transaction_id = t.id
      LEFT JOIN dining_tables dt ON dt.id = co.table_id
      WHERE 1=1
    `;
    const params = [];

    if (dateFrom) { 
      sql += ` AND ${txDate} >= ?`;
      params.push(dateFrom); 
    }
    if (dateTo) { 
      sql += ` AND ${txDate} <= ?`;
      params.push(dateTo); 
    }
    if (search) { 
      sql += ' AND (t.invoice_number LIKE ? OR u_creator.name LIKE ? OR u_source.name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`); 
    }
    if (branchId) {
      sql += ' AND t.branch_id = ?';
      params.push(branchId);
    }
    
    sql += ' ORDER BY t.created_at DESC LIMIT ?';
    params.push(Number(limit));

    const [rows] = await db.query(sql, params);
    
    console.log(`Found ${rows.length} transactions`);
    
    res.json(rows);
  } catch (err) {
    console.error('Transaction fetch error:', err.message);
    res.status(500).json({ message: err.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const [tx] = await db.query(
      `SELECT t.*, u.name AS kasir_name
       FROM transactions t
       LEFT JOIN users u ON t.created_by = u.id
       WHERE t.id = ?`,
      [req.params.id]
    );
    if (!tx.length) return res.status(404).json({ message: 'Transaksi tidak ditemukan' });

    const [items] = await db.query(
      `SELECT ti.*, p.name AS product_name
       FROM transaction_items ti
       LEFT JOIN products p ON ti.product_id = p.id
       WHERE ti.transaction_id = ?`,
      [req.params.id]
    );

    res.json({ ...tx[0], items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.delete = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const branchId = getRequestBranchId(req) || req.user.branch_id || null;
    const params = [req.params.id];
    let where = 'WHERE id = ?';
    if (branchId) {
      where += ' AND branch_id = ?';
      params.push(branchId);
    }

    const [rows] = await conn.query(`SELECT * FROM transactions ${where} LIMIT 1`, params);
    const transaction = rows[0];
    if (!transaction) {
      await conn.rollback();
      return res.status(404).json({ message: 'Transaksi tidak ditemukan di cabang aktif' });
    }

    const canVoid = req.user.role === 'admin'
      || Number(transaction.created_by) === Number(req.user.id)
      || Number(transaction.source_user_id) === Number(req.user.id);
    if (!canVoid) {
      await conn.rollback();
      return res.status(403).json({ message: 'Anda tidak memiliki akses untuk menghapus transaksi ini' });
    }

    const [stockRows] = await conn.query(`
      SELECT stock_item_id, COALESCE(SUM(qty), 0) AS qty_return
      FROM main_stock
      WHERE source = 'transaction'
        AND reference_id = ?
        AND type = 'out'
      GROUP BY stock_item_id
    `, [transaction.id]);

    for (const row of stockRows) {
      await conn.query(
        'UPDATE stock_items SET stock = stock + ? WHERE id = ?',
        [Number(row.qty_return || 0), row.stock_item_id]
      );
    }

    await conn.query(
      "DELETE FROM main_stock WHERE source = 'transaction' AND reference_id = ?",
      [transaction.id]
    );

    const reason = String(req.body?.reason || '').trim()
      || `Transaksi ${transaction.invoice_number} dihapus/void oleh ${req.user.name || req.user.role}`;
    const [linkedOrders] = await conn.query(
      'SELECT id FROM customer_orders WHERE transaction_id = ?',
      [transaction.id]
    );
    const linkedOrderIds = linkedOrders.map((order) => Number(order.id)).filter(Boolean);
    await conn.query(`
      UPDATE customer_orders
      SET status = 'cancelled',
          cancel_reason = ?,
          cancelled_by = ?,
          cancelled_at = NOW(),
          transaction_id = NULL
      WHERE transaction_id = ?
    `, [reason, req.user.id, transaction.id]);

    await conn.query('DELETE FROM discount_redemptions WHERE transaction_id = ?', [transaction.id]);
    if (linkedOrderIds.length) {
      await conn.query(
        `DELETE FROM discount_redemptions WHERE order_id IN (${linkedOrderIds.map(() => '?').join(',')})`,
        linkedOrderIds
      );
    }

    await conn.query('DELETE FROM transactions WHERE id = ?', [transaction.id]);
    await conn.commit();

    res.json({
      message: 'Transaksi berhasil dihapus dan stok sudah dikembalikan',
      restored_items: stockRows.length,
    });
  } catch (err) {
    await conn.rollback();
    console.error('Transaction delete error:', err.message);
    res.status(err.status_code || 500).json({ message: err.message });
  } finally {
    conn.release();
  }
};
