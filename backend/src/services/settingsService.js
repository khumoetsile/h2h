import { query } from '../db.js';
import { badRequest } from '../utils/errors.js';

// Defaults are used if a key is missing from admin_settings.
export const SETTING_DEFAULTS = {
  platform_fee_percent: 10,
  stake_amounts: [5, 10, 20, 50, 100, 200],
  signup_bonus: 250,
  deposit_presets: [10, 20, 50, 100, 200, 500, 1000],
  max_deposit: 10000,
  min_withdrawal: 10,
  challenge_expiry_minutes: 60,
  waiting_match_timeout_minutes: 30,
  match_start_timeout_minutes: 10,
  match_play_timeout_minutes: 10,
  football_supported_competitions: ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL'],
};

export const SETTING_DESCRIPTIONS = {
  platform_fee_percent: 'Percentage of each match pool retained by the platform (DEMO).',
  stake_amounts: 'Demo stake amounts players can choose.',
  signup_bonus: 'Demo funds credited to every new account.',
  deposit_presets: 'Preset amounts shown on the demo deposit screen.',
  max_deposit: 'Maximum single demo deposit.',
  min_withdrawal: 'Minimum demo withdrawal.',
  challenge_expiry_minutes: 'Minutes before a pending challenge expires.',
  waiting_match_timeout_minutes: 'Minutes a match waits for an opponent before auto-cancel + refund.',
  match_start_timeout_minutes: 'Minutes a matched game may sit un-started before auto-cancel + refund.',
  match_play_timeout_minutes: 'Minutes a player has to finish once the game has started (also the reconnection window used to decide a disconnected skill-game match fairly).',
  football_supported_competitions: 'Football competitions synced and offered to players (provider competition codes).',
};

let cache = null;
let cacheAt = 0;

export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 5000) return cache;
  const rows = await query('SELECT setting_key, setting_value FROM admin_settings');
  const out = { ...SETTING_DEFAULTS };
  for (const r of rows) {
    out[r.setting_key] = typeof r.setting_value === 'string' ? JSON.parse(r.setting_value) : r.setting_value;
  }
  cache = out;
  cacheAt = Date.now();
  return out;
}

export function invalidateSettings() { cache = null; }

function validate(key, value) {
  const isPosNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  switch (key) {
    case 'platform_fee_percent':
      if (typeof value !== 'number' || value < 0 || value > 50) throw badRequest('INVALID_SETTING', 'Platform fee must be between 0% and 50%.');
      return Math.round(value * 100) / 100;
    case 'stake_amounts':
    case 'deposit_presets': {
      if (!Array.isArray(value) || value.length === 0 || value.length > 12 || !value.every(isPosNum)) {
        throw badRequest('INVALID_SETTING', 'Provide between 1 and 12 positive amounts.');
      }
      if (value.some((v) => v > 100000)) throw badRequest('INVALID_SETTING', 'Amounts must be at most 100,000.');
      return [...new Set(value.map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b);
    }
    case 'signup_bonus':
      if (typeof value !== 'number' || value < 0 || value > 100000) throw badRequest('INVALID_SETTING', 'Signup bonus must be 0 – 100,000.');
      return Math.round(value * 100) / 100;
    case 'max_deposit':
    case 'min_withdrawal':
      if (!isPosNum(value) || value > 1000000) throw badRequest('INVALID_SETTING', `${key} must be a positive number.`);
      return Math.round(value * 100) / 100;
    case 'football_supported_competitions': {
      if (!Array.isArray(value) || value.length === 0 || value.length > 20 || !value.every((v) => typeof v === 'string' && /^[A-Z0-9]{2,10}$/.test(v))) {
        throw badRequest('INVALID_SETTING', 'Provide 1–20 competition codes (letters/numbers only), e.g. PL, PD, SA.');
      }
      return [...new Set(value.map((v) => v.toUpperCase()))];
    }
    default:
      if (!Number.isInteger(value) || value < 1 || value > 10080) throw badRequest('INVALID_SETTING', `${key} must be a whole number of minutes (1 – 10080).`);
      return value;
  }
}

export async function updateSettings(patch, adminId) {
  const keys = Object.keys(patch).filter((k) => k in SETTING_DEFAULTS);
  if (keys.length === 0) throw badRequest('INVALID_SETTING', 'No recognised settings supplied.');
  const clean = {};
  for (const k of keys) clean[k] = validate(k, patch[k]);
  for (const [k, v] of Object.entries(clean)) {
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, description, updated_by) VALUES (?, CAST(? AS JSON), ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
      [k, JSON.stringify(v), SETTING_DESCRIPTIONS[k] || null, adminId],
    );
  }
  invalidateSettings();
  return clean;
}

export async function getSettingRows() {
  const settings = await getSettings({ fresh: true });
  const meta = await query('SELECT setting_key, updated_at, updated_by FROM admin_settings');
  const metaMap = Object.fromEntries(meta.map((m) => [m.setting_key, m]));
  return Object.keys(SETTING_DEFAULTS).map((key) => ({
    key,
    value: settings[key],
    description: SETTING_DESCRIPTIONS[key],
    updatedAt: metaMap[key]?.updated_at || null,
  }));
}

export async function getSetting(key) {
  return (await getSettings())[key];
}

