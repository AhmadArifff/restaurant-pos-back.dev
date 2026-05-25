require('dotenv').config();

const DB_CLIENT = (process.env.DB_CLIENT || 'mysql').toLowerCase();

const normalizePostgresSql = (sql) => {
  let normalized = String(sql)
    .replace(/`/g, '')
    .replace(/\bCURDATE\(\)/gi, 'CURRENT_DATE')
    .replace(/\bDAYNAME\(([^()]+)\)/gi, "TO_CHAR(CAST($1 AS DATE), 'FMDay')")
    .replace(/\bDAYOFWEEK\(([^()]+)\)/gi, '(EXTRACT(DOW FROM CAST($1 AS DATE)) + 1)')
    .replace(/\bDAY\(([^()]+)\)/gi, 'EXTRACT(DAY FROM $1)')
    .replace(/\bDATE_SUB\(NOW\(\),\s*INTERVAL\s+(\d+)\s+DAY\)/gi, "(NOW() - INTERVAL '$1 day')")
    .replace(
      /\bTIMESTAMPDIFF\(\s*MINUTE\s*,\s*([a-zA-Z0-9_.]+)\s*,\s*NOW\(\)\s*\)/gi,
      'FLOOR(EXTRACT(EPOCH FROM (NOW() - $1)) / 60)'
    )
    .replace(/\bYEAR\(([^)]+)\)/gi, 'EXTRACT(YEAR FROM $1)')
    .replace(/\bMONTH\(([^)]+)\)/gi, 'EXTRACT(MONTH FROM $1)')
    .replace(/\bDATE\(([^()]+)\)/gi, 'CAST($1 AS DATE)');

  let index = 0;
  normalized = normalized.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });

  normalized = normalized.replace(
    /\bDATE_SUB\(NOW\(\),\s*INTERVAL\s+\$(\d+)\s+DAY\)/gi,
    "(NOW() - ($$$1::int * INTERVAL '1 day'))"
  );

  if (/^\s*insert\s+/i.test(normalized) && !/\breturning\b/i.test(normalized)) {
    normalized = `${normalized.replace(/;+\s*$/, '')} RETURNING id`;
  }

  return normalized;
};

const buildPgResult = (sql, result) => {
  const command = String(result.command || '').toUpperCase();
  if (command === 'SELECT' || command === 'SHOW') return result.rows;

  const firstRow = result.rows?.[0] || {};
  return {
    insertId: firstRow.id || null,
    affectedRows: result.rowCount || 0,
    rowCount: result.rowCount || 0,
    rows: result.rows || [],
    command,
    sql,
  };
};

const escapePgValue = (value) => {
  if (value == null) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `'${value.toISOString().replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
};

const createPostgresPool = () => {
  const { Pool } = require('pg');
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.searchParams.delete('sslmode');
  databaseUrl.searchParams.delete('sslcert');
  databaseUrl.searchParams.delete('sslkey');
  databaseUrl.searchParams.delete('sslrootcert');

  const pool = new Pool({
    connectionString: databaseUrl.toString(),
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 10000),
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
  });

  const runQuery = async (executor, sql, params = []) => {
    const normalizedSql = normalizePostgresSql(sql);
    const result = await executor.query(normalizedSql, params);
    return [buildPgResult(normalizedSql, result), result.fields];
  };

  return {
    dialect: 'postgres',
    isPostgres: true,
    escape: escapePgValue,
    query: (sql, params = []) => runQuery(pool, sql, params),
    end: () => pool.end(),
    getConnection: async () => {
      const client = await pool.connect();
      return {
        query: (sql, params = []) => runQuery(client, sql, params),
        beginTransaction: () => client.query('BEGIN'),
        commit: () => client.query('COMMIT'),
        rollback: () => client.query('ROLLBACK'),
        release: () => client.release(),
      };
    },
  };
};

const createMysqlPool = () => {
  const mysql = require('mysql2/promise');

  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_MAX || 10),
  });

  pool.dialect = 'mysql';
  pool.isPostgres = false;
  return pool;
};

if (DB_CLIENT === 'postgres' && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL wajib diisi saat DB_CLIENT=postgres');
}

module.exports = DB_CLIENT === 'postgres' ? createPostgresPool() : createMysqlPool();
