const indexes = [
  ['users', 'idx_users_role_name', 'role, name'],
  ['branches', 'idx_branches_status_id', 'status, id'],
  ['categories', 'idx_categories_name', 'name'],
  ['products', 'idx_products_category_name', 'category_id, name'],
  ['products', 'idx_products_name', 'name'],
  ['stock_items', 'idx_stock_items_name', 'name'],
  ['product_ingredients', 'idx_product_ingredients_stock_item_product', 'stock_item_id, product_id'],
  ['main_stock', 'idx_main_stock_item_branch_type', 'stock_item_id, branch_id, type'],
  ['main_stock', 'idx_main_stock_source_reference_type', 'source, reference_id, type'],
  ['main_stock', 'idx_main_stock_branch_created_at', 'branch_id, created_at'],
  ['stock_requests', 'idx_stock_requests_user_status_date_branch', 'user_id, status, date, branch_id'],
  ['stock_requests', 'idx_stock_requests_branch_status_created_at', 'branch_id, status, created_at'],
  ['stock_request_items', 'idx_stock_request_items_request_stock', 'request_id, stock_item_id'],
  ['stock_request_items', 'idx_stock_request_items_stock_request', 'stock_item_id, request_id'],
  ['transactions', 'idx_transactions_created_at', 'created_at'],
  ['transactions', 'idx_transactions_branch_created_at', 'branch_id, created_at'],
  ['transactions', 'idx_transactions_created_by_created_at', 'created_by, created_at'],
  ['transactions', 'idx_transactions_source_user_created_at', 'source_user_id, created_at'],
  ['transaction_items', 'idx_transaction_items_transaction_id', 'transaction_id'],
  ['transaction_items', 'idx_transaction_items_product_transaction', 'product_id, transaction_id'],
  ['dining_tables', 'idx_dining_tables_branch_status', 'branch_id, status'],
  ['customer_orders', 'idx_customer_orders_code', 'order_code'],
  ['customer_orders', 'idx_customer_orders_table_status_payment', 'table_id, status, payment_status'],
  ['customer_orders', 'idx_customer_orders_branch_status_created_at', 'branch_id, status, created_at'],
  ['customer_orders', 'idx_customer_orders_transaction_id', 'transaction_id'],
  ['customer_order_items', 'idx_customer_order_items_product_id', 'product_id'],
  ['customer_order_item_reviews', 'idx_customer_order_item_reviews_order_id', 'order_id'],
  ['customer_order_item_reviews', 'idx_customer_order_item_reviews_product_id', 'product_id'],
  ['discount_programs', 'idx_discount_programs_status_type', 'status, type'],
  ['discount_programs', 'idx_discount_programs_type_status_value', 'type, status, discount_value'],
  ['discount_programs', 'idx_discount_programs_code', 'code'],
  ['discount_redemptions', 'idx_discount_redemptions_program_created_at', 'program_id, created_at'],
];

const isIgnorableIndexError = (err) =>
  /Duplicate key name|already exists|doesn't exist|Unknown table|relation .* does not exist/i.test(err.message);

exports.up = async (db) => {
  for (const [table, name, columns] of indexes) {
    try {
      await db.query(`CREATE INDEX ${name} ON ${table} (${columns})`);
    } catch (err) {
      if (!isIgnorableIndexError(err)) throw err;
    }
  }
};

exports.down = async (db) => {
  for (const [table, name] of [...indexes].reverse()) {
    try {
      await db.query(`DROP INDEX ${name} ON ${table}`);
    } catch (err) {
      if (!isIgnorableIndexError(err)) throw err;
    }
  }
};
