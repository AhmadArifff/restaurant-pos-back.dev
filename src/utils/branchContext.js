const getRequestBranchId = (req) => {
  const value =
    req.body?.branch_id ||
    req.query?.branch_id ||
    req.headers['x-branch-id'] ||
    req.headers['x-active-branch-id'];

  if (String(value).toLowerCase() === 'all') return 'all';

  const branchId = Number(value);
  return Number.isFinite(branchId) && branchId > 0 ? branchId : null;
};

module.exports = { getRequestBranchId };
