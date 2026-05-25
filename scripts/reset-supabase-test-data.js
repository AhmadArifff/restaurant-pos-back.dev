require('dotenv').config();
require('dotenv').config({ path: '.env.vercel', override: true });

const crypto = require('crypto');
const { Pool } = require('pg');

const connectionString = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;

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

const normalizeKey = (value, fallback) => String(value || fallback)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80);

const DEFAULT_BRANCHES = [
  { branch_key: 'bandung-dago', name: 'Sultan Kebab Dago', area: 'Bandung Kota' },
  { branch_key: 'jakarta-scbd', name: 'Sultan Kebab SCBD', area: 'Jakarta Selatan' },
  { branch_key: 'surabaya-pakuwon', name: 'Sultan Kebab Pakuwon', area: 'Surabaya Barat' },
];

const parseLandingBranches = async (client) => {
  const { rows } = await client.query(
    "select setting_value from website_settings where setting_key = 'landing_locations' limit 1"
  );

  try {
    const parsed = JSON.parse(rows[0]?.setting_value || '{}');
    const branches = Array.isArray(parsed?.branches) ? parsed.branches : [];
    if (!branches.length) return DEFAULT_BRANCHES;

    return branches.map((branch, index) => ({
      branch_key: normalizeKey(branch.id || branch.name, `branch-${index + 1}`),
      name: branch.name || branch.tabLabel || `Cabang ${index + 1}`,
      area: branch.area || branch.sectionTag || null,
      address: Array.isArray(branch.details)
        ? (branch.details.find((detail) => detail.text)?.text || null)
        : null,
      phone: Array.isArray(branch.details)
        ? (branch.details.find((detail) => Array.isArray(detail.lines))?.lines?.[0] || null)
        : null,
    }));
  } catch {
    return DEFAULT_BRANCHES;
  }
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

const reset = async () => {
  const pool = new Pool({
    connectionString: getPostgresConnectionString(connectionString),
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  try {
    await client.query('begin');

    const tablesToDelete = [
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
      'product_ingredients',
      'main_stock',
      'products',
      'categories',
      'stock_items',
      'attendance',
      'dining_tables',
      'branches',
    ];

    for (const table of tablesToDelete) {
      await deleteIfExists(client, table);
    }

    const landingBranches = await parseLandingBranches(client);
    const branchIds = [];
    for (const branch of landingBranches) {
      const { rows } = await client.query(`
        insert into branches (branch_key, name, area, address, phone, status)
        values ($1, $2, $3, $4, $5, 'active')
        returning id
      `, [branch.branch_key, branch.name, branch.area || null, branch.address || null, branch.phone || null]);
      branchIds.push(rows[0].id);
    }

    const firstBranchId = branchIds[0] || null;
    if (firstBranchId) {
      await client.query('update users set default_branch_id = coalesce(default_branch_id, $1)', [firstBranchId]);
    }

    for (const branchId of branchIds) {
      for (let i = 1; i <= 6; i += 1) {
        await client.query(`
          insert into dining_tables (table_number, table_name, capacity, qr_token, status, branch_id)
          values ($1, $2, $3, $4, 'active', $5)
        `, [String(i), `Meja ${i}`, i <= 2 ? 2 : 4, crypto.randomBytes(24).toString('hex'), branchId]);
      }
    }

    const categoryRows = {};
    for (const name of ['Kebab Signature', 'Minuman']) {
      const { rows } = await client.query('insert into categories (name) values ($1) returning id', [name]);
      categoryRows[name] = rows[0].id;
    }

    const stockRows = {};
    const stockItems = [
      ['Tortilla', 'pcs', 20, 3500],
      ['Daging Kebab', 'gram', 1000, 120],
      ['Sayuran Mix', 'gram', 800, 35],
      ['Saus Signature', 'ml', 500, 18],
      ['Cup Minuman', 'pcs', 15, 1200],
      ['Teh', 'ml', 1000, 8],
    ];

    for (const [name, unit, minStock, price] of stockItems) {
      const { rows } = await client.query(`
        insert into stock_items (name, unit, min_stock, price_per_unit, stock, total_price)
        values ($1, $2, $3, $4, 0, 0)
        returning id
      `, [name, unit, minStock, price]);
      stockRows[name] = { id: rows[0].id, price };
    }

    const products = [
      {
        name: 'Kebab Sultan Original',
        price: 20000,
        category: 'Kebab Signature',
        image_url: null,
        ingredients: [['Tortilla', 1], ['Daging Kebab', 90], ['Sayuran Mix', 35], ['Saus Signature', 25]],
      },
      {
        name: 'Kebab Sultan Spesial',
        price: 28000,
        category: 'Kebab Signature',
        image_url: null,
        ingredients: [['Tortilla', 1], ['Daging Kebab', 130], ['Sayuran Mix', 45], ['Saus Signature', 35]],
      },
      {
        name: 'Es Teh Sultan',
        price: 8000,
        category: 'Minuman',
        image_url: null,
        ingredients: [['Cup Minuman', 1], ['Teh', 250]],
      },
    ];

    for (const product of products) {
      const { rows } = await client.query(`
        insert into products (name, price, category_id, image_url)
        values ($1, $2, $3, $4)
        returning id
      `, [product.name, product.price, categoryRows[product.category], product.image_url]);

      for (const [stockName, qty] of product.ingredients) {
        await client.query(`
          insert into product_ingredients (product_id, stock_item_id, qty)
          values ($1, $2, $3)
        `, [rows[0].id, stockRows[stockName].id, qty]);
      }
    }

    for (const branchId of branchIds) {
      for (const [name, item] of Object.entries(stockRows)) {
        const qty = name === 'Daging Kebab' ? 12000
          : name === 'Sayuran Mix' ? 7000
          : name === 'Saus Signature' ? 5000
          : name === 'Teh' ? 20000
          : 120;
        await client.query(`
          insert into main_stock
            (stock_item_id, qty, cost_per_unit, type, source, note, branch_id, created_by)
          values ($1, $2, $3, 'in', 'purchase', 'Saldo awal testing cabang', $4, (select id from users order by id limit 1))
        `, [item.id, qty, item.price, branchId]);
      }
    }

    await client.query('commit');
    console.log('\nReset data testing Supabase selesai.');
    console.log('Data yang dipertahankan: users/tim kasir dan website_settings/pengaturan.');
  } catch (error) {
    await client.query('rollback');
    console.error('Reset gagal:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

reset();
