require('dotenv').config();
require('dotenv').config({ path: '.env.vercel', override: true });

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const connectionString = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;
const seedStockMultiplierFromEnv = Number(process.env.RESET_INGREDIENT_STOCK_MULTIPLIER || 1);
const INGREDIENT_STOCK_MULTIPLIER = Number.isFinite(seedStockMultiplierFromEnv) && seedStockMultiplierFromEnv > 0
  ? seedStockMultiplierFromEnv
  : 1;

const ingredient = (name, unit, minStock, pricePerUnit, seedQty) => ({
  name,
  unit,
  minStock,
  pricePerUnit,
  seedQty,
});

const INGREDIENT_CATALOG = [
  ingredient('Tortilla Premium', 'pcs', 50, 3500, 300),
  ingredient('Roti Pita Homemade', 'pcs', 50, 3200, 300),
  ingredient('Roti Pita Potong', 'pcs', 50, 2200, 300),
  ingredient('Nasi Basmati', 'gram', 5000, 18, 50000),
  ingredient('Nasi Bulgur', 'gram', 5000, 22, 40000),
  ingredient('Daging Sapi Slice', 'gram', 5000, 85, 45000),
  ingredient('Daging Domba', 'gram', 3000, 120, 25000),
  ingredient('Ayam Marinasi', 'gram', 5000, 55, 45000),
  ingredient('Daging Cincang Bumbu', 'gram', 4000, 78, 35000),
  ingredient('Lamb Chop', 'pcs', 20, 45000, 120),
  ingredient('Salmon Fillet', 'gram', 3000, 210, 18000),
  ingredient('Sayuran Segar', 'gram', 5000, 30, 45000),
  ingredient('Salad Segar', 'gram', 4000, 35, 35000),
  ingredient('Tomat', 'gram', 3000, 22, 25000),
  ingredient('Timun', 'gram', 3000, 18, 25000),
  ingredient('Bawang Bombay', 'gram', 2000, 24, 18000),
  ingredient('Mozzarella', 'gram', 2000, 95, 16000),
  ingredient('Keju Feta', 'gram', 1500, 90, 12000),
  ingredient('Yogurt Segar', 'ml', 3000, 28, 25000),
  ingredient('Saus Tahini', 'ml', 2000, 42, 18000),
  ingredient('Garlic Sauce', 'ml', 3000, 32, 24000),
  ingredient('Saus Pedas Sultan', 'ml', 2000, 30, 18000),
  ingredient('Butter Sauce', 'gram', 2000, 55, 16000),
  ingredient('Rempah Timur Tengah', 'gram', 1000, 110, 9000),
  ingredient('Minyak Zaitun', 'ml', 2000, 48, 18000),
  ingredient('Kacang Arab', 'gram', 3000, 38, 25000),
  ingredient('Daun Anggur', 'pcs', 50, 850, 500),
  ingredient('Kulit Pastry', 'pcs', 40, 1800, 300),
  ingredient('Kulit Samosa', 'pcs', 40, 1500, 400),
  ingredient('Kulit Lahmacun', 'pcs', 40, 2400, 250),
  ingredient('Cup Minuman', 'pcs', 50, 1200, 350),
  ingredient('Ayran Base', 'ml', 3000, 24, 24000),
  ingredient('Teh Turki', 'ml', 3000, 8, 35000),
  ingredient('Lemon Mint Syrup', 'ml', 2000, 35, 18000),
  ingredient('Jus Delima', 'ml', 2000, 55, 16000),
  ingredient('Kopi Arabica', 'gram', 1000, 145, 8000),
  ingredient('Rose Syrup', 'ml', 1500, 40, 14000),
  ingredient('Air Soda', 'ml', 3000, 9, 30000),
  ingredient('Phyllo Pastry', 'pcs', 40, 1700, 300),
  ingredient('Pistachio', 'gram', 800, 190, 7000),
  ingredient('Madu', 'ml', 1000, 75, 8000),
  ingredient('Keju Kunafa', 'gram', 1500, 110, 12000),
  ingredient('Adonan Kunafa', 'gram', 1500, 65, 12000),
  ingredient('Susu Pudding', 'ml', 2000, 24, 20000),
  ingredient('Dondurma Scoop', 'scoop', 30, 6500, 250),
];

