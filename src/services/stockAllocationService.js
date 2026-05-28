const getUserIngredientBalance = async (executor, stockItemId, userId, branchId = null) => {
  if (!stockItemId || !userId) return 0;

  const approvedBranchWhere = branchId ? 'AND sr.branch_id = ?' : '';
  const approvedParams = [userId, stockItemId];
  if (branchId) approvedParams.push(branchId);

  const [[approved]] = await executor.query(`
    SELECT COALESCE(SUM(COALESCE(sri.qty_approved, sri.qty_requested)), 0) AS total
    FROM stock_requests sr
    JOIN stock_request_items sri ON sri.request_id = sr.id
    WHERE sr.user_id = ?
      AND sr.status = 'approved'
      AND sri.stock_item_id = ?
      ${approvedBranchWhere}
  `, approvedParams);

  const consumedBranchWhere = branchId ? 'AND t.branch_id = ?' : '';
  const consumedParams = [stockItemId, userId];
  if (branchId) consumedParams.push(branchId);

  const [[consumed]] = await executor.query(`
    SELECT COALESCE(SUM(ti.qty * pi.qty), 0) AS total
    FROM transactions t
    JOIN transaction_items ti ON ti.transaction_id = t.id
    JOIN product_ingredients pi ON pi.product_id = ti.product_id
    WHERE pi.stock_item_id = ?
      AND COALESCE(t.source_user_id, t.created_by) = ?
      ${consumedBranchWhere}
  `, consumedParams);

  return Math.max(0, Number(approved?.total || 0) - Number(consumed?.total || 0));
};

const toUniqueNumbers = (values) => [...new Set((values || [])
  .map((value) => Number(value))
  .filter((value) => Number.isFinite(value) && value > 0))];

const buildIn = (values) => values.map(() => '?').join(',');

const getBranchIngredientBalances = async (executor, stockItemIds, branchId = null) => {
  const ids = toUniqueNumbers(stockItemIds);
  if (!ids.length) return {};

  const branchWhere = branchId ? 'AND branch_id = ?' : '';
  const params = [...ids];
  if (branchId) params.push(branchId);

  const [rows] = await executor.query(`
    SELECT
      stock_item_id,
      COALESCE(SUM(CASE WHEN type = 'in' THEN qty ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'out' THEN qty ELSE 0 END), 0) AS total
    FROM main_stock
    WHERE stock_item_id IN (${buildIn(ids)})
      ${branchWhere}
    GROUP BY stock_item_id
  `, params);

  return rows.reduce((acc, row) => {
    acc[Number(row.stock_item_id)] = Math.max(0, Number(row.total || 0));
    return acc;
  }, {});
};

const getUserIngredientBalances = async (executor, stockItemIds, userIds, branchId = null) => {
  const itemIds = toUniqueNumbers(stockItemIds);
  const targetUserIds = toUniqueNumbers(userIds);
  if (!itemIds.length || !targetUserIds.length) return {};

  const itemPlaceholders = buildIn(itemIds);
  const userPlaceholders = buildIn(targetUserIds);

  const approvedBranchWhere = branchId ? 'AND sr.branch_id = ?' : '';
  const approvedParams = [...targetUserIds, ...itemIds];
  if (branchId) approvedParams.push(branchId);

  const [approvedRows] = await executor.query(`
    SELECT
      sr.user_id,
      sri.stock_item_id,
      COALESCE(SUM(COALESCE(sri.qty_approved, sri.qty_requested)), 0) AS total
    FROM stock_requests sr
    JOIN stock_request_items sri ON sri.request_id = sr.id
    WHERE sr.user_id IN (${userPlaceholders})
      AND sr.status = 'approved'
      AND sri.stock_item_id IN (${itemPlaceholders})
      ${approvedBranchWhere}
    GROUP BY sr.user_id, sri.stock_item_id
  `, approvedParams);

  const consumedBranchWhere = branchId ? 'AND t.branch_id = ?' : '';
  const consumedParams = [...itemIds, ...targetUserIds];
  if (branchId) consumedParams.push(branchId);

  const [consumedRows] = await executor.query(`
    SELECT
      COALESCE(t.source_user_id, t.created_by) AS user_id,
      pi.stock_item_id,
      COALESCE(SUM(ti.qty * pi.qty), 0) AS total
    FROM transactions t
    JOIN transaction_items ti ON ti.transaction_id = t.id
    JOIN product_ingredients pi ON pi.product_id = ti.product_id
    WHERE pi.stock_item_id IN (${itemPlaceholders})
      AND COALESCE(t.source_user_id, t.created_by) IN (${userPlaceholders})
      ${consumedBranchWhere}
    GROUP BY COALESCE(t.source_user_id, t.created_by), pi.stock_item_id
  `, consumedParams);

  const totals = {};
  const ensureRow = (userId, stockItemId) => {
    const userKey = Number(userId);
    const itemKey = Number(stockItemId);
    if (!totals[userKey]) totals[userKey] = {};
    if (!totals[userKey][itemKey]) totals[userKey][itemKey] = { approved: 0, consumed: 0 };
    return totals[userKey][itemKey];
  };

  for (const row of approvedRows) {
    ensureRow(row.user_id, row.stock_item_id).approved = Number(row.total || 0);
  }

  for (const row of consumedRows) {
    ensureRow(row.user_id, row.stock_item_id).consumed = Number(row.total || 0);
  }

  const balances = {};
  for (const userId of targetUserIds) {
    balances[userId] = {};
    for (const stockItemId of itemIds) {
      const row = totals[userId]?.[stockItemId];
      balances[userId][stockItemId] = Math.max(0, Number(row?.approved || 0) - Number(row?.consumed || 0));
    }
  }

  return balances;
};

module.exports = {
  getBranchIngredientBalances,
  getUserIngredientBalance,
  getUserIngredientBalances,
};
