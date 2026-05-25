// const db = require('../config/db');

// exports.createTransaction = async ({ items, payment_method, userId }) => {
//   const conn = await db.getConnection();
//   try {
//     await conn.beginTransaction();

//     const total_price    = items.reduce((sum, i) => sum + i.price * i.qty, 0);
//     const invoice_number = `INV-${Date.now()}`;

//     // 1. Cek stok bahan baku semua item dulu sebelum proses
//     for (const item of items) {
//       const [ings] = await conn.query(`
//         SELECT pi.qty AS needed, si.id, si.name, si.stock
//         FROM product_ingredients pi
//         JOIN stock_items si ON pi.stock_item_id = si.id
//         WHERE pi.product_id = ?
//       `, [item.product_id]);

//       for (const ing of ings) {
//         const totalNeeded = ing.needed * item.qty;
//         if (ing.stock < totalNeeded) {
//           throw new Error(
//             `Bahan "${ing.name}" tidak cukup. Stok: ${ing.stock}, butuh: ${totalNeeded}`
//           );
//         }
//       }
//     }

//     // 2. Insert transaksi
//     const [txResult] = await conn.query(
//       'INSERT INTO transactions (invoice_number, total_price, payment_method, created_by) VALUES (?, ?, ?, ?)',
//       [invoice_number, total_price, payment_method, userId]
//     );
//     const transactionId = txResult.insertId;

//     // 3. Insert items + kurangi bahan baku
//     for (const item of items) {
//       await conn.query(
//         'INSERT INTO transaction_items (transaction_id, product_id, price, qty, subtotal) VALUES (?, ?, ?, ?, ?)',
//         [transactionId, item.product_id, item.price, item.qty, item.price * item.qty]
//       );

//       // Ambil resep produk
//       const [ings] = await conn.query(`
//         SELECT pi.qty AS needed, si.id AS stock_item_id
//         FROM product_ingredients pi
//         JOIN stock_items si ON pi.stock_item_id = si.id
//         WHERE pi.product_id = ?
//       `, [item.product_id]);

//       // Kurangi tiap bahan baku sesuai qty transaksi
//       for (const ing of ings) {
//         const totalOut = ing.needed * item.qty;
//         await conn.query(
//           'UPDATE stock_items SET stock = stock - ? WHERE id = ?',
//           [totalOut, ing.stock_item_id]
//         );
//         await conn.query(
//           "INSERT INTO stock_item_movements (stock_item_id, type, qty, reference) VALUES (?, 'OUT', ?, ?)",
//           [ing.stock_item_id, totalOut, invoice_number]
//         );
//       }
//     }

//     await conn.commit();
//     return { transactionId, invoice_number, total_price };
//   } catch (err) {
//     await conn.rollback();
//     throw err;
//   } finally {
//     conn.release();
//   }
// };
// Di services/transactionService.js — tambah pengurangan stok kasir


// const db = require('../config/db');

// exports.createTransaction = async ({ items, payment_method, userId, sourceUserId }) => {
//   const conn = await db.getConnection();
//   try {
//     await conn.beginTransaction();

//     // sourceUserId = stok dari user mana yang dipakai
//     // Kalau tidak dikirim, pakai userId (kasir sendiri)
//     const stockOwnerId = sourceUserId || userId;

//     let total = 0;
//     const invoiceNumber = `INV-${Date.now()}`;

//     // Hitung total transaksi
//     for (const item of items) {
//       total += Number(item.price) * Number(item.qty);
//     }

//     // Validasi stok per item SEBELUM insert
//     for (const item of items) {
//       const [ings] = await conn.query(`
//         SELECT pi.*, si.name AS ing_name, si.unit
//         FROM product_ingredients pi
//         JOIN stock_items si ON si.id = pi.stock_item_id
//         WHERE pi.product_id = ?
//       `, [item.product_id]);

//       for (const ing of ings) {
//         // Total approved untuk stockOwner
//         const [[approved]] = await conn.query(`
//           SELECT COALESCE(SUM(sri.qty_approved), 0) AS total
//           FROM stock_requests sr
//           JOIN stock_request_items sri ON sri.request_id = sr.id
//           WHERE sr.user_id = ?
//             AND sr.status = 'approved'
//             AND sri.stock_item_id = ?
//             AND sri.qty_approved IS NOT NULL
//         `, [stockOwnerId, ing.stock_item_id]);

//         // Total sudah dipakai di transaksi sebelumnya oleh stockOwner
//         // Pakai source_user_id untuk tracking stok kasir
//         const [[used]] = await conn.query(`
//           SELECT COALESCE(SUM(ti.qty * pi.qty), 0) AS total
//           FROM transaction_items ti
//           JOIN transactions t ON ti.transaction_id = t.id
//           JOIN product_ingredients pi
//             ON pi.product_id = ti.product_id
//             AND pi.stock_item_id = ?
//           WHERE t.source_user_id = ?
//         `, [ing.stock_item_id, stockOwnerId]);

