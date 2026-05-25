require('dotenv').config();
require('dotenv').config({ path: '.env.vercel', override: true });

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

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

const run = async () => {
  const schemaPath = path.join(process.cwd(), 'supabase', 'schema.sql');
  const sql = fs
    .readFileSync(schemaPath, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\uFEFF/g, '');
  const client = new Client({
    connectionString: getPostgresConnectionString(connectionString),
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query(sql);
    console.log('Schema Supabase berhasil diterapkan.');
  } finally {
    await client.end();
  }
};

run().catch((error) => {
  console.error('Gagal menerapkan schema Supabase:', error.message);
  process.exit(1);
});
