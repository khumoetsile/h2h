import { query } from '../db.js';

/** Record a background/provider failure for the admin "system errors" view. Never throws. */
export async function logSystemError(source, err) {
  const message = (err?.message || String(err)).slice(0, 500);
  const detail = err?.stack ? String(err.stack).slice(0, 4000) : null;
  console.error(`[${source}]`, message);
  try {
    await query('INSERT INTO system_errors (source, message, detail) VALUES (?, ?, ?)', [source, message, detail]);
  } catch (e) {
    console.error('Failed to record system error', e);
  }
}
