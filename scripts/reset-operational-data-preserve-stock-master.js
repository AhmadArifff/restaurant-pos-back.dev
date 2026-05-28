require('dotenv').config();
require('dotenv').config({ path: '.env.vercel', override: true });

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const connectionString = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;
const readyStockFromEnv = Number(process.env.RESET_READY_STOCK_PER_PRODUCT || 100);
const DEFAULT_READY_STOCK_PER_BRANCH = Number.isFinite(readyStockFromEnv) && readyStockFromEnv > 0
  ? readyStockFromEnv
  : 100;

if (!connectionString) {
  console.error('SUPABASE_DATABASE_URL atau DATABASE_URL wajib diisi.');
  process.exit(1);
}

const getPostgresConnectionString = (value) => {
  const url = new URL(value);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslcert');
  url.searchParams.delete('sslkey');
  url.searchParams.delete('sslrootcert');
  return url.toString();
};

const tableExists = async (client, table) => {
  const { rows } = await client.query('select to_regclass($1) as table_name', [`public.${table}`]);
  return Boolean(rows[0]?.table_name);
};

const deleteIfExists = async (client, table) => {
  if (!(await tableExists(client, table))) return;
  await client.query(`delete from ${table}`);
  console.log(`- reset ${table}`);
};

const normalizeKey = (value, fallback) => String(value || fallback)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80);

const getDetailText = (details, predicate) => {
  if (!Array.isArray(details)) return null;
  const detail = details.find(predicate);
  if (!detail) return null;
  if (detail.text) return detail.text;
  if (Array.isArray(detail.lines)) return detail.lines[0] || null;
  return null;
};

const parsePrice = (value) => {
  const match = String(value || '').match(/Rp\s*([\d.]+)/i);
  if (!match) return 0;
  return Number(match[1].replace(/\./g, '')) || 0;
};

const loadLocalLandingMenu = () => {
  const menuPath = path.resolve(process.cwd(), '..', 'kebab-pos-client', 'data', 'landing', 'menuContent.js');
  const raw = fs.readFileSync(menuPath, 'utf8');
  const code = raw
    .replace(/export\s+const\s+menuContent\s*=/, 'const menuContent =')
    .replace(/;\s*$/, '\nresult = menuContent;');
  const context = { result: null };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: menuPath });
  return context.result;
};

const normalizeLandingMenu = (menuContent) => {
  const categories = Array.isArray(menuContent?.categories) ? menuContent.categories : [];
  return categories.map((category, index) => ({
    category_key: normalizeKey(category.id || category.label, `category-${index + 1}`),
    name: category.label || `Kategori ${index + 1}`,
    items: (Array.isArray(category.items) ? category.items : []).map((item) => ({
      name: item.name || item.orderName,
      price: parsePrice(item.price),
      image_url: item.image || null,
      description: item.description || null,
    })).filter((item) => item.name && item.price > 0),
  })).filter((category) => category.items.length > 0);
};

const parseLandingMenu = async (client) => {
  try {
    const { rows } = await client.query(
      "select setting_value from website_settings where setting_key = 'landing_menu_tabs' limit 1"
    );
    const rawValue = rows[0]?.setting_value;
    const parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
    const normalized = normalizeLandingMenu(parsed);
    if (normalized.length) return normalized;
  } catch (_) {}

  return normalizeLandingMenu(loadLocalLandingMenu());
};

const parseLandingBranches = async (client) => {
  const { rows } = await client.query(
    "select setting_value from website_settings where setting_key = 'landing_locations' limit 1"
  );

  try {
    const parsed = JSON.parse(rows[0]?.setting_value || '{}');
    const branches = Array.isArray(parsed?.branches) ? parsed.branches : [];
    return branches.map((branch, index) => ({
      branch_key: normalizeKey(branch.id || branch.name, `branch-${index + 1}`),
      name: branch.name || branch.tabLabel || `Cabang ${index + 1}`,
      area: branch.area || branch.sectionTag || null,
      address: getDetailText(branch.details, (detail) =>
        String(detail.icon || '').includes('📍') || Boolean(detail.text)
      ),
      phone: getDetailText(branch.details, (detail) =>
        String(detail.icon || '').includes('📞')
        || String(detail.text || '').includes('+62')
        || (Array.isArray(detail.lines) && detail.lines.some((line) => String(line).includes('+62')))
      ),
    }));
  } catch {
    return [];
  }
};

const syncBranchesFromLanding = async (client) => {
  const branches = await parseLandingBranches(client);
  if (!branches.length) return [];

  const activeKeys = [];
  for (const branch of branches) {
    activeKeys.push(branch.branch_key);
    const { rows } = await client.query('select id from branches where branch_key = $1 limit 1', [branch.branch_key]);
    if (rows.length) {
      await client.query(`
        update branches
        set name = $1, area = $2, address = $3, phone = $4, status = 'active'
        where branch_key = $5
      `, [branch.name, branch.area, branch.address, branch.phone, branch.branch_key]);
    } else {
      await client.query(`
        insert into branches (branch_key, name, area, address, phone, status)
        values ($1, $2, $3, $4, $5, 'active')
      `, [branch.branch_key, branch.name, branch.area, branch.address, branch.phone]);
    }
  }

  await client.query(
    'update branches set status = \'inactive\' where not (branch_key = any($1::text[]))',
    [activeKeys]
  );

  console.log(`- sync branches from landing page: ${activeKeys.length} cabang aktif`);
  return activeKeys;
};

const ensureCategory = async (client, categoryName) => {
  const { rows } = await client.query('select id from categories where name = $1 limit 1', [categoryName]);
  if (rows.length) return rows[0].id;

  const inserted = await client.query(
    'insert into categories (name) values ($1) returning id',
    [categoryName]
  );
  return inserted.rows[0].id;
};