const RECIPE_BY_PRODUCT = {
  'Sultan Royal Kebab': [
    ['Roti Pita Homemade', 1],
    ['Daging Sapi Slice', 95],
    ['Daging Domba', 45],
    ['Saus Tahini', 35],
    ['Salad Segar', 55],
    ['Rempah Timur Tengah', 6],
  ],
  'Shawarma Bombastic': [
    ['Tortilla Premium', 1],
    ['Ayam Marinasi', 130],
    ['Garlic Sauce', 35],
    ['Sayuran Segar', 60],
    ['Rempah Timur Tengah', 5],
  ],
  'Doner Kebab Original': [
    ['Roti Pita Homemade', 1],
    ['Daging Sapi Slice', 120],
    ['Saus Pedas Sultan', 30],
    ['Tomat', 35],
    ['Timun', 30],
    ['Bawang Bombay', 20],
  ],
  'Kebab Cheese Lava': [
    ['Tortilla Premium', 1],
    ['Daging Sapi Slice', 115],
    ['Mozzarella', 65],
    ['Garlic Sauce', 25],
    ['Sayuran Segar', 45],
  ],
  'Adana Kebab Platter': [
    ['Daging Cincang Bumbu', 160],
    ['Nasi Bulgur', 180],
    ['Salad Segar', 55],
    ['Saus Pedas Sultan', 25],
    ['Rempah Timur Tengah', 8],
  ],
  'Iskender Kebab': [
    ['Roti Pita Potong', 2],
    ['Daging Sapi Slice', 140],
    ['Butter Sauce', 45],
    ['Yogurt Segar', 60],
    ['Tomat', 40],
  ],
  'Lamb Chops Sultan': [
    ['Lamb Chop', 2],
    ['Nasi Basmati', 180],
    ['Salad Segar', 60],
    ['Rempah Timur Tengah', 8],
    ['Minyak Zaitun', 25],
  ],
  'Mixed Grill Platter': [
    ['Daging Sapi Slice', 130],
    ['Daging Domba', 100],
    ['Ayam Marinasi', 120],
    ['Nasi Basmati', 180],
    ['Salad Segar', 70],
    ['Garlic Sauce', 35],
  ],
  'Nasi Kabsa Royal': [
    ['Nasi Basmati', 230],
    ['Ayam Marinasi', 160],
    ['Rempah Timur Tengah', 10],
    ['Bawang Bombay', 35],
    ['Minyak Zaitun', 20],
  ],
  'Moroccan Beef Tagine': [
    ['Daging Sapi Slice', 170],
    ['Nasi Basmati', 160],
    ['Rempah Timur Tengah', 10],
    ['Tomat', 55],
    ['Minyak Zaitun', 25],
  ],
  'Grilled Salmon Sultan': [
    ['Salmon Fillet', 180],
    ['Salad Segar', 70],
    ['Lemon Mint Syrup', 20],
    ['Minyak Zaitun', 25],
    ['Rempah Timur Tengah', 5],
  ],
  'Chicken Mansaf Jordania': [
    ['Ayam Marinasi', 180],
    ['Nasi Basmati', 210],
    ['Yogurt Segar', 80],
    ['Rempah Timur Tengah', 9],
    ['Kacang Arab', 40],
  ],
  'Falafel Crispy': [
    ['Kacang Arab', 140],
    ['Garlic Sauce', 25],
    ['Salad Segar', 45],
    ['Rempah Timur Tengah', 6],
  ],
  'Hummus & Pita Premium': [
    ['Kacang Arab', 120],
    ['Roti Pita Homemade', 1],
    ['Saus Tahini', 35],
    ['Minyak Zaitun', 20],
  ],
  'Börek Keju Turki': [
    ['Kulit Pastry', 2],
    ['Keju Feta', 60],
    ['Mozzarella', 35],
    ['Butter Sauce', 20],
  ],
  'Dolma (Stuffed Leaves)': [
    ['Daun Anggur', 6],
    ['Nasi Bulgur', 90],
    ['Tomat', 35],
    ['Minyak Zaitun', 18],
    ['Rempah Timur Tengah', 5],
  ],
  'Lahmacun Sultan': [
    ['Kulit Lahmacun', 1],
    ['Daging Cincang Bumbu', 100],
    ['Tomat', 35],
    ['Bawang Bombay', 25],
    ['Rempah Timur Tengah', 5],
  ],
  'Samosa Daging Spesial': [
    ['Kulit Samosa', 3],
    ['Daging Cincang Bumbu', 75],
    ['Bawang Bombay', 20],
    ['Saus Pedas Sultan', 20],
  ],
  'Ayran Sultan': [
    ['Cup Minuman', 1],
    ['Ayran Base', 250],
    ['Yogurt Segar', 45],
  ],
  'Turkish Çay (Tea)': [
    ['Cup Minuman', 1],
    ['Teh Turki', 280],
  ],
  'Lemon Mint Sultan': [
    ['Cup Minuman', 1],
    ['Lemon Mint Syrup', 70],
    ['Air Soda', 220],
  ],
  'Jus Delima Segar': [
    ['Cup Minuman', 1],
    ['Jus Delima', 280],
  ],
  'Arabic Qahwa Coffee': [
    ['Cup Minuman', 1],
    ['Kopi Arabica', 22],
    ['Rempah Timur Tengah', 2],
  ],
  'Rose Water Lemonade': [
    ['Cup Minuman', 1],
    ['Rose Syrup', 65],
    ['Lemon Mint Syrup', 35],
    ['Air Soda', 220],
  ],
  'Baklava Sultan': [
    ['Phyllo Pastry', 3],
    ['Pistachio', 45],
    ['Madu', 35],
    ['Butter Sauce', 25],
  ],
  'Kunafa Cheese': [
    ['Adonan Kunafa', 120],
    ['Keju Kunafa', 70],
    ['Madu', 30],
    ['Pistachio', 18],
  ],
  'Muhallebi Pudding': [
    ['Susu Pudding', 260],
    ['Madu', 20],
    ['Pistachio', 12],
  ],
  'Dondurma Ice Cream': [
    ['Dondurma Scoop', 2],
    ['Pistachio', 15],
    ['Madu', 15],
  ],
  'Paket Berdua Romantis': [
    ['Tortilla Premium', 2],
    ['Daging Sapi Slice', 220],
    ['Ayam Marinasi', 180],
    ['Salad Segar', 120],
    ['Garlic Sauce', 70],
    ['Cup Minuman', 2],
    ['Lemon Mint Syrup', 100],
    ['Air Soda', 420],
  ],
  'Paket Keluarga Sultan': [
    ['Roti Pita Homemade', 4],
    ['Daging Sapi Slice', 360],
    ['Daging Domba', 220],
    ['Ayam Marinasi', 320],
    ['Nasi Basmati', 520],
    ['Salad Segar', 220],
    ['Garlic Sauce', 120],
    ['Saus Tahini', 90],
  ],
  'Paket Catering Event': [
    ['Tortilla Premium', 1],
    ['Daging Sapi Slice', 90],
    ['Ayam Marinasi', 90],
    ['Nasi Basmati', 150],
    ['Salad Segar', 60],
    ['Garlic Sauce', 35],
  ],
  'Paket Corporate Lunch': [
    ['Roti Pita Homemade', 1],
    ['Ayam Marinasi', 140],
    ['Nasi Basmati', 160],
    ['Salad Segar', 55],
    ['Garlic Sauce', 30],
    ['Cup Minuman', 1],
    ['Teh Turki', 240],
  ],
};

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

