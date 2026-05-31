const crypto = require('crypto');
const db = require('../config/db');
const { createTransaction } = require('../services/transactionService');
const { getUserIngredientBalances } = require('../services/stockAllocationService');
const { getRequestBranchId } = require('../utils/branchContext');
const {
  calculateAmount,
  findBestDiscount,
  getReviewProgram,
  parseBundleItems,
  recordRedemption,
  validateProgramUsage,
} = require('../services/discountService');
const {
  buildPaymentOrderFields,
  ensurePaymentTables,
  getPaymentMethodById,
  uploadPaymentAsset,
} = require('../services/paymentService');

const VALID_ORDER_STATUSES = ['pending', 'accepted', 'preparing', 'ready', 'completed', 'cancelled'];
const STAFF_ORDER_STATUSES = ['accepted', 'preparing', 'ready', 'completed', 'cancelled'];
const NEXT_STATUS_BY_CURRENT = {
  pending: 'accepted',
  accepted: 'preparing',
  preparing: 'ready',
  ready: 'completed',
};
const REVIEW_DISCOUNT_RATE = 5;
const PAYMENT_EXPIRED_REASON = 'Pesanan otomatis dibatalkan oleh sistem karena batas waktu pembayaran sudah habis.';
const TABLE_SESSION_HOLD_MINUTES = 30;
const REVIEW_PROMPT_HOLD_MINUTES = 60;
const POST_REVIEW_HOLD_MINUTES = 20;
const COMPLETED_TABLE_HOLD_MINUTES = REVIEW_PROMPT_HOLD_MINUTES + POST_REVIEW_HOLD_MINUTES;