//         const remaining = Math.max(0, Number(approved.total) - Number(used.total));
//         const needed    = Number(ing.qty) * Number(item.qty);

//         if (remaining < needed) {
//           await conn.rollback();
//           throw new Error(
//             `Stok ${ing.ing_name} tidak cukup ` +
//             `(tersisa: ${remaining} ${ing.unit}, butuh: ${needed} ${ing.unit})`
//           );
//         }
//       }
//     }

//     // Insert transaksi
//     const [txResult] = await conn.query(`
//       INSERT INTO transactions
//         (invoice_number, total_price, payment_method, created_by, source_user_id)
//       VALUES (?, ?, ?, ?, ?)
//     `, [invoiceNumber, total, payment_method, userId, stockOwnerId]);

//     const transactionId = txResult.insertId;

//     // Insert items
//     for (const item of items) {
//       await conn.query(`
//         INSERT INTO transaction_items (transaction_id, product_id, qty, price)
//         VALUES (?, ?, ?, ?)
//       `, [transactionId, item.product_id, item.qty, item.price]);
//     }

//     await conn.commit();

//     return {
//       transaction_id:  transactionId,
//       invoice_number:  invoiceNumber,
//       total,
//       kasir_name:      null, // diisi di frontend
//     };
//   } catch (err) {
//     await conn.rollback();
//     throw err;
//   } finally {
//     conn.release();
//   }
// };

// src/services/transactionService.js
// ============================================================
// FIX UTAMA:
// 1. Insert ke main_stock setelah transaksi (source='transaction')
// 2. Update stock_items.stock setelah transaksi
// ============================================================
const db = require('../config/db');

// ══════════════════════════════════════════════════════════════════════════
// 🔄 ATOMIC TRANSACTION WITH FULL VALIDATION & ERROR HANDLING
// ══════════════════════════════════════════════════════════════════════════
// Purpose: Ensure stock deductions and transaction records are always in sync
// Features:
//   ✓ Single database transaction wraps entire operation (BEGIN...COMMIT/ROLLBACK)
//   ✓ Pre-validation: Check ALL ingredients have sufficient stock BEFORE processing
//   ✓ Negative balance prevention: Reject if would cause negative balance
//   ✓ Audit trail: Records all movements to main_stock with immutable reference
//   ✓ Fallback safety: GREATEST(0, ...) prevents DB negative but rejects at API level
// ══════════════════════════════════════════════════════════════════════════