const ensureProduct = async (client, item, categoryId) => {
  const { rows } = await client.query('select id from products where name = $1 limit 1', [item.name]);
  if (rows.length) {
    await client.query(`
      update products
      set price = $1,
          category_id = $2,
          image_url = $3
      where id = $4
    `, [item.price, categoryId, item.image_url, rows[0].id]);
    return rows[0].id;
  }

  const inserted = await client.query(`
    insert into products (name, price, category_id, image_url)
    values ($1, $2, $3, $4)
    returning id
  `, [item.name, item.price, categoryId, item.image_url]);
  return inserted.rows[0].id;
};

const ensureReadyStockItem = async (client, item) => {
  const stockName = `Ready Stock - ${item.name}`;
  const costPerUnit = Math.max(1, Math.round(Number(item.price || 0) * 0.45));
  const { rows } = await client.query('select id from stock_items where name = $1 limit 1', [stockName]);
  if (rows.length) {
    await client.query(`
      update stock_items
      set unit = 'porsi',
          min_stock = 10,
          price_per_unit = $1,
          stock = 0,
          total_price = 0
      where id = $2
    `, [costPerUnit, rows[0].id]);
    return { id: rows[0].id, costPerUnit };
  }

  const inserted = await client.query(`
    insert into stock_items (name, unit, stock, total_price, price_per_unit, min_stock)
    values ($1, 'porsi', 0, 0, $2, 10)
    returning id
  `, [stockName, costPerUnit]);
  return { id: inserted.rows[0].id, costPerUnit };
};

const seedLandingMenuProductsAndStock = async ({ client, actorId, fallbackBranchId }) => {
  const landingMenu = await parseLandingMenu(client);
  const { rows: activeBranches } = await client.query("select id from branches where status = 'active' order by id");
  const branchIds = activeBranches.length ? activeBranches.map((row) => row.id) : [fallbackBranchId].filter(Boolean);
  if (!branchIds.length) throw new Error('Tidak ada cabang aktif untuk seed stok produk.');

  await client.query('delete from product_ingredients');
  await client.query('update stock_items set stock = 0, total_price = 0');

  let productCount = 0;
  let categoryCount = 0;
  let stockRows = 0;

  for (const category of landingMenu) {
    const categoryId = await ensureCategory(client, category.name);
    categoryCount += 1;

    for (const item of category.items) {
      const productId = await ensureProduct(client, item, categoryId);
      const stockItem = await ensureReadyStockItem(client, item);

      await client.query(`
        insert into product_ingredients (product_id, stock_item_id, qty)
        values ($1, $2, 1)
        on conflict (product_id, stock_item_id)
        do update set qty = excluded.qty
      `, [productId, stockItem.id]);

      let totalQty = 0;
      let totalValue = 0;
      for (const branchId of branchIds) {
        const qty = DEFAULT_READY_STOCK_PER_BRANCH;
        const totalCost = qty * stockItem.costPerUnit;
        totalQty += qty;
        totalValue += totalCost;
        stockRows += 1;
        await client.query(`
          insert into main_stock
            (stock_item_id, qty, cost_per_unit, type, source, note, branch_id, created_by)
          values ($1, $2, $3, 'in', 'adjustment', $4, $5, $6)
        `, [
          stockItem.id,
          qty,
          stockItem.costPerUnit,
          'Saldo awal ready stock dari menu landing page setelah reset operasional',
          branchId,
          actorId,
        ]);
      }

      await client.query(`
        update stock_items
        set stock = $1,
            total_price = $2
        where id = $3
      `, [totalQty, totalValue, stockItem.id]);

      productCount += 1;
    }
  }

  return { categoryCount, productCount, stockRows };
};

const reset = async () => {
  const pool = new Pool({
    connectionString: getPostgresConnectionString(connectionString),
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  try {
    await client.query('begin');

    const { rows: actorRows } = await client.query('select id from users order by id limit 1');
    const actorId = actorRows[0]?.id;
    if (!actorId) throw new Error('Tidak ada user untuk mencatat saldo awal stok.');

    await syncBranchesFromLanding(client);

    const { rows: branchRows } = await client.query("select id from branches where status = 'active' order by id limit 1");
    const fallbackBranchId = branchRows[0]?.id || null;

    const tablesToDelete = [
      'discount_redemptions',
      'customer_order_item_reviews',
      'customer_order_reviews',
      'customer_order_items',
      'customer_orders',
      'transaction_items',
      'transactions',
      'stock_request_audit',
      'stock_request_items',
      'stock_requests',
      'stock_item_movements',
      'stock_movements',
      'attendance',
      'main_stock',
    ];

    for (const table of tablesToDelete) {
      await deleteIfExists(client, table);
    }

    const seedResult = await seedLandingMenuProductsAndStock({ client, actorId, fallbackBranchId });

    await client.query('commit');
    console.log('\nReset operasional Supabase selesai.');
    console.log('Data yang dihapus: klaim diskon, transaksi, item transaksi, order meja, review, pengajuan stok, audit stok, attendance, histori main_stock lama, dan resep produk lama.');
    console.log('Data yang dipertahankan: program voucher/diskon, users/tim kasir, branches, dining_tables, website_settings, serta master category/product/stock item yang di-upsert agar seed ulang tidak hilang.');
    console.log(`Seed menu landing page: ${seedResult.categoryCount} kategori, ${seedResult.productCount} produk, ${seedResult.stockRows} saldo stok cabang.`);
  } catch (error) {
    await client.query('rollback');
    console.error('Reset operasional gagal:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

reset();
