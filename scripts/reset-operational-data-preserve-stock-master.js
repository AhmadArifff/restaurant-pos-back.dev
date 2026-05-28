require('dotenv').config();
require('dotenv').config({ path: '.env.vercel', override: true });

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

const tableExists = async (client, table) => {
  const { rows } = await client.query('select to_regclass($1) as table_name', [`public.${table}`]);
  return Boolean(rows[0]?.table_name);
};

const deleteIfExists = async (client, table) => {
  if (!(await tableExists(client, table))) return;
  await client.query(`delete from ${table}`);
  console.log(`- reset ${table}`);
};

const getStockSnapshots = async (client) => {
  const { rows } = await client.query(`
    select
      si.id as stock_item_id,
      si.name,
      si.stock as fallback_stock,
      si.total_price as fallback_total_price,
      si.price_per_unit as fallback_price,
      ms.branch_id,
      coalesce(sum(case when ms.type = 'in' then ms.qty else -ms.qty end), 0) as balance_qty,
      coalesce(sum(case when ms.type = 'in' then ms.total_cost else -ms.total_cost end), 0) as balance_value,
      coalesce(
        nullif(sum(case when ms.type = 'in' then ms.total_cost else 0 end), 0)
          / nullif(sum(case when ms.type = 'in' then ms.qty else 0 end), 0),
        nullif(si.price_per_unit, 0),
        0
      ) as cost_per_unit
    from stock_items si
    left join main_stock ms on ms.stock_item_id = si.id
    group by si.id, si.name, si.stock, si.total_price, si.price_per_unit, ms.branch_id
    order by si.name asc, ms.branch_id asc
  `);

  const grouped = new Map();
  for (const row of rows) {
    const key = Number(row.stock_item_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  return grouped;
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

    const { rows: branchRows } = await client.query("select id from branches where status = 'active' order by id limit 1");
    const fallbackBranchId = branchRows[0]?.id || null;

    const stockSnapshots = await getStockSnapshots(client);

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
      'attendance',
      'main_stock',
    ];

    for (const table of tablesToDelete) {
      await deleteIfExists(client, table);
    }

    let seededRows = 0;
    for (const [stockItemId, snapshots] of stockSnapshots.entries()) {
      const positiveSnapshots = snapshots.filter((row) => Number(row.balance_qty || 0) > 0);
      const seedRows = positiveSnapshots.length
        ? positiveSnapshots
        : snapshots
            .filter((row) => Number(row.fallback_stock || 0) > 0)
            .slice(0, 1)
            .map((row) => ({
              ...row,
              branch_id: fallbackBranchId,
              balance_qty: Number(row.fallback_stock || 0),
              cost_per_unit: Number(row.fallback_price || 0),
            }));

      let totalQty = 0;
      let totalValue = 0;
      for (const row of seedRows) {
        const qty = Number(row.balance_qty || 0);
        if (qty <= 0) continue;
        const cost = Number(row.cost_per_unit || row.fallback_price || 0);
        totalQty += qty;
        totalValue += qty * cost;
        seededRows += 1;
        await client.query(`
          insert into main_stock
            (stock_item_id, qty, cost_per_unit, type, source, note, branch_id, created_by)
          values ($1, $2, $3, 'in', 'adjustment', 'Saldo awal setelah reset data operasional', $4, $5)
        `, [stockItemId, qty, cost, row.branch_id || fallbackBranchId, actorId]);
      }

      await client.query(`
        update stock_items
        set stock = $1,
            total_price = $2
        where id = $3
      `, [totalQty, totalValue, stockItemId]);
    }

    await client.query('commit');
    console.log('\nReset operasional Supabase selesai.');
    console.log('Data yang dihapus: transaksi, item transaksi, order meja, review, pengajuan stok, audit stok, attendance, dan histori main_stock lama.');
    console.log('Data yang dipertahankan: users/tim kasir, branches, dining_tables, products, categories, product_ingredients, website_settings, dan stock_items master.');
    console.log(`Saldo stok awal baru dibuat ulang: ${seededRows} baris main_stock.`);
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
