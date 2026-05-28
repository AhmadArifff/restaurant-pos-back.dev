const crypto = require('crypto');
const db = require('../config/db');
const { createTransaction } = require('../services/transactionService');
const { getUserIngredientBalance } = require('../services/stockAllocationService');
const { getRequestBranchId } = require('../utils/branchContext');
const {
  calculateAmount,
  findBestDiscount,
  getReviewProgram,
  recordRedemption,
  validateProgramUsage,
} = require('../services/discountService');

const VALID_ORDER_STATUSES = ['pending', 'accepted', 'preparing', 'ready', 'completed', 'cancelled'];
const STAFF_ORDER_STATUSES = ['accepted', 'preparing', 'ready', 'completed', 'cancelled'];
const NEXT_STATUS_BY_CURRENT = {
  pending: 'accepted',
  accepted: 'preparing',
  preparing: 'ready',
  ready: 'completed',
};
const REVIEW_DISCOUNT_RATE = 5;

const makeToken = () => crypto.randomBytes(24).toString('hex');
const makeOrderCode = () => `ORD-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

const toMoney = (value) => Number(Number(value || 0).toFixed(2));

const normalizeTablePayload = (body) => ({
  table_number: String(body.table_number || '').trim(),
  table_name: body.table_name ? String(body.table_name).trim() : null,
  capacity: Math.max(1, Number(body.capacity || 2)),
  status: ['active', 'maintenance', 'inactive'].includes(body.status) ? body.status : 'active',
  note: body.note ? String(body.note).trim() : null,
  branch_id: body.branch_id ? Number(body.branch_id) : null,
});

const attachOrderDetails = async (order) => {
  if (!order) return null;

  const [items] = await db.query(`
    SELECT coi.*, p.image_url, c.name AS category_name
    FROM customer_order_items coi
    LEFT JOIN products p ON p.id = coi.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE coi.order_id = ?
    ORDER BY coi.id ASC
  `, [order.id]);

  const [serviceReviews] = await db.query(
    'SELECT * FROM customer_order_reviews WHERE order_id = ? LIMIT 1',
    [order.id]
  );
  const [itemReviews] = await db.query(
    'SELECT * FROM customer_order_item_reviews WHERE order_id = ?',
    [order.id]
  );

  const reviewByItemId = itemReviews.reduce((acc, review) => {
    acc[review.order_item_id] = review;
    return acc;
  }, {});

  return {
    ...order,
    items: items.map((item) => ({
      ...item,
      review: reviewByItemId[item.id] || null,
    })),
    service_review: serviceReviews[0] || null,
  };
};

const getOrderRowByCode = async (orderCode) => {
  const [rows] = await db.query(`
    SELECT co.*, dt.table_number, dt.table_name
    FROM customer_orders co
    JOIN dining_tables dt ON dt.id = co.table_id
    WHERE co.order_code = ?
    LIMIT 1
  `, [orderCode]);
  return rows[0] || null;
};

const getOrderRowById = async (id) => {
  const [rows] = await db.query(`
    SELECT co.*, dt.table_number, dt.table_name
    FROM customer_orders co
    JOIN dining_tables dt ON dt.id = co.table_id
    WHERE co.id = ?
    LIMIT 1
  `, [id]);
  return rows[0] || null;
};

const buildPublicMenu = async (branchId = null) => {
  const [stockUsers] = await db.query(
    "SELECT id, name, role FROM users WHERE role IN ('kasir', 'admin') ORDER BY role DESC, name ASC"
  );

  const [products] = await db.query(`
    SELECT p.*, c.name AS category_name
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    ORDER BY c.name ASC, p.name ASC
  `);

  for (const product of products) {
    const [ingredients] = await db.query(`
      SELECT pi.qty, si.id AS stock_item_id, si.name AS ingredient_name, si.unit
      FROM product_ingredients pi
      JOIN stock_items si ON pi.stock_item_id = si.id
      WHERE pi.product_id = ?
    `, [product.id]);

    product.ingredients = ingredients;

    if (!ingredients.length) {
      product.stock = 0;
      continue;
    }

    let bestReadyStock = 0;
    let bestReadyUser = null;
    const stockByUser = [];

    for (const user of stockUsers) {
      let canMake = Infinity;
      for (const ingredient of ingredients) {
        const remaining = await getUserIngredientBalance(db, ingredient.stock_item_id, user.id, branchId);
        canMake = Math.min(canMake, Math.floor(remaining / Number(ingredient.qty || 1)));
      }

      const ready = canMake === Infinity ? 0 : Math.max(0, canMake);
      stockByUser.push({
        user_id: user.id,
        user_name: user.name,
        role: user.role,
        can_make: ready,
      });

      if (ready > bestReadyStock) {
        bestReadyStock = ready;
        bestReadyUser = user;
      }
    }

    product.stock = bestReadyStock;
    product.stock_source_user = bestReadyUser
      ? { user_id: bestReadyUser.id, user_name: bestReadyUser.name, role: bestReadyUser.role }
      : null;
    product.stock_by_user = stockByUser;
  }

  return products;
};

const resolveFulfillmentTransaction = async ({ order, actorUserId, requestedSourceUserId }) => {
  if (order.transaction_id) return { transaction_id: order.transaction_id, reused: true };

  const [items] = await db.query(
    'SELECT product_id, price, qty FROM customer_order_items WHERE order_id = ? ORDER BY id ASC',
    [order.id]
  );

  const [users] = await db.query("SELECT id, name, role FROM users WHERE role IN ('kasir', 'admin') ORDER BY role DESC, name ASC");
  const candidateIds = [
    requestedSourceUserId,
    actorUserId,
    ...users.map((user) => user.id),
  ]
    .filter(Boolean)
    .map((id) => Number(id));

  const uniqueCandidateIds = [...new Set(candidateIds)];
  let lastError = null;

  for (const sourceUserId of uniqueCandidateIds) {
    try {
      const result = await createTransaction({
        items: items.map((item) => ({
          product_id: item.product_id,
          price: Number(item.price),
          qty: Number(item.qty),
        })),
        payment_method: 'cash',
        userId: actorUserId,
        sourceUserId,
        branchId: order.branch_id || null,
        skipDiscount: true,
      });
      if (Number(order.discount_amount || 0) > 0) {
        await db.query(`
          UPDATE transactions
          SET total_price = ?,
              discount_rate = ?,
              discount_amount = ?,
              discount_label = ?,
              discount_program_id = ?,
              voucher_code = ?,
              customer_phone = ?
          WHERE id = ?
        `, [
          order.final_total,
          order.discount_rate || 0,
          order.discount_amount || 0,
          order.discount_label || null,
          order.discount_program_id || null,
          order.voucher_code || null,
          order.customer_phone || null,
          result.transaction_id,
        ]);
      }
      return result;
    } catch (err) {
      lastError = err;
      if (!err.validation_errors) throw err;
    }
  }

  const err = new Error('Stok siap jual cabang belum cukup untuk menerima pesanan ini');
  err.status_code = 400;
  const uniqueErrors = new Map();
  (lastError?.validation_errors || []).forEach((item) => {
    if (!item?.item_name) return;
    uniqueErrors.set(item.item_name, {
      item_name: item.item_name,
      unit: item.unit || '',
      available: Math.max(0, Number(item.available ?? item.current_balance ?? 0)),
      needed: Number(item.needed ?? 0),
      error_code: 'INSUFFICIENT_READY_STOCK',
    });
  });
  err.validation_errors = [...uniqueErrors.values()];
  throw err;
};

exports.listPublicTables = async (req, res) => {
  try {
    const branchId = getRequestBranchId(req);
    const branchWhere = branchId ? 'AND dt.branch_id = ?' : '';
    const params = branchId ? [branchId] : [];
    const orderBy = db.isPostgres
      ? 'table_number ASC'
      : 'CAST(table_number AS UNSIGNED), table_number';
    const [rows] = await db.query(`
      SELECT
        dt.id,
        dt.table_number,
        dt.table_name,
        dt.capacity,
        dt.qr_token,
        dt.status,
        dt.branch_id,
        b.name AS branch_name,
        b.area AS branch_area,
        b.address AS branch_address,
        COUNT(co.id) AS active_orders
      FROM dining_tables dt
      LEFT JOIN branches b ON b.id = dt.branch_id
      LEFT JOIN customer_orders co ON co.table_id = dt.id
        AND co.status IN ('pending', 'accepted', 'preparing', 'ready')
      WHERE dt.status = 'active'
        ${branchWhere}
      GROUP BY dt.id, dt.table_number, dt.table_name, dt.capacity, dt.qr_token, dt.status, dt.branch_id, b.name, b.area, b.address
      ORDER BY ${orderBy}
    `, params);
    res.json(rows.map((row) => ({
      ...row,
      active_orders: Number(row.active_orders || 0),
      is_available: Number(row.active_orders || 0) === 0,
    })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getPublicTableByToken = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        dt.id,
        dt.table_number,
        dt.table_name,
        dt.capacity,
        dt.qr_token,
        dt.status,
        dt.branch_id,
        b.name AS branch_name,
        b.area AS branch_area,
        b.address AS branch_address,
        COUNT(co.id) AS active_orders
      FROM dining_tables dt
      LEFT JOIN branches b ON b.id = dt.branch_id
      LEFT JOIN customer_orders co ON co.table_id = dt.id
        AND co.status IN ('pending', 'accepted', 'preparing', 'ready')
      WHERE dt.qr_token = ? AND dt.status = 'active'
      GROUP BY dt.id, dt.table_number, dt.table_name, dt.capacity, dt.qr_token, dt.status, dt.branch_id, b.name, b.area, b.address
      LIMIT 1
    `, [req.params.token]);

    if (!rows.length) return res.status(404).json({ message: 'Meja tidak ditemukan atau sedang tidak aktif' });
    res.json({
      ...rows[0],
      active_orders: Number(rows[0].active_orders || 0),
      is_available: Number(rows[0].active_orders || 0) === 0,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getPublicMenu = async (req, res) => {
  try {
    const products = await buildPublicMenu(getRequestBranchId(req));
    res.json(products);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createOrder = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { table_token, customer_name, customer_phone, note, items, voucher_code } = req.body;

    if (!table_token) return res.status(400).json({ message: 'Token meja wajib diisi' });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Pesanan belum memiliki menu' });
    }

    const [tables] = await conn.query(
      "SELECT * FROM dining_tables WHERE qr_token = ? AND status = 'active' LIMIT 1",
      [table_token]
    );
    if (!tables.length) return res.status(404).json({ message: 'Meja tidak ditemukan atau tidak aktif' });

    await conn.beginTransaction();

    const [activeOrders] = await conn.query(`
      SELECT id, order_code
      FROM customer_orders
      WHERE table_id = ?
        AND status IN ('pending', 'accepted', 'preparing', 'ready')
      LIMIT 1
    `, [tables[0].id]);
    if (activeOrders.length) {
      const err = new Error(`Meja ini masih memiliki pesanan aktif (${activeOrders[0].order_code}). Silakan pantau status atau hubungi kasir.`);
      err.status_code = 409;
      throw err;
    }

    const orderItems = [];
    let subtotal = 0;
    const menuStock = new Map(
      (await buildPublicMenu(tables[0].branch_id || null)).map((product) => [Number(product.id), Number(product.stock || 0)])
    );

    for (const rawItem of items) {
      const qty = Math.max(1, Number(rawItem.qty || 1));
      const [products] = await conn.query('SELECT id, name, price FROM products WHERE id = ? LIMIT 1', [rawItem.product_id]);
      if (!products.length) {
        const err = new Error(`Menu dengan ID ${rawItem.product_id} tidak ditemukan`);
        err.status_code = 400;
        throw err;
      }

      const product = products[0];
      const available = menuStock.get(Number(product.id)) || 0;
      if (available < qty) {
        const err = new Error(`Stok ${product.name} di cabang ini tidak cukup (tersedia: ${available})`);
        err.status_code = 400;
        throw err;
      }
      const price = Number(product.price);
      const lineSubtotal = toMoney(price * qty);
      subtotal += lineSubtotal;
      orderItems.push({
        product_id: product.id,
        product_name: product.name,
        price,
        qty,
        subtotal: lineSubtotal,
        note: rawItem.note ? String(rawItem.note).trim() : null,
      });
    }

    subtotal = toMoney(subtotal);
    const discount = await findBestDiscount({
      executor: conn,
      subtotal,
      items: orderItems,
      voucherCode: voucher_code || '',
      customerPhone: customer_phone || '',
    });
    const discountAmount = Number(discount?.discount_amount || 0);
    const finalTotal = toMoney(subtotal - discountAmount);
    const orderCode = makeOrderCode();
    const [orderResult] = await conn.query(`
      INSERT INTO customer_orders
        (order_code, table_id, branch_id, customer_name, customer_phone, subtotal, discount_rate,
         discount_amount, final_total, discount_label, discount_program_id, voucher_code, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      orderCode,
      tables[0].id,
      tables[0].branch_id || null,
      customer_name ? String(customer_name).trim() : null,
      customer_phone ? String(customer_phone).trim() : null,
      subtotal,
      discount?.discount_rate || 0,
      discountAmount,
      finalTotal,
      discount?.discount_label || null,
      discount?.program?.id || null,
      discount?.voucher_code || null,
      note ? String(note).trim() : null,
    ]);

    const orderId = orderResult.insertId;
    for (const item of orderItems) {
      await conn.query(`
        INSERT INTO customer_order_items
          (order_id, product_id, product_name, price, qty, subtotal, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [orderId, item.product_id, item.product_name, item.price, item.qty, item.subtotal, item.note]);
    }

    if (discount?.program?.id) {
      await recordRedemption({
        executor: conn,
        program: discount.program,
        orderId,
        customerPhone: customer_phone || '',
        subtotal,
        discountAmount,
        voucherCode: discount.voucher_code,
      });
    }

    await conn.commit();

    const order = await attachOrderDetails(await getOrderRowByCode(orderCode));
    res.status(201).json({
      message: 'Pesanan berhasil dikirim ke kasir',
      data: order,
    });
  } catch (err) {
    await conn.rollback();
    res.status(err.status_code || 500).json({
      message: err.message,
      validation_errors: err.validation_errors || undefined,
    });
  } finally {
    conn.release();
  }
};

exports.getOrderByCode = async (req, res) => {
  try {
    const order = await getOrderRowByCode(req.params.orderCode);
    if (!order) return res.status(404).json({ message: 'Pesanan tidak ditemukan' });
    res.json(await attachOrderDetails(order));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.submitReview = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const order = await getOrderRowByCode(req.params.orderCode);
    if (!order) return res.status(404).json({ message: 'Pesanan tidak ditemukan' });
    if (order.status !== 'completed') {
      return res.status(400).json({ message: 'Review hanya bisa diberikan setelah pesanan selesai' });
    }
    if (order.reviewed_at) {
      return res.status(400).json({ message: 'Pesanan ini sudah direview' });
    }

    const serviceRating = Number(req.body.service_rating);
    const itemReviews = Array.isArray(req.body.items) ? req.body.items : [];
    if (serviceRating < 1 || serviceRating > 5) {
      return res.status(400).json({ message: 'Rating pelayanan wajib 1 sampai 5' });
    }

    const [orderItems] = await conn.query('SELECT * FROM customer_order_items WHERE order_id = ?', [order.id]);
    if (itemReviews.length < orderItems.length) {
      return res.status(400).json({ message: 'Semua menu yang dipesan wajib direview untuk mendapat diskon' });
    }

    await conn.beginTransaction();
    const reviewProgram = await getReviewProgram(conn);
    const reviewPhone = req.body.customer_phone || order.customer_phone || '';
    const usage = reviewProgram?.id
      ? await validateProgramUsage(conn, reviewProgram, reviewPhone)
      : { valid: true };
    if (!usage.valid) {
      const err = new Error(usage.message);
      err.status_code = 400;
      throw err;
    }

    const minMenuRating = Number(reviewProgram.min_menu_rating || 1);
    const minServiceRating = Number(reviewProgram.min_service_rating || 1);
    if (serviceRating < minServiceRating) {
      const err = new Error(`Rating pelayanan minimal ${minServiceRating} untuk klaim diskon review`);
      err.status_code = 400;
      throw err;
    }

    await conn.query(`
      INSERT INTO customer_order_reviews (order_id, service_rating, service_comment)
      VALUES (?, ?, ?)
    `, [order.id, serviceRating, req.body.service_comment ? String(req.body.service_comment).trim() : null]);

    const itemById = new Map(orderItems.map((item) => [Number(item.id), item]));
    for (const review of itemReviews) {
      const orderItemId = Number(review.order_item_id);
      const orderItem = itemById.get(orderItemId);
      const rating = Number(review.rating);
      if (!orderItem || rating < 1 || rating > 5) {
        const err = new Error('Review menu tidak valid');
        err.status_code = 400;
        throw err;
      }
      if (rating < minMenuRating) {
        const err = new Error(`Rating menu minimal ${minMenuRating} untuk klaim diskon review`);
        err.status_code = 400;
        throw err;
      }

      await conn.query(`
        INSERT INTO customer_order_item_reviews
          (order_id, order_item_id, product_id, rating, comment)
        VALUES (?, ?, ?, ?, ?)
      `, [
        order.id,
        orderItemId,
        orderItem.product_id,
        rating,
        review.comment ? String(review.comment).trim() : null,
      ]);
    }

    const reviewDiscountAmount = calculateAmount(Number(order.subtotal), reviewProgram);
    const existingDiscountAmount = Number(order.discount_amount || 0);
    const discountAmount = toMoney(Math.min(Number(order.subtotal), existingDiscountAmount + reviewDiscountAmount));
    const finalTotal = toMoney(Number(order.subtotal) - discountAmount);
    const discountRate = reviewProgram.discount_type === 'percent'
      ? Number(reviewProgram.discount_value || REVIEW_DISCOUNT_RATE)
      : Number(order.discount_rate || 0);
    const discountLabel = order.discount_label
      ? `${order.discount_label} + ${reviewProgram.name}`
      : reviewProgram.name;

    await conn.query(`
      UPDATE customer_orders
      SET discount_rate = ?,
          discount_amount = ?,
          final_total = ?,
          discount_label = ?,
          discount_program_id = COALESCE(discount_program_id, ?),
          customer_phone = COALESCE(customer_phone, ?),
          reviewed_at = NOW()
      WHERE id = ?
    `, [discountRate, discountAmount, finalTotal, discountLabel, reviewProgram.id || null, reviewPhone || null, order.id]);

    if (order.transaction_id) {
      await conn.query(`
        UPDATE transactions
        SET total_price = ?,
            discount_rate = ?,
            discount_amount = ?,
            discount_label = ?
        WHERE id = ?
      `, [finalTotal, discountRate, discountAmount, discountLabel, order.transaction_id]);
    }

    if (reviewProgram?.id && reviewDiscountAmount > 0) {
      await recordRedemption({
        executor: conn,
        program: reviewProgram,
        orderId: order.id,
        transactionId: order.transaction_id || null,
        customerPhone: reviewPhone,
        subtotal: Number(order.subtotal || 0),
        discountAmount: reviewDiscountAmount,
        createdBy: null,
      });
    }

    await conn.commit();

    const updated = await attachOrderDetails(await getOrderRowByCode(order.order_code));
    res.json({
      message: `Terima kasih atas review Anda. ${reviewProgram.name} berhasil diterapkan.`,
      discount_rate: discountRate,
      discount_amount: reviewDiscountAmount,
      data: updated,
    });
  } catch (err) {
    await conn.rollback();
    res.status(err.status_code || 500).json({ message: err.message });
  } finally {
    conn.release();
  }
};

exports.listManagedTables = async (req, res) => {
  try {
    const branchId = getRequestBranchId(req) || req.user.branch_id || null;
    const branchWhere = branchId ? 'WHERE dt.branch_id = ?' : '';
    const params = branchId ? [branchId] : [];
    const [rows] = await db.query(`
      SELECT
        dt.id,
        dt.table_number,
        dt.table_name,
        dt.capacity,
        dt.qr_token,
        dt.status,
        dt.branch_id,
        b.name AS branch_name,
        dt.note,
        dt.created_by,
        dt.created_at,
        dt.updated_at,
        COUNT(co.id) AS total_orders,
        SUM(CASE WHEN co.status NOT IN ('completed', 'cancelled') THEN 1 ELSE 0 END) AS active_orders
      FROM dining_tables dt
      LEFT JOIN branches b ON b.id = dt.branch_id
      LEFT JOIN customer_orders co ON co.table_id = dt.id
      ${branchWhere}
      GROUP BY dt.id, dt.table_number, dt.table_name, dt.capacity, dt.qr_token, dt.status, dt.branch_id, b.name, dt.note, dt.created_by, dt.created_at, dt.updated_at
      ORDER BY dt.table_number ASC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createTable = async (req, res) => {
  try {
    const payload = normalizeTablePayload(req.body);
    if (!payload.table_number) return res.status(400).json({ message: 'Nomor meja wajib diisi' });

    const [result] = await db.query(`
      INSERT INTO dining_tables
        (table_number, table_name, capacity, qr_token, status, note, branch_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      payload.table_number,
      payload.table_name,
      payload.capacity,
      makeToken(),
      payload.status,
      payload.note,
      payload.branch_id || getRequestBranchId(req) || req.user.branch_id || null,
      req.user?.id || null,
    ]);

    const [rows] = await db.query('SELECT * FROM dining_tables WHERE id = ?', [result.insertId]);
    res.status(201).json({ message: 'Meja berhasil dibuat', data: rows[0] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateTable = async (req, res) => {
  try {
    const payload = normalizeTablePayload(req.body);
    if (!payload.table_number) return res.status(400).json({ message: 'Nomor meja wajib diisi' });

    const params = [
      payload.table_number,
      payload.table_name,
      payload.capacity,
      payload.status,
      payload.note,
      payload.branch_id || getRequestBranchId(req) || req.user.branch_id || null,
    ];
    let tokenSql = '';
    if (req.body.regenerateToken) {
      tokenSql = ', qr_token = ?';
      params.push(makeToken());
    }
    params.push(req.params.id);

    const [result] = await db.query(`
      UPDATE dining_tables
      SET table_number = ?, table_name = ?, capacity = ?, status = ?, note = ?, branch_id = ?${tokenSql}
      WHERE id = ?
    `, params);

    if (!result.affectedRows) return res.status(404).json({ message: 'Meja tidak ditemukan' });
    const [rows] = await db.query('SELECT * FROM dining_tables WHERE id = ?', [req.params.id]);
    res.json({ message: 'Meja berhasil diupdate', data: rows[0] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.deleteTable = async (req, res) => {
  try {
    const [result] = await db.query("UPDATE dining_tables SET status = 'inactive' WHERE id = ?", [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Meja tidak ditemukan' });
    res.json({ message: 'Meja dinonaktifkan' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.listOrders = async (req, res) => {
  try {
    const { status, limit = 80 } = req.query;
    const branchId = getRequestBranchId(req) || req.user.branch_id || null;
    const params = [];
    let where = 'WHERE 1=1';

    if (status && VALID_ORDER_STATUSES.includes(status)) {
      where += ' AND co.status = ?';
      params.push(status);
    }
    if (branchId) {
      where += ' AND co.branch_id = ?';
      params.push(branchId);
    }

    params.push(Number(limit));
    const [orders] = await db.query(`
      SELECT co.*, dt.table_number, dt.table_name,
        u1.name AS accepted_by_name,
        u2.name AS completed_by_name,
        u3.name AS cancelled_by_name
      FROM customer_orders co
      JOIN dining_tables dt ON dt.id = co.table_id
      LEFT JOIN users u1 ON u1.id = co.accepted_by
      LEFT JOIN users u2 ON u2.id = co.completed_by
      LEFT JOIN users u3 ON u3.id = co.cancelled_by
      ${where}
      ORDER BY co.created_at DESC
      LIMIT ?
    `, params);

    const detailedOrders = [];
    for (const order of orders) {
      detailedOrders.push(await attachOrderDetails(order));
    }

    res.json(detailedOrders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateOrderStatus = async (req, res) => {
  try {
    const nextStatus = req.body.status;
    if (!STAFF_ORDER_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ message: 'Status pesanan tidak valid' });
    }

    const order = await getOrderRowById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Pesanan tidak ditemukan' });
    if (order.status === 'cancelled') return res.status(400).json({ message: 'Pesanan sudah dibatalkan' });
    if (order.status === 'completed') return res.status(400).json({ message: 'Pesanan sudah selesai' });

    const isCancelling = nextStatus === 'cancelled';
    if (isCancelling && !String(req.body.cancel_reason || '').trim()) {
      return res.status(400).json({ message: 'Alasan pembatalan wajib diisi' });
    }

    const expectedNextStatus = NEXT_STATUS_BY_CURRENT[order.status];
    if (!isCancelling && nextStatus !== expectedNextStatus) {
      return res.status(400).json({
        message: `Status harus berurutan. Dari ${order.status} hanya bisa lanjut ke ${expectedNextStatus || 'status berikutnya'}.`,
      });
    }

    let transactionResult = null;
    const shouldFulfill = nextStatus === 'accepted';
    if (shouldFulfill && !order.transaction_id) {
      transactionResult = await resolveFulfillmentTransaction({
        order,
        actorUserId: req.user.id,
        requestedSourceUserId: req.body.source_user_id || null,
      });
    }

    const updates = ['status = ?'];
    const params = [nextStatus];

    if (transactionResult?.transaction_id) {
      updates.push('transaction_id = ?');
      params.push(transactionResult.transaction_id);
    }

    if (nextStatus === 'accepted') {
      updates.push('accepted_by = ?', 'accepted_at = NOW()');
      params.push(req.user.id);
    }

    if (nextStatus === 'cancelled') {
      updates.push('cancel_reason = ?', 'cancelled_by = ?', 'cancelled_at = NOW()');
      params.push(String(req.body.cancel_reason || '').trim(), req.user.id);
    }

    if (nextStatus === 'completed') {
      updates.push('completed_by = ?', 'completed_at = NOW()', "payment_status = 'paid'");
      params.push(req.user.id);
    }

    params.push(order.id);
    await db.query(`UPDATE customer_orders SET ${updates.join(', ')} WHERE id = ?`, params);

    const updated = await attachOrderDetails(await getOrderRowById(order.id));
    res.json({
      message: 'Status pesanan berhasil diperbarui',
      data: updated,
    });
  } catch (err) {
    res.status(err.status_code || 500).json({
      message: err.message,
      validation_errors: err.validation_errors || undefined,
    });
  }
};
