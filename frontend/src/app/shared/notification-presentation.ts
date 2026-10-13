import { AppNotification } from '../core/models';

export type NotificationCategory = 'games' | 'football' | 'wallet' | 'general';
export type NotificationItem = AppNotification & { category?: NotificationCategory };
export interface NotificationGroup { label: string; items: NotificationItem[]; }

const ICONS: Record<string, string> = {
  CHESS_TURN: 'grid_view', CHESS_DRAW_OFFER: 'balance',
  CHALLENGE_RECEIVED: 'swords', CHALLENGE_ACCEPTED: 'handshake', CHALLENGE_DECLINED: 'block', CHALLENGE_EXPIRED: 'schedule',
  MATCH_FOUND: 'person_search', MATCH_STARTING: 'play_circle', MATCH_WON: 'emoji_events', MATCH_LOST: 'sentiment_dissatisfied',
  MATCH_DRAW: 'balance', MATCH_CANCELLED: 'cancel', MATCH_VOID: 'block', DEPOSIT: 'savings', WITHDRAWAL: 'payments',
  WELCOME: 'waving_hand', ADMIN: 'campaign',
};

export function notificationCategory(item: NotificationItem): NotificationCategory {
  if (item.category) return item.category;
  if (item.link?.startsWith('/football') || item.type.startsWith('FOOTBALL_')) return 'football';
  if (item.link?.startsWith('/wallet') || ['DEPOSIT', 'WITHDRAWAL'].includes(item.type)) return 'wallet';
  if (/^(MATCH_|CHESS_|CHALLENGE_|WAITING_PLAYER)/.test(item.type)) return 'games';
  return 'general';
}

export function notificationCategoryLabel(item: NotificationItem) {
  return { games: 'Games', football: 'Football', wallet: 'Wallet', general: 'Account' }[notificationCategory(item)];
}

export function notificationIcon(item: NotificationItem) {
  return notificationCategory(item) === 'football' ? 'sports_soccer' : ICONS[item.type] ?? 'notifications';
}

/** Notification destinations are local app routes, including links from administrators. */
export function notificationLink(item: NotificationItem): string | null {
  const link = item.link;
  return link?.startsWith('/') && !link.startsWith('//') && !link.includes('\\') ? link : null;
}

export function groupNotifications(items: NotificationItem[], now = new Date()): NotificationGroup[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const today = items.filter((item) => new Date(item.createdAt).getTime() >= start);
  const earlier = items.filter((item) => new Date(item.createdAt).getTime() < start || !Number.isFinite(new Date(item.createdAt).getTime()));
  return [{ label: 'Today', items: today }, { label: 'Earlier', items: earlier }].filter((group) => group.items.length);
}

export function notificationLabel(item: NotificationItem) {
  return `${item.isRead ? 'Read' : 'Unread'} notification: ${item.title}`;
}