exports.createTransaction = async ({ items, payment_method, userId, sourceUserId, branchId }) => {
  const conn = await db.getConnection();
  try {
    // ⭕ BEGIN TRANSACTION - all operations below are atomic
    await conn.beginTransaction();

    const stockOwnerId  = sourceUserId || userId;
    let   total         = 0;
    const invoiceNumber = `INV-${Date.now()}`;

    // Step 1: Calculate total transaction value
    for (const item of items) {
      total += Number(item.price) * Number(item.qty);
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 2: PRE-VALIDATION - Check all ingredients BEFORE any database changes
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const validationErrors = [];

    for (const item of items) {
      const [ings] = await conn.query(`
        SELECT pi.stock_item_id,
               pi.qty            AS qty_per_unit,
               si.name           AS ing_name,
               si.unit,
               si.id
        FROM product_ingredients pi
        JOIN stock_items si ON si.id = pi.stock_item_id
        WHERE pi.product_id = ?
      `, [item.product_id]);

      for (const ing of ings) {
        const neededQty = Number(ing.qty_per_unit) * Number(item.qty);

        const [[balance]] = await conn.query(`
          SELECT
            COALESCE(SUM(CASE WHEN type = 'in' THEN qty ELSE 0 END), 0) -
            COALESCE(SUM(CASE WHEN type = 'out' THEN qty ELSE 0 END), 0) AS total
          FROM main_stock
          WHERE stock_item_id = ?
            AND (? IS NULL OR branch_id = ?)
        `, [ing.stock_item_id, branchId || null, branchId || null]);

        const remainingApproved = Number(balance.total);
        
        // ❌ VALIDATION: Check if sufficient stock available
        if (remainingApproved < neededQty) {
          validationErrors.push({
            item_name: ing.ing_name,
            unit: ing.unit,
            needed: neededQty,
            available: Math.max(0, remainingApproved),
            error_code: 'INSUFFICIENT_STOCK'
          });
        }

        // ⚠️ WARNING CHECK: Warn if stock would go negative (but still allow if > 0)
        const currentBalance = remainingApproved - neededQty;
        if (currentBalance < 0) {
          validationErrors.push({
            item_name: ing.ing_name,
            unit: ing.unit,
            current_balance: remainingApproved,
            would_be: currentBalance,
            error_code: 'WOULD_GO_NEGATIVE'
          });
        }
      }
    }

    // If any validation errors, rollback immediately
    if (validationErrors.length > 0) {
      await conn.rollback();
      const err = new Error('Validasi stok gagal');
      err.validation_errors = validationErrors;
      err.status_code = 400;
      throw err;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 3: INSERT TRANSACTION RECORD
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const [txResult] = await conn.query(`
      INSERT INTO transactions
        (invoice_number, total_price, payment_method, created_by, source_user_id, branch_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [invoiceNumber, total, payment_method, userId, stockOwnerId, branchId || null]);

    const transactionId = txResult.insertId;

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 4: PROCESS EACH ITEM - Insert transaction items + deduct stock
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    for (const item of items) {
      const subtotal = Number(item.price) * Number(item.qty);

      // Insert transaction item
      await conn.query(`
        INSERT INTO transaction_items
          (transaction_id, product_id, qty, price, subtotal)
        VALUES (?, ?, ?, ?, ?)
      `, [transactionId, item.product_id, item.qty, item.price, subtotal]);

      // Get all ingredients for this product
      const [ings] = await conn.query(`
        SELECT pi.stock_item_id,
               pi.qty            AS qty_per_unit,
               si.price_per_unit,
               si.name           AS ing_name,
               si.unit
        FROM product_ingredients pi
        JOIN stock_items si ON si.id = pi.stock_item_id
        WHERE pi.product_id = ?
      `, [item.product_id]);

      // Deduct each ingredient
      for (const ing of ings) {
        const qtyOut      = Number(ing.qty_per_unit) * Number(item.qty);
        const costPerUnit = Number(ing.price_per_unit) || 0;
        const totalCost   = qtyOut * costPerUnit;

        // 📝 Insert audit trail to main_stock (IMMUTABLE RECORD)
        // This is the "single source of truth" for stock calculations
        await conn.query(`
          INSERT INTO main_stock
            (stock_item_id, qty, cost_per_unit, total_cost, type, source, reference_id, note, branch_id, created_by)
          VALUES (?, ?, ?, ?, 'out', 'transaction', ?, ?, ?, ?)
        `, [
          ing.stock_item_id,
          qtyOut,
          costPerUnit,
          totalCost,
          transactionId,
          `INV: ${invoiceNumber} | Product x${item.qty} | ${ing.ing_name}`,
          branchId || null,
          userId,
        ]);

        // 💾 Update stock_items.stock as a convenience field (for quick lookups)
        // Note: Not used in balance calculations, but maintained for UI performance
        await conn.query(`
          UPDATE stock_items
          SET stock = GREATEST(0, stock - ?)
          WHERE id = ?
        `, [qtyOut, ing.stock_item_id]);
      }
    }

    // ⭕ COMMIT TRANSACTION - all operations succeed atomically
    await conn.commit();

    return { 
      transaction_id: transactionId, 
      invoice_number: invoiceNumber, 
      total, 
      kasir_name: null 
    };

  } catch (err) {
    // 🔙 ROLLBACK on any error - ensures no partial updates
    await conn.rollback();
    throw err;

  } finally {
    conn.release();
  }
};


// ──────────────────────────────────────────────────────────────────────────
// CONTROLLER: Handle transaction creation from HTTP request
// ──────────────────────────────────────────────────────────────────────────
exports.create = async (req, res) => {
  try {
    const { items, payment_method, source_user_id, branch_id } = req.body;
    
    // Input validation
    if (!items || !items.length)
      return res.status(400).json({ 
        error_code: 'EMPTY_ITEMS',
        message: 'Items tidak boleh kosong' 
      });

    // Create transaction
    const result = await exports.createTransaction({
      items,
      payment_method: payment_method || 'cash',
      userId:         req.user.id,
      sourceUserId:   source_user_id || req.user.id,
      branchId:       branch_id || req.user.branch_id || null,
    });

    res.status(201).json({ 
      message: 'Transaksi berhasil',
      success: true,
      data: result 
    });

  } catch (err) {
    // Handle validation errors with detailed feedback
    if (err.validation_errors && err.validation_errors.length > 0) {
      return res.status(400).json({
        error_code: 'STOCK_VALIDATION_FAILED',
        message: 'Validasi stok gagal',
        validation_errors: err.validation_errors
      });
    }

    // Handle generic errors
    res.status(err.status_code || 500).json({
      error_code: 'TRANSACTION_FAILED',
      message: err.message || 'Transaksi gagal',
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
};
