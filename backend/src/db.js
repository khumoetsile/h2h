import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 15,
  decimalNumbers: true,
  timezone: 'Z',
  dateStrings: false,
  multipleStatements: false,
});

// Keep every connection in UTC so CURRENT_TIMESTAMP and JS Dates agree.
pool.pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

export async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/**
 * Run `fn` inside a DB transaction. `fn` receives a connection with
 * `q(sql, params)` / `one(sql, params)` helpers. Retries on deadlock.
 */
export async function withTransaction(fn, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const conn = await pool.getConnection();
    const hooks = [];
    const tx = {
      conn,
      q: async (sql, params = []) => (await conn.query(sql, params))[0],
      one: async (sql, params = []) => (await conn.query(sql, params))[0][0] || null,
      /** Register a side effect (socket emit etc.) that runs only if the tx commits. */
      afterCommit: (hook) => hooks.push(hook),
    };
    try {
      await conn.beginTransaction();
      const result = await fn(tx);
      await conn.commit();
      for (const hook of hooks) {
        try { await hook(); } catch (e) { console.error('afterCommit hook failed', e); }
      }
      return result;
    } catch (err) {
      try { await conn.rollback(); } catch { /* ignore */ }
      const retryable = err && (err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_LOCK_WAIT_TIMEOUT');
      if (retryable && attempt < retries) continue;
      throw err;
    } finally {
      conn.release();
    }
  }
}