const makeToken = () => crypto.randomBytes(24).toString('hex');
const makeOrderCode = () => `ORD-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

const toMoney = (value) => Number(Number(value || 0).toFixed(2));
const addMinutesSql = (minutes) => db.isPostgres ? `NOW() + INTERVAL '${minutes} minutes'` : `DATE_ADD(NOW(), INTERVAL ${minutes} MINUTE)`;
const nowSql = () => 'NOW()';

let ensureReviewHoldColumnPromise = null;
const ensureReviewHoldColumn = async () => {
  if (!ensureReviewHoldColumnPromise) {
    ensureReviewHoldColumnPromise = (async () => {
      if (db.isPostgres) {
        await db.query('ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS review_skipped_at TIMESTAMPTZ NULL');
        await db.query('CREATE INDEX IF NOT EXISTS idx_customer_orders_review_hold ON customer_orders(table_id, status, completed_at, reviewed_at, review_skipped_at)');
        return;
      }

      try {
        await db.query('ALTER TABLE customer_orders ADD COLUMN review_skipped_at DATETIME NULL');
      } catch (_) {}
      try {
        await db.query('CREATE INDEX idx_customer_orders_review_hold ON customer_orders(table_id, status, completed_at, reviewed_at, review_skipped_at)');
      } catch (_) {}
    })().catch((err) => {
      ensureReviewHoldColumnPromise = null;
      throw err;
    });
  }
  return ensureReviewHoldColumnPromise;
};

const buildActiveTableOrderCondition = (alias = 'co') => {
  const p = alias ? `${alias}.` : '';
  const reviewHoldCutoff = db.isPostgres
    ? `NOW() - INTERVAL '${COMPLETED_TABLE_HOLD_MINUTES} minutes'`
    : `DATE_SUB(NOW(), INTERVAL ${COMPLETED_TABLE_HOLD_MINUTES} MINUTE)`;
  const postReviewHoldCutoff = db.isPostgres
    ? `NOW() - INTERVAL '${POST_REVIEW_HOLD_MINUTES} minutes'`
    : `DATE_SUB(NOW(), INTERVAL ${POST_REVIEW_HOLD_MINUTES} MINUTE)`;
  const completedHoldCutoff = db.isPostgres
    ? `NOW() - INTERVAL '${COMPLETED_TABLE_HOLD_MINUTES} minutes'`
    : `DATE_SUB(NOW(), INTERVAL ${COMPLETED_TABLE_HOLD_MINUTES} MINUTE)`;

  return `(
    ${p}status IN ('pending', 'accepted', 'preparing', 'ready')
    OR (
      ${p}status = 'completed'
      AND ${p}completed_at IS NOT NULL
      AND (
        (${p}reviewed_at IS NULL AND ${p}review_skipped_at IS NULL AND ${p}completed_at > ${reviewHoldCutoff})
        OR (${p}reviewed_at IS NOT NULL AND ${p}reviewed_at > ${postReviewHoldCutoff} AND ${p}completed_at > ${completedHoldCutoff})
        OR (${p}review_skipped_at IS NOT NULL AND ${p}review_skipped_at > ${postReviewHoldCutoff} AND ${p}completed_at > ${completedHoldCutoff})
      )
    )
  )`;
};

let ensureTableSlotTablesPromise = null;
const ensureTableSlotTables = async () => {
  if (!ensureTableSlotTablesPromise) {
    ensureTableSlotTablesPromise = (async () => {
      if (db.isPostgres) {
        await db.query(`
          CREATE TABLE IF NOT EXISTS customer_table_sessions (
            id BIGSERIAL PRIMARY KEY,
            table_id BIGINT NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
            branch_id BIGINT NULL REFERENCES branches(id) ON DELETE SET NULL,
            session_token VARCHAR(96) NOT NULL UNIQUE,
            status VARCHAR(24) NOT NULL DEFAULT 'active',
            expires_at TIMESTAMPTZ NOT NULL,
            released_at TIMESTAMPTZ NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          )
        `);
        await db.query(`
          CREATE TABLE IF NOT EXISTS customer_table_queue (
            id BIGSERIAL PRIMARY KEY,
            branch_id BIGINT NULL REFERENCES branches(id) ON DELETE SET NULL,
            table_id BIGINT NULL REFERENCES dining_tables(id) ON DELETE SET NULL,
            queue_token VARCHAR(96) NOT NULL UNIQUE,
            customer_name VARCHAR(120) NULL,
            preference VARCHAR(24) NOT NULL DEFAULT 'random',
            status VARCHAR(24) NOT NULL DEFAULT 'waiting',
            called_session_token VARCHAR(96) NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          )
        `);
        await db.query('CREATE INDEX IF NOT EXISTS idx_customer_table_sessions_active ON customer_table_sessions(table_id, status, expires_at)');
        await db.query('CREATE INDEX IF NOT EXISTS idx_customer_table_queue_waiting ON customer_table_queue(branch_id, status, created_at)');
        return;
      }

      await db.query(`
        CREATE TABLE IF NOT EXISTS customer_table_sessions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          table_id INT NOT NULL,
          branch_id INT NULL,
          session_token VARCHAR(96) NOT NULL UNIQUE,
          status VARCHAR(24) NOT NULL DEFAULT 'active',
          expires_at DATETIME NOT NULL,
          released_at DATETIME NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_customer_table_sessions_active (table_id, status, expires_at)
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS customer_table_queue (
          id INT AUTO_INCREMENT PRIMARY KEY,
          branch_id INT NULL,
          table_id INT NULL,
          queue_token VARCHAR(96) NOT NULL UNIQUE,
          customer_name VARCHAR(120) NULL,
          preference VARCHAR(24) NOT NULL DEFAULT 'random',
          status VARCHAR(24) NOT NULL DEFAULT 'waiting',
          called_session_token VARCHAR(96) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_customer_table_queue_waiting (branch_id, status, created_at)
        )
      `);
    })().catch((err) => {
      ensureTableSlotTablesPromise = null;
      throw err;
    });
  }
  return ensureTableSlotTablesPromise;
};

const expireTableSessions = async (executor = db) => {
  await ensureTableSlotTables();
  await executor.query(`UPDATE customer_table_sessions SET status = 'expired' WHERE status = 'active' AND expires_at <= ${nowSql()}`);
};

const getActiveSessionCount = async (tableId, exceptSessionToken = '') => {
  const params = [tableId];
  let except = '';
  if (exceptSessionToken) {
    except = 'AND session_token <> ?';
    params.push(exceptSessionToken);
  }
  const [rows] = await db.query(`
    SELECT COUNT(id) AS total
    FROM customer_table_sessions
    WHERE table_id = ?
      AND status = 'active'
      AND expires_at > ${nowSql()}
      ${except}
  `, params);
  return Number(rows[0]?.total || 0);
};

const getActiveOrderCount = async (tableId) => {
  const [rows] = await db.query(`
    SELECT COUNT(id) AS total
    FROM customer_orders
    WHERE table_id = ?
      AND ${buildActiveTableOrderCondition('')}
  `, [tableId]);
  return Number(rows[0]?.total || 0);
};

const getWaitingQueueCount = async (branchId = null) => {
  const params = [];
  const branchWhere = branchId ? 'AND branch_id = ?' : '';
  if (branchId) params.push(branchId);
  const [rows] = await db.query(`
    SELECT COUNT(id) AS total
    FROM customer_table_queue
    WHERE status = 'waiting'
      ${branchWhere}
  `, params);
  return Number(rows[0]?.total || 0);
};

const estimateReleaseAt = (row) => {
  const sessionExpiry = row.active_session_expires_at ? new Date(row.active_session_expires_at).getTime() : 0;
  const completedAt = row.active_order_completed_at ? new Date(row.active_order_completed_at).getTime() : 0;
  const reviewedAt = row.active_order_reviewed_at ? new Date(row.active_order_reviewed_at).getTime() : 0;
  const skippedAt = row.active_order_review_skipped_at ? new Date(row.active_order_review_skipped_at).getTime() : 0;
  const createdAt = row.active_order_created_at ? new Date(row.active_order_created_at).getTime() : 0;
  const candidates = [sessionExpiry].filter(Boolean);
  const completedHoldExpiry = completedAt ? completedAt + COMPLETED_TABLE_HOLD_MINUTES * 60 * 1000 : 0;
  if (reviewedAt) candidates.push(Math.min(reviewedAt + POST_REVIEW_HOLD_MINUTES * 60 * 1000, completedHoldExpiry || reviewedAt + POST_REVIEW_HOLD_MINUTES * 60 * 1000));
  if (skippedAt) candidates.push(Math.min(skippedAt + POST_REVIEW_HOLD_MINUTES * 60 * 1000, completedHoldExpiry || skippedAt + POST_REVIEW_HOLD_MINUTES * 60 * 1000));
  if (completedAt && !reviewedAt && !skippedAt) candidates.push(completedHoldExpiry);
  if (createdAt && !completedAt) candidates.push(createdAt + COMPLETED_TABLE_HOLD_MINUTES * 60 * 1000);
  const max = Math.max(...candidates, 0);
  return max ? new Date(max).toISOString() : null;
};

const findAvailableTableForQueue = async ({ branchId = null, preferredTableId = null } = {}) => {
  await expireTableSessions();
  const params = [];
  let where = "WHERE dt.status = 'active'";
  if (branchId) {
    where += ' AND dt.branch_id = ?';
    params.push(branchId);
  }
  if (preferredTableId) {
    where += ' AND dt.id = ?';
    params.push(preferredTableId);
  }
  const [tables] = await db.query(`SELECT dt.* FROM dining_tables dt ${where} ORDER BY dt.table_number ASC, dt.id ASC`, params);
  for (const table of tables) {
    const [orderCount, sessionCount] = await Promise.all([
      getActiveOrderCount(table.id),
      getActiveSessionCount(table.id),
    ]);
    if (orderCount === 0 && sessionCount === 0) return table;
  }
  return null;
};

const expireOverduePaymentOrders = async (executor = db, { orderId = null, tableId = null, branchId = null } = {}) => {
  const params = [];
  let where = `
    WHERE status = 'pending'
      AND payment_method_id IS NOT NULL
      AND payment_status = 'unpaid'
      AND payment_proof_url IS NULL
      AND payment_due_at IS NOT NULL
      AND payment_due_at <= NOW()
  `;

  if (orderId) {
    where += ' AND id = ?';
    params.push(orderId);
  }
  if (tableId) {
    where += ' AND table_id = ?';
    params.push(tableId);
  }
  if (branchId) {
    where += ' AND branch_id = ?';
    params.push(branchId);
  }

  const [expiredOrders] = await executor.query(
    `SELECT id FROM customer_orders ${where}`,
    params
  );
  const expiredIds = expiredOrders.map((order) => Number(order.id)).filter(Boolean);
  if (!expiredIds.length) return { expiredCount: 0, expiredIds: [] };

  const placeholders = expiredIds.map(() => '?').join(',');
  await executor.query(`
    UPDATE customer_orders
    SET status = 'cancelled',
        cancel_reason = ?,
        cancelled_by = NULL,
        cancelled_at = NOW()
    WHERE id IN (${placeholders})
  `, [PAYMENT_EXPIRED_REASON, ...expiredIds]);

  await executor.query(
    `DELETE FROM discount_redemptions WHERE order_id IN (${placeholders})`,
    expiredIds
  );

  return { expiredCount: expiredIds.length, expiredIds };
};

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
  const [discountBreakdown] = await db.query(`
    SELECT dr.program_id, dr.subtotal AS discount_base, dr.discount_amount,
      dr.voucher_code, dp.name AS label, dp.type, dp.discount_type,
      dp.discount_value, dp.bundle_product_ids
    FROM discount_redemptions dr
    JOIN discount_programs dp ON dp.id = dr.program_id
    WHERE dr.order_id = ?
    ORDER BY dr.id ASC
  `, [order.id]);
  const [paymentMethods] = order.payment_method_id
    ? await db.query('SELECT * FROM payment_methods WHERE id = ? LIMIT 1', [order.payment_method_id])
    : [[]];

  const reviewByItemId = itemReviews.reduce((acc, review) => {
    acc[review.order_item_id] = review;
    return acc;
  }, {});

  return {
    ...order,
    discount_bundle_items: parseBundleItems(order.discount_bundle_product_ids),
    payment_method: paymentMethods[0] || (order.payment_method_key ? {
      id: order.payment_method_id,
      method_key: order.payment_method_key,
      name: order.payment_method_name,
    } : null),
    discount_breakdown: discountBreakdown.map((item) => ({
      ...item,
      discount_value: Number(item.discount_value || 0),
      discount_base: Number(item.discount_base || 0),
      discount_amount: Number(item.discount_amount || 0),
      bundle_items: parseBundleItems(item.bundle_product_ids),
    })),
    items: items.map((item) => ({
      ...item,
      review: reviewByItemId[item.id] || null,
    })),
    service_review: serviceReviews[0] || null,
  };
};

const getOrderRowByCode = async (orderCode) => {
  const [rows] = await db.query(`
    SELECT co.*, dt.table_number, dt.table_name,
      dp.type AS discount_program_type,
      dp.bundle_product_ids AS discount_bundle_product_ids
    FROM customer_orders co
    JOIN dining_tables dt ON dt.id = co.table_id
    LEFT JOIN discount_programs dp ON dp.id = co.discount_program_id
    WHERE co.order_code = ?
    LIMIT 1
  `, [orderCode]);
  return rows[0] || null;
};

const getOrderRowById = async (id) => {
  const [rows] = await db.query(`
    SELECT co.*, dt.table_number, dt.table_name,
      dp.type AS discount_program_type,
      dp.bundle_product_ids AS discount_bundle_product_ids
    FROM customer_orders co
    JOIN dining_tables dt ON dt.id = co.table_id
    LEFT JOIN discount_programs dp ON dp.id = co.discount_program_id
    WHERE co.id = ?
    LIMIT 1
  `, [id]);
  return rows[0] || null;
};

const groupIngredientsByProductId = (rows) => rows.reduce((acc, row) => {
  const productId = Number(row.product_id);
  if (!acc[productId]) acc[productId] = [];
  acc[productId].push(row);
  return acc;
}, {});

const calculateCanMake = (ingredients, balances) => {
  if (!ingredients.length) return 0;
  return Math.min(...ingredients.map((ingredient) => {
    const available = balances[Number(ingredient.stock_item_id)] || 0;
    return Math.floor(available / Number(ingredient.qty || 1));
  }));
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
  const productIds = products.map((product) => Number(product.id)).filter(Boolean);
  const ingredientsByProductId = {};

  if (productIds.length) {
    const placeholders = productIds.map(() => '?').join(',');
    const [ingredientRows] = await db.query(`
      SELECT pi.product_id, pi.qty, si.id AS stock_item_id, si.name AS ingredient_name, si.unit
      FROM product_ingredients pi
      JOIN stock_items si ON pi.stock_item_id = si.id
      WHERE pi.product_id IN (${placeholders})
      ORDER BY pi.product_id ASC, pi.id ASC
    `, productIds);
    Object.assign(ingredientsByProductId, groupIngredientsByProductId(ingredientRows));
  }

  const stockItemIds = [
    ...new Set(Object.values(ingredientsByProductId)
      .flat()
      .map((ingredient) => Number(ingredient.stock_item_id))
      .filter(Boolean)),
  ];
  const userBalances = await getUserIngredientBalances(
    db,
    stockItemIds,
    stockUsers.map((user) => user.id),
    branchId
  );

  for (const product of products) {
    const ingredients = ingredientsByProductId[Number(product.id)] || [];

    product.ingredients = ingredients;

    if (!ingredients.length) {
      product.stock = 0;
      continue;
    }

    let bestReadyStock = 0;
    let bestReadyUser = null;
    const stockByUser = [];

    for (const user of stockUsers) {
      const ready = calculateCanMake(ingredients, userBalances[Number(user.id)] || {});
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

const getReadyStockForProducts = async (executor, productIds = [], branchId = null) => {
  const ids = [...new Set((productIds || []).map((id) => Number(id)).filter(Boolean))];
  if (!ids.length) return new Map();

  const [stockUsers] = await executor.query(
    "SELECT id, name, role FROM users WHERE role IN ('kasir', 'admin') ORDER BY role DESC, name ASC"
  );
  if (!stockUsers.length) return new Map(ids.map((id) => [id, 0]));

  const placeholders = ids.map(() => '?').join(',');
  const [ingredientRows] = await executor.query(`
    SELECT pi.product_id, pi.qty, si.id AS stock_item_id
    FROM product_ingredients pi
    JOIN stock_items si ON pi.stock_item_id = si.id
    WHERE pi.product_id IN (${placeholders})
    ORDER BY pi.product_id ASC, pi.id ASC
  `, ids);

  const ingredientsByProductId = groupIngredientsByProductId(ingredientRows);
  const stockItemIds = [
    ...new Set(ingredientRows.map((ingredient) => Number(ingredient.stock_item_id)).filter(Boolean)),
  ];
  const userBalances = await getUserIngredientBalances(
    executor,
    stockItemIds,
    stockUsers.map((user) => user.id),
    branchId
  );

  return new Map(ids.map((productId) => {
    const ingredients = ingredientsByProductId[Number(productId)] || [];
    if (!ingredients.length) return [Number(productId), 0];
    const bestReadyStock = stockUsers.reduce((best, user) => {
      const ready = calculateCanMake(ingredients, userBalances[Number(user.id)] || {});
      return Math.max(best, ready);
    }, 0);
    return [Number(productId), bestReadyStock];
  }));
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
    await ensureReviewHoldColumn();
    await ensureTableSlotTables();
    await expireTableSessions();
    await expireOverduePaymentOrders(db, { branchId });
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
        COUNT(DISTINCT co.id) AS active_order_count,
        COUNT(DISTINCT cts.id) AS active_session_count,
        MAX(co.created_at) AS active_order_created_at,
        MAX(co.completed_at) AS active_order_completed_at,
        MAX(co.reviewed_at) AS active_order_reviewed_at,
        MAX(co.review_skipped_at) AS active_order_review_skipped_at,
        MAX(cts.expires_at) AS active_session_expires_at
      FROM dining_tables dt
      LEFT JOIN branches b ON b.id = dt.branch_id
      LEFT JOIN customer_orders co ON co.table_id = dt.id
        AND ${buildActiveTableOrderCondition('co')}
      LEFT JOIN customer_table_sessions cts ON cts.table_id = dt.id
        AND cts.status = 'active'
        AND cts.expires_at > ${nowSql()}
      WHERE dt.status = 'active'
        ${branchWhere}
      GROUP BY dt.id, dt.table_number, dt.table_name, dt.capacity, dt.qr_token, dt.status, dt.branch_id, b.name, b.area, b.address
      ORDER BY ${orderBy}
    `, params);
    const queueWaitingCount = await getWaitingQueueCount(branchId);
    res.json(rows.map((row) => ({
      ...row,
      active_order_count: Number(row.active_order_count || 0),
      active_session_count: Number(row.active_session_count || 0),
      active_orders: Number(row.active_order_count || 0) + Number(row.active_session_count || 0),
      queue_waiting_count: queueWaitingCount,
      estimated_release_at: estimateReleaseAt(row),
      is_available: Number(row.active_order_count || 0) + Number(row.active_session_count || 0) === 0 && queueWaitingCount === 0,
    })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getPublicTableByToken = async (req, res) => {
  try {
    await ensureReviewHoldColumn();
    await ensureTableSlotTables();
    await expireTableSessions();
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
        b.address AS branch_address
      FROM dining_tables dt
      LEFT JOIN branches b ON b.id = dt.branch_id
      WHERE dt.qr_token = ? AND dt.status = 'active'
      LIMIT 1
    `, [req.params.token]);

    if (!rows.length) return res.status(404).json({ message: 'Meja tidak ditemukan atau sedang tidak aktif' });
    await expireOverduePaymentOrders(db, { tableId: rows[0].id });
    let activeOrders = 0;
    let activeSessions = 0;
    try {
      const [orderRows] = await db.query(`
        SELECT COUNT(id) AS active_orders
        FROM customer_orders
        WHERE table_id = ?
          AND ${buildActiveTableOrderCondition('')}
      `, [rows[0].id]);
      activeOrders = Number(orderRows[0]?.active_orders || 0);
    } catch (_) {
      activeOrders = 0;
    }
    try {
      activeSessions = await getActiveSessionCount(rows[0].id, req.query.session_token || '');
    } catch (_) {
      activeSessions = 0;
    }

    res.json({
      ...rows[0],
      active_order_count: activeOrders,
      active_session_count: activeSessions,
      active_orders: activeOrders + activeSessions,
      is_available: activeOrders + activeSessions === 0,
    });
  } catch (_) {
    res.status(500).json({ message: 'Gagal mengambil data meja' });
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

exports.createOrRenewTableSession = async (req, res) => {
  try {
    await ensureReviewHoldColumn();
    await ensureTableSlotTables();
    await expireTableSessions();
    const requestedToken = req.body.session_token || '';
    const [tables] = await db.query("SELECT * FROM dining_tables WHERE qr_token = ? AND status = 'active' LIMIT 1", [req.params.token]);
    if (!tables.length) return res.status(404).json({ message: 'Meja tidak ditemukan atau sedang tidak aktif' });
    const table = tables[0];

    const activeOrderCount = await getActiveOrderCount(table.id);
    if (activeOrderCount > 0) return res.status(409).json({ message: 'Meja ini sedang memiliki pesanan aktif' });

    if (requestedToken) {
      const [existing] = await db.query(`
        SELECT * FROM customer_table_sessions
        WHERE session_token = ? AND table_id = ? AND status = 'active' AND expires_at > ${nowSql()}
        LIMIT 1
      `, [requestedToken, table.id]);
      if (existing.length) {
        await db.query(`UPDATE customer_table_sessions SET expires_at = ${addMinutesSql(TABLE_SESSION_HOLD_MINUTES)} WHERE id = ?`, [existing[0].id]);
        const [updated] = await db.query('SELECT * FROM customer_table_sessions WHERE id = ? LIMIT 1', [existing[0].id]);
        return res.json({ message: 'Slot meja diperpanjang', data: updated[0] });
      }
      const [staleRows] = await db.query(`
        SELECT id FROM customer_table_sessions
        WHERE session_token = ? AND table_id = ?
        LIMIT 1
      `, [requestedToken, table.id]);
      if (staleRows.length) {
        return res.status(409).json({ message: 'Slot meja sudah habis. Silakan pilih meja ulang.' });
      }
    }

    const waitingCount = await getWaitingQueueCount(table.branch_id || null);
    if (waitingCount > 0 && !req.body.queue_token) {
      return res.status(409).json({ message: 'Masih ada antrian pelanggan. Silakan ambil nomor antrian terlebih dahulu.' });
    }

    const activeSessionCount = await getActiveSessionCount(table.id, requestedToken);
    if (activeSessionCount > 0) return res.status(409).json({ message: 'Meja ini sedang dipilih pelanggan lain' });

    const sessionToken = requestedToken || crypto.randomBytes(24).toString('hex');
    const [result] = await db.query(`
      INSERT INTO customer_table_sessions (table_id, branch_id, session_token, status, expires_at)
      VALUES (?, ?, ?, 'active', ${addMinutesSql(TABLE_SESSION_HOLD_MINUTES)})
    `, [table.id, table.branch_id || null, sessionToken]);
    const [rows] = await db.query('SELECT * FROM customer_table_sessions WHERE id = ? LIMIT 1', [result.insertId]);
    res.status(201).json({ message: 'Slot meja aktif selama 30 menit', data: rows[0] });
  } catch (err) {
    res.status(err.status_code || 500).json({ message: err.message || 'Gagal membuat slot meja' });
  }
};

exports.releaseTableSession = async (req, res) => {
  try {
    await ensureTableSlotTables();
    await db.query(`UPDATE customer_table_sessions SET status = 'released', released_at = ${nowSql()} WHERE session_token = ? AND status = 'active'`, [req.params.sessionToken]);
    res.json({ message: 'Slot meja dilepas' });
  } catch (_) {
    res.status(500).json({ message: 'Gagal melepas slot meja' });
  }
};

exports.getTableQueue = async (req, res) => {
  try {
    await ensureTableSlotTables();
    await expireTableSessions();
    const branchId = getRequestBranchId(req);
    const queueToken = req.query.queue_token || '';
    const params = [];
    const branchWhere = branchId ? 'AND q.branch_id = ?' : '';
    if (branchId) params.push(branchId);
    const [rows] = await db.query(`
      SELECT q.*, dt.table_number
      FROM customer_table_queue q
      LEFT JOIN dining_tables dt ON dt.id = q.table_id
      WHERE q.status = 'waiting'
        ${branchWhere}
      ORDER BY q.created_at ASC, q.id ASC
    `, params);
    const availableTable = await findAvailableTableForQueue({ branchId });
    const position = queueToken ? rows.findIndex((row) => row.queue_token === queueToken) + 1 : 0;
    res.json({
      waiting_count: rows.length,
      has_queue: rows.length > 0,
      queue: rows.map((row, index) => ({ ...row, position: index + 1 })),
      current_position: position,
      can_claim: Boolean(queueToken && position === 1 && availableTable),
      available_table: availableTable ? {
        id: availableTable.id,
        table_number: availableTable.table_number,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Gagal mengambil antrian' });
  }
};

exports.joinTableQueue = async (req, res) => {
  try {
    await ensureTableSlotTables();
    await expireTableSessions();
    const branchId = req.body.branch_id ? Number(req.body.branch_id) : getRequestBranchId(req);
    const tableId = req.body.table_id ? Number(req.body.table_id) : null;
    const preference = tableId ? 'selected' : 'random';
    const queueToken = crypto.randomBytes(24).toString('hex');
    const [result] = await db.query(`
      INSERT INTO customer_table_queue (branch_id, table_id, queue_token, customer_name, preference, status)
      VALUES (?, ?, ?, ?, ?, 'waiting')
    `, [branchId || null, tableId || null, queueToken, req.body.customer_name ? String(req.body.customer_name).trim() : null, preference]);
    const [rows] = await db.query('SELECT * FROM customer_table_queue WHERE id = ? LIMIT 1', [result.insertId]);
    res.status(201).json({ message: 'Anda masuk antrian meja', data: rows[0] });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Gagal masuk antrian' });
  }
};

exports.claimTableQueue = async (req, res) => {
  try {
    await ensureTableSlotTables();
    await expireTableSessions();
    const queueToken = req.params.queueToken;
    const [queueRows] = await db.query("SELECT * FROM customer_table_queue WHERE queue_token = ? AND status = 'waiting' LIMIT 1", [queueToken]);
    if (!queueRows.length) return res.status(404).json({ message: 'Antrian tidak ditemukan' });
    const queue = queueRows[0];
    const [firstRows] = await db.query(`
      SELECT * FROM customer_table_queue
      WHERE status = 'waiting' AND ${queue.branch_id ? 'branch_id = ?' : 'branch_id IS NULL'}
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `, queue.branch_id ? [queue.branch_id] : []);
    if (!firstRows.length || firstRows[0].queue_token !== queueToken) {
      return res.status(409).json({ message: 'Belum giliran antrian Anda' });
    }
    const table = await findAvailableTableForQueue({ branchId: queue.branch_id || null, preferredTableId: queue.table_id || null });
    if (!table) return res.status(409).json({ message: 'Belum ada meja kosong untuk antrian Anda' });
    const sessionToken = crypto.randomBytes(24).toString('hex');
    const [sessionResult] = await db.query(`
      INSERT INTO customer_table_sessions (table_id, branch_id, session_token, status, expires_at)
      VALUES (?, ?, ?, 'active', ${addMinutesSql(TABLE_SESSION_HOLD_MINUTES)})
    `, [table.id, table.branch_id || null, sessionToken]);
    await db.query("UPDATE customer_table_queue SET status = 'called', called_session_token = ? WHERE id = ?", [sessionToken, queue.id]);
    const [sessionRows] = await db.query('SELECT * FROM customer_table_sessions WHERE id = ? LIMIT 1', [sessionResult.insertId]);
    res.json({
      message: 'Slot meja dari antrian berhasil diambil',
      data: {
        session: sessionRows[0],
        table: {
          ...table,
          active_orders: 1,
          is_available: false,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Gagal mengambil slot antrian' });
  }
};

exports.createOrder = async (req, res) => {
  let conn;
  try {
    await ensureReviewHoldColumn();
    await ensureTableSlotTables();
    await expireTableSessions();
    await ensurePaymentTables();
    const { table_token, table_session_token, customer_name, customer_phone, note, items, voucher_code, payment_method_id } = req.body;

    if (!table_token) return res.status(400).json({ message: 'Token meja wajib diisi' });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Pesanan belum memiliki menu' });
    }

    conn = await db.getConnection();
    const [tables] = await conn.query(
      "SELECT * FROM dining_tables WHERE qr_token = ? AND status = 'active' LIMIT 1",
      [table_token]
    );
    if (!tables.length) return res.status(404).json({ message: 'Meja tidak ditemukan atau tidak aktif' });
    const activeSessionCount = await getActiveSessionCount(tables[0].id, table_session_token || '');
    if (activeSessionCount > 0) return res.status(409).json({ message: 'Meja ini sedang dipilih pelanggan lain' });
    if (table_session_token) {
      const [sessionRows] = await conn.query(`
        SELECT id FROM customer_table_sessions
        WHERE table_id = ? AND session_token = ? AND status = 'active' AND expires_at > ${nowSql()}
        LIMIT 1
      `, [tables[0].id, table_session_token]);
      if (!sessionRows.length) return res.status(409).json({ message: 'Slot meja sudah habis. Silakan pilih meja ulang.' });
    }

    await conn.beginTransaction();
    await expireOverduePaymentOrders(conn, { tableId: tables[0].id });

    const [activeOrders] = await conn.query(`
      SELECT id, order_code
      FROM customer_orders
      WHERE table_id = ?
        AND ${buildActiveTableOrderCondition('')}
      LIMIT 1
    `, [tables[0].id]);
    if (activeOrders.length) {
      const err = new Error(`Meja ini masih memiliki pesanan aktif (${activeOrders[0].order_code}). Silakan pantau status atau hubungi kasir.`);
      err.status_code = 409;
      throw err;
    }

    const requestedByProductId = new Map();
    for (const rawItem of items) {
      const productId = Number(rawItem.product_id);
      if (!productId) continue;
      const previous = requestedByProductId.get(productId);
      requestedByProductId.set(productId, {
        product_id: productId,
        qty: Number(previous?.qty || 0) + Math.max(1, Number(rawItem.qty || 1)),
        note: previous?.note || (rawItem.note ? String(rawItem.note).trim() : null),
      });
    }
    const requestedItems = [...requestedByProductId.values()];
    if (!requestedItems.length) {
      const err = new Error('Pesanan belum memiliki menu valid');
      err.status_code = 400;
      throw err;
    }

    const requestedProductIds = requestedItems.map((item) => item.product_id);
    const placeholders = requestedProductIds.map(() => '?').join(',');
    const [products] = await conn.query(
      `SELECT id, name, price FROM products WHERE id IN (${placeholders})`,
      requestedProductIds
    );
    const productById = new Map(products.map((product) => [Number(product.id), product]));
    const readyStockByProduct = await getReadyStockForProducts(
      conn,
      requestedProductIds,
      tables[0].branch_id || null
    );

    const orderItems = [];
    let subtotal = 0;

    for (const rawItem of requestedItems) {
      const qty = Math.max(1, Number(rawItem.qty || 1));
      const product = productById.get(Number(rawItem.product_id));
      if (!product) {
        const err = new Error(`Menu dengan ID ${rawItem.product_id} tidak ditemukan`);
        err.status_code = 400;
        throw err;
      }

      const available = readyStockByProduct.get(Number(product.id)) || 0;
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
        note: rawItem.note || null,
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
    const paymentMethod = payment_method_id
      ? await getPaymentMethodById(payment_method_id, { activeOnly: true })
      : null;
    if (payment_method_id && !paymentMethod) {
      const err = new Error('Metode pembayaran tidak tersedia');
      err.status_code = 400;
      throw err;
    }
    const paymentFields = buildPaymentOrderFields(paymentMethod);
    const orderCode = makeOrderCode();
    const paymentDueSql = paymentFields.paymentDueAtSql || 'NULL';
    const [orderResult] = await conn.query(`
      INSERT INTO customer_orders
        (order_code, table_id, branch_id, customer_name, customer_phone, subtotal, discount_rate,
         discount_amount, final_total, discount_label, discount_program_id, voucher_code, note,
         payment_method_id, payment_method_key, payment_method_name, payment_due_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${paymentDueSql})
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
      paymentFields.paymentMethodId,
      paymentFields.paymentMethodKey,
      paymentFields.paymentMethodName,
    ]);

    const orderId = orderResult.insertId;
    for (const item of orderItems) {
      await conn.query(`
        INSERT INTO customer_order_items
          (order_id, product_id, product_name, price, qty, subtotal, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [orderId, item.product_id, item.product_name, item.price, item.qty, item.subtotal, item.note]);
    }

    for (const component of (discount?.components || [])) {
      await recordRedemption({
        executor: conn,
        program: component.program,
        orderId,
        customerPhone: customer_phone || '',
        subtotal: component.discount_base,
        discountAmount: component.discount_amount,
        voucherCode: component.voucher_code,
      });
    }
    if (table_session_token) {
      await conn.query(`UPDATE customer_table_sessions SET status = 'released', released_at = ${nowSql()} WHERE session_token = ?`, [table_session_token]);
    }

    await conn.commit();

    const order = await attachOrderDetails(await getOrderRowByCode(orderCode));
    res.status(201).json({
      message: 'Pesanan berhasil dikirim ke kasir',
      data: order,
    });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch (_) {}
    }
    res.status(err.status_code || 500).json({
      message: err.message,
      validation_errors: err.validation_errors || undefined,
    });
  } finally {
    if (conn) conn.release();
  }
};

exports.getOrderByCode = async (req, res) => {
  try {
    await ensureReviewHoldColumn();
    let order = await getOrderRowByCode(req.params.orderCode);
    if (!order) return res.status(404).json({ message: 'Pesanan tidak ditemukan' });
    await expireOverduePaymentOrders(db, { orderId: order.id });
    order = await getOrderRowByCode(req.params.orderCode);
    res.json(await attachOrderDetails(order));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.submitPaymentProof = async (req, res) => {
  try {
    await ensureReviewHoldColumn();
    await ensurePaymentTables();
    if (!req.file) return res.status(400).json({ message: 'Bukti pembayaran wajib dilampirkan' });

    const order = await getOrderRowByCode(req.params.orderCode);
    if (!order) return res.status(404).json({ message: 'Pesanan tidak ditemukan' });
    const expired = await expireOverduePaymentOrders(db, { orderId: order.id });
    if (expired.expiredCount > 0) {
      return res.status(400).json({ message: 'Batas waktu pembayaran sudah berakhir dan pesanan otomatis dibatalkan.' });
    }
    if (order.status === 'cancelled') return res.status(400).json({ message: 'Pesanan sudah dibatalkan' });
    if (order.payment_status === 'paid') return res.status(400).json({ message: 'Pesanan sudah dibayar' });

    if (order.payment_due_at && new Date(order.payment_due_at).getTime() < Date.now()) {
      return res.status(400).json({ message: 'Batas waktu pembayaran sudah berakhir. Silakan hubungi kasir.' });
    }

    const proofUrl = await uploadPaymentAsset({
      file: req.file,
      folder: 'payments',
      prefix: `proof-${order.order_code}`,
    });

    await db.query(`
      UPDATE customer_orders
      SET payment_proof_url = ?,
          payment_proof_note = ?,
          payment_submitted_at = NOW()
      WHERE id = ?
    `, [
      proofUrl,
      req.body.note ? String(req.body.note).trim() : null,
      order.id,
    ]);

    const updated = await attachOrderDetails(await getOrderRowByCode(order.order_code));
    res.json({
      message: 'Bukti pembayaran berhasil dikirim. Kasir akan melakukan konfirmasi.',
      data: updated,
    });
  } catch (_) {
    res.status(500).json({ message: 'Gagal mengirim bukti pembayaran' });
  }
};

exports.submitReview = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await ensureReviewHoldColumn();
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
    let rewardEligible = Boolean(reviewProgram?.id);
    let rewardMessage = rewardEligible
      ? `${reviewProgram.name} berhasil diterapkan.`
      : 'Program voucher review sedang tidak aktif, review tetap tersimpan tanpa voucher.';

    if (rewardEligible) {
      const usage = await validateProgramUsage(conn, reviewProgram, reviewPhone);
      if (!usage.valid) {
        rewardEligible = false;
        rewardMessage = `${usage.message}. Review tetap tersimpan tanpa voucher.`;
      }
    }

    const minMenuRating = Number(reviewProgram?.min_menu_rating || 1);
    const minServiceRating = Number(reviewProgram?.min_service_rating || 1);
    if (rewardEligible && serviceRating < minServiceRating) {
      rewardEligible = false;
      rewardMessage = `Rating pelayanan minimal ${minServiceRating} untuk klaim voucher. Review tetap tersimpan tanpa voucher.`;
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
      if (rewardEligible && rating < minMenuRating) {
        rewardEligible = false;
        rewardMessage = `Rating menu minimal ${minMenuRating} untuk klaim voucher. Review tetap tersimpan tanpa voucher.`;
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

    if (!rewardEligible) {
      await conn.query(`
        UPDATE customer_orders
        SET customer_phone = COALESCE(customer_phone, ?),
            reviewed_at = NOW(),
            review_skipped_at = NULL
        WHERE id = ?
      `, [reviewPhone || null, order.id]);

      await conn.commit();

      const updated = await attachOrderDetails(await getOrderRowByCode(order.order_code));
      return res.json({
        message: `Terima kasih atas review Anda. ${rewardMessage}`,
        discount_rate: 0,
        discount_amount: 0,
        data: updated,
      });
    }

    const [[bundleScope]] = await conn.query(`
      SELECT COALESCE(SUM(dr.subtotal), 0) AS bundle_base
      FROM discount_redemptions dr
      JOIN discount_programs dp ON dp.id = dr.program_id
      WHERE dr.order_id = ? AND dp.type = 'bundle'
    `, [order.id]);
    const reviewDiscountBase = toMoney(Math.max(0, Number(order.subtotal || 0) - Number(bundleScope?.bundle_base || 0)));
    const reviewDiscountAmount = calculateAmount(reviewDiscountBase, reviewProgram);
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
          reviewed_at = NOW(),
          review_skipped_at = NULL
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
        subtotal: reviewDiscountBase,
        discountAmount: reviewDiscountAmount,
        createdBy: null,
      });
    }

    await conn.commit();

    const updated = await attachOrderDetails(await getOrderRowByCode(order.order_code));
    res.json({
      message: `Terima kasih atas review Anda. ${rewardMessage}`,
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

exports.skipReview = async (req, res) => {
  try {
    await ensureReviewHoldColumn();
    const order = await getOrderRowByCode(req.params.orderCode);
    if (!order) return res.status(404).json({ message: 'Pesanan tidak ditemukan' });
    if (order.status !== 'completed') {
      return res.status(400).json({ message: 'Review hanya bisa dilewati setelah pesanan selesai' });
    }
    if (order.reviewed_at) {
      return res.status(400).json({ message: 'Pesanan ini sudah direview' });
    }

    await db.query(
      'UPDATE customer_orders SET review_skipped_at = COALESCE(review_skipped_at, NOW()) WHERE id = ?',
      [order.id]
    );

    const updated = await attachOrderDetails(await getOrderRowByCode(order.order_code));
    res.json({
      message: 'Review dilewati. Meja akan tersedia kembali setelah cooldown selesai.',
      data: updated,
    });
  } catch (err) {
    res.status(err.status_code || 500).json({ message: err.message || 'Gagal melewati review' });
  }
};

exports.listManagedTables = async (req, res) => {
  try {
    const branchId = getRequestBranchId(req) || req.user.branch_id || null;
    await ensureReviewHoldColumn();
    await expireOverduePaymentOrders(db, { branchId });
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
        SUM(CASE WHEN ${buildActiveTableOrderCondition('co')} THEN 1 ELSE 0 END) AS active_orders
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
    await expireOverduePaymentOrders(db, { branchId });
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
  const conn = await db.getConnection();
  try {
    await ensureReviewHoldColumn();
    const nextStatus = req.body.status;
    if (!STAFF_ORDER_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ message: 'Status pesanan tidak valid' });
    }

    const [orderRows] = await conn.query(`
      SELECT co.*, dt.table_number, dt.table_name
      FROM customer_orders co
      JOIN dining_tables dt ON dt.id = co.table_id
      WHERE co.id = ?
      LIMIT 1
    `, [req.params.id]);
    const order = orderRows[0] || null;
    if (!order) return res.status(404).json({ message: 'Pesanan tidak ditemukan' });
    const expired = await expireOverduePaymentOrders(conn, { orderId: order.id });
    if (expired.expiredCount > 0) {
      return res.status(400).json({ message: 'Batas waktu pembayaran sudah habis dan pesanan otomatis dibatalkan.' });
    }
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
    if (shouldFulfill && order.payment_method_id && order.payment_status !== 'paid' && !order.payment_proof_url) {
      return res.status(400).json({
        message: 'Bukti pembayaran belum dikirim pelanggan. Tunggu upload bukti pembayaran sebelum pesanan diterima.',
      });
    }
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
      if (order.payment_method_id && order.payment_proof_url) {
        updates.push("payment_status = 'paid'");
      }
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
    await conn.beginTransaction();
    await conn.query(`UPDATE customer_orders SET ${updates.join(', ')} WHERE id = ?`, params);

    if (isCancelling) {
      await conn.query(
        'DELETE FROM discount_redemptions WHERE order_id = ?',
        [order.id]
      );
    }

    await conn.commit();

    const updated = await attachOrderDetails(await getOrderRowById(order.id));
    res.json({
      message: 'Status pesanan berhasil diperbarui',
      data: updated,
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    res.status(err.status_code || 500).json({
      message: err.message,
      validation_errors: err.validation_errors || undefined,
    });
  } finally {
    conn.release();
  }
};
