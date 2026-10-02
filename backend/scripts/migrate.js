// Simple SQL migration runner. Applies migrations/*.sql in filename order and
// records them in `schema_migrations`. `--fresh` drops every table first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate({ fresh = false, log = console.log } = {}) {
  // Create the database if it doesn't exist. Shared hosts (cPanel) pre-create it
  // and deny CREATE DATABASE, so a failure here is not fatal.
  try {
    const bootstrap = await mysql.createConnection({ ...config.db, database: undefined });
    await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` CHARACTER SET utf8mb4`);
    await bootstrap.end();
  } catch (err) {
    log(`Skipping CREATE DATABASE (${err.code || err.message}); assuming it already exists.`);
  }

  const conn = await mysql.createConnection({ ...config.db });
  try {
    if (fresh) {
      const [tables] = await conn.query('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?', [config.db.database]);
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const { t } of tables) await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
      log(`Dropped ${tables.length} tables.`);
    }
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(190) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`);
    const [done] = await conn.query('SELECT name FROM schema_migrations');
    const applied = new Set(done.map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const statements = sql
        .split(/;\s*(?:\r?\n|$)/)
        .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
        .filter(Boolean);
      for (const stmt of statements) await conn.query(stmt);
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      log(`Applied ${file}`);
    }
    log('Migrations up to date.');
  } finally {
    await conn.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate({ fresh: process.argv.includes('--fresh') })
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