const ensureStockItem = async (client, item) => {
  const { rows } = await client.query('select id from stock_items where name = $1 limit 1', [item.name]);
  if (rows.length) {
    await client.query(`
      update stock_items
      set unit = $1,
          min_stock = $2,
          price_per_unit = $3,
          stock = 0,
          total_price = 0
      where id = $4
    `, [item.unit, item.minStock, item.pricePerUnit, rows[0].id]);
    return rows[0].id;
  }

  const inserted = await client.query(`
    insert into stock_items (name, unit, stock, total_price, price_per_unit, min_stock)
    values ($1, $2, 0, 0, $3, $4)
    returning id
  `, [item.name, item.unit, item.pricePerUnit, item.minStock]);
  return inserted.rows[0].id;
};

const seedIngredientStock = async ({ client, actorId, branchIds }) => {
  const stockItems = new Map();
  let stockRows = 0;

  for (const item of INGREDIENT_CATALOG) {
    const stockItemId = await ensureStockItem(client, item);
    const qtyPerBranch = Number(item.seedQty || 0) * INGREDIENT_STOCK_MULTIPLIER;
    const totalQty = qtyPerBranch * branchIds.length;
    const totalValue = totalQty * Number(item.pricePerUnit || 0);

    for (const branchId of branchIds) {
      await client.query(`
        insert into main_stock
          (stock_item_id, qty, cost_per_unit, type, source, note, branch_id, created_by)
        values ($1, $2, $3, 'in', 'adjustment', $4, $5, $6)
      `, [
        stockItemId,
        qtyPerBranch,
        item.pricePerUnit,
        'Saldo awal bahan baku dari menu landing page setelah reset operasional',
        branchId,
        actorId,
      ]);
      stockRows += 1;
    }

    await client.query(`
      update stock_items
      set stock = $1,
          total_price = $2,
          price_per_unit = $3,
          min_stock = $4
      where id = $5
    `, [totalQty, totalValue, item.pricePerUnit, item.minStock, stockItemId]);

    stockItems.set(item.name, stockItemId);
  }

  return { stockItems, stockRows };
};

