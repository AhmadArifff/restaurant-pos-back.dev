require('dotenv').config();
require('dotenv').config({ path: '.env.vercel', override: true });
require('dotenv').config({ path: '.env.migration.local', override: false });

const mysql = require('mysql2/promise');
const { Pool } = require('pg');

const TABLES = [
  'users',
  'categories',
  'products',
  'transactions',
  'transaction_items',
  'stock_movements',
  'stock_items',
  'product_ingredients',
  'stock_item_movements',
  'attendance',
  'stock_requests',
  'stock_request_items',
  'main_stock',
  'website_settings',
  'stock_request_audit',
  'dining_tables',
  'customer_orders',
  'customer_order_items',
  'customer_order_reviews',
  'customer_order_item_reviews',
];

const TABLE_COLUMN_EXCLUDES = {
  main_stock: ['total_cost'],
};

const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;

const mysqlConnectionConfig = {
  host: process.env.MYSQL_DB_HOST || process.env.DB_HOST,
  port: process.env.MYSQL_DB_PORT || process.env.DB_PORT || 3306,
  user: process.env.MYSQL_DB_USER || process.env.DB_USER,
  password: process.env.MYSQL_DB_PASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQL_DB_NAME || process.env.DB_NAME,
};

const postgresConnectionString = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;

if (!postgresConnectionString) {
  console.error('SUPABASE_DATABASE_URL atau DATABASE_URL wajib diisi.');
  process.exit(1);
}

const getPostgresConnectionString = (connectionString) => {
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslcert');
  url.searchParams.delete('sslkey');
  url.searchParams.delete('sslrootcert');
  return url.toString();
};

const upsertRows = async (pg, table, rows) => {
  if (!rows.length) {
    console.log(`- ${table}: kosong, dilewati`);
    return;
  }

  const excludedColumns = new Set(TABLE_COLUMN_EXCLUDES[table] || []);
  const columns = Object.keys(rows[0]).filter((column) => {
    if (excludedColumns.has(column)) return false;
    return rows.some((row) => row[column] !== undefined);
  });
  const insertColumns = columns.map(quoteIdent).join(', ');
  const updates = columns
    .filter((column) => column !== 'id')
    .map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`)
    .join(', ');

  for (const row of rows) {
    const values = columns.map((column) => row[column]);
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    const conflict = columns.includes('id')
      ? `on conflict (id) do ${updates ? `update set ${updates}` : 'nothing'}`
      : 'on conflict do nothing';

    await pg.query(
      `insert into ${quoteIdent(table)} (${insertColumns}) values (${placeholders}) ${conflict}`,
      values,
    );
  }

  if (columns.includes('id')) {
    await pg.query(`
      select setval(
        pg_get_serial_sequence('${table}', 'id'),
        greatest(coalesce((select max(id) from ${quoteIdent(table)}), 1), 1),
        true
      )
    `);
  }

  console.log(`- ${table}: ${rows.length} rows migrated`);
};

const migrate = async () => {
  let mysqlConn;
  try {
    mysqlConn = await mysql.createConnection(mysqlConnectionConfig);
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.error(
        'MySQL lokal tidak bisa dihubungi. Nyalakan MySQL/XAMPP dulu jika ingin migrasi data lama, ' +
        'atau jalankan "npm run schema:supabase" jika hanya ingin membuat/update tabel Supabase.'
      );
    }
    throw error;
  }
  const pg = new Pool({
    connectionString: getPostgresConnectionString(postgresConnectionString),
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  try {
    for (const table of TABLES) {
      try {
        const [rows] = await mysqlConn.query(`SELECT * FROM \`${table}\``);
        await upsertRows(pg, table, rows);
      } catch (error) {
        if (error.code === 'ER_NO_SUCH_TABLE') {
          console.log(`- ${table}: tabel belum ada di MySQL, dilewati`);
          continue;
        }
        throw error;
      }
    }

    console.log('\nMigrasi data MySQL ke Supabase selesai.');
  } finally {
    await mysqlConn?.end();
    await pg.end();
  }
};

migrate().catch((error) => {
  console.error('Migrasi gagal:', error);
  process.exit(1);
});
