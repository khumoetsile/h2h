/** Literal LIKE search: users' %, _ and escape characters are not wildcards. */
export const escapeLike = value => String(value).replace(/[!%_]/g, character => `!${character}`);

/** Small natural fixture queries such as "Liverpool vs Chelsea". */
export function fixtureSearchTokens(value) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  const tokens = words.length > 1 ? words.filter(token => !/^(vs\.?|v\.?|versus)$/i.test(token)) : words;
  return [...new Set(tokens)].slice(0, 10);
}

export function validIsoDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