const getProductRecipe = (productName, categoryName) => {
  const recipe = RECIPE_BY_PRODUCT[productName];
  if (recipe) return recipe;

  if (String(categoryName).includes('Minuman')) {
    return [['Cup Minuman', 1], ['Teh Turki', 250]];
  }
  if (String(categoryName).includes('Dessert')) {
    return [['Susu Pudding', 180], ['Madu', 20], ['Pistachio', 10]];
  }
  if (String(categoryName).includes('Snack')) {
    return [['Roti Pita Homemade', 1], ['Kacang Arab', 80], ['Garlic Sauce', 20], ['Salad Segar', 35]];
  }
  return [['Tortilla Premium', 1], ['Daging Sapi Slice', 100], ['Sayuran Segar', 50], ['Garlic Sauce', 25]];
};

const seedLandingMenuProductsAndStock = async ({ client, actorId, fallbackBranchId }) => {
  const landingMenu = await parseLandingMenu(client);
  const { rows: activeBranches } = await client.query("select id from branches where status = 'active' order by id");
  const branchIds = activeBranches.length ? activeBranches.map((row) => row.id) : [fallbackBranchId].filter(Boolean);
  if (!branchIds.length) throw new Error('Tidak ada cabang aktif untuk seed stok produk.');

  const landingProductNames = landingMenu.flatMap((category) => category.items.map((item) => item.name));
  const landingCategoryNames = landingMenu.map((category) => category.name);

  await client.query('delete from product_ingredients');
  await client.query('delete from products where not (name = any($1::text[]))', [landingProductNames]);
  await client.query('delete from categories where not (name = any($1::text[])) and not exists (select 1 from products where products.category_id = categories.id)', [landingCategoryNames]);
  await client.query('delete from stock_items');

  const stockSeed = await seedIngredientStock({ client, actorId, branchIds });

  let productCount = 0;
  let categoryCount = 0;
  let recipeRows = 0;

  for (const category of landingMenu) {
    const categoryId = await ensureCategory(client, category.name);
    categoryCount += 1;

    for (const item of category.items) {
      const productId = await ensureProduct(client, item, categoryId);
      const recipe = getProductRecipe(item.name, category.name);

      for (const [stockName, qty] of recipe) {
        const stockItemId = stockSeed.stockItems.get(stockName);
        if (!stockItemId) throw new Error(`Bahan baku "${stockName}" belum tersedia di katalog seed.`);
        await client.query(`
          insert into product_ingredients (product_id, stock_item_id, qty)
          values ($1, $2, $3)
          on conflict (product_id, stock_item_id)
          do update set qty = excluded.qty
        `, [productId, stockItemId, qty]);
        recipeRows += 1;
      }

      productCount += 1;
    }
  }

  return {
    categoryCount,
    productCount,
    ingredientCount: INGREDIENT_CATALOG.length,
    recipeRows,
    stockRows: stockSeed.stockRows,
  };
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
    console.log('Data yang dihapus: klaim diskon, transaksi, item transaksi, order meja, review, pengajuan stok, audit stok, attendance, histori main_stock lama, resep produk lama, stock item lama, dan produk non-landing.');
    console.log('Data yang dipertahankan: program voucher/diskon, users/tim kasir, branches, dining_tables, website_settings, serta kategori/produk landing yang di-upsert agar seed ulang stabil.');
    console.log(`Seed menu landing page: ${seedResult.categoryCount} kategori, ${seedResult.productCount} produk, ${seedResult.ingredientCount} bahan baku, ${seedResult.recipeRows} baris resep, ${seedResult.stockRows} saldo stok cabang.`);
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
