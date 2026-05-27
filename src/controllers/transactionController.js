const db = require('../config/db');
const { createTransaction } = require('../services/transactionService');
const { getRequestBranchId } = require('../utils/branchContext');

const jakartaDateExpr = (column) =>
  db.isPostgres
    ? `CAST(${column} AT TIME ZONE 'Asia/Jakarta' AS DATE)`
    : `DATE(${column})`;

exports.create = async (req, res) => {
  try {
    const { items, payment_method, sourceUserId } = req.body;
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
        u_source.role AS source_user_role
      FROM transactions t
      LEFT JOIN users u_creator ON t.created_by = u_creator.id
      LEFT JOIN users u_source ON t.source_user_id = u_source.id
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
