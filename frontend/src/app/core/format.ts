import { BRAND } from './brand';

export function formatMoney(value: number | null | undefined, opts: { demo?: boolean; sign?: boolean } = {}) {
  const n = Number(value ?? 0);
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? '−' : opts.sign && n > 0 ? '+' : '';
  return `${sign}${BRAND.currencySymbol}${abs}${opts.demo ? ' DEMO' : ''}`;
}

export function timeAgo(date: string | Date | null | undefined) {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 604800) return `${Math.round(s / 86400)}d ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function durationLabel(seconds: number) {
  if (seconds < 60) return `~${seconds}s`;
  const m = Math.round(seconds / 60);
  return `~${m} min`;
}

export const initials = (name: string) => name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
