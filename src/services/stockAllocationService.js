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

module.exports = { getUserIngredientBalance };
