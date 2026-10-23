import { ExperienceMeasurement } from '../core/experience-measurement';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AuthService } from '../core/auth.service';
import { Api } from '../core/api.service';
import { BRAND } from '../core/brand';
import { PwaService } from '../core/pwa.service';
import { AppNotification } from '../core/models';
import { RealtimeService } from '../core/realtime.service';
import { Avatar } from '../shared/ui';
import { ActiveMatchBar } from './active-match-bar';
import { AdsConsent } from './ads-consent';
import { AgoPipe, MoneyPipe } from '../shared/pipes';
import { Toast } from '../core/toast.service';
import { NotificationInbox, NotificationResponse } from '../shared/notification-inbox';
import { NotificationItem, groupNotifications, notificationIcon, notificationLabel, notificationLink } from '../shared/notification-presentation';

interface NavItem { label: string; icon: string; link: string; exact?: boolean; }

// Simple destinations — a player never needs to know these map to
// "matchmaking", "wallet ledger" or any other technical concept underneath.
const PLAYER_NAV: NavItem[] = [
  { label: 'Home', icon: 'sports_esports', link: '/dashboard' },
  { label: 'Football', icon: 'sports_soccer', link: '/football' },
  { label: 'Daily Predictions', icon: 'sports_soccer', link: '/daily-predictions' },
  { label: 'Fantasy Arena', icon: 'groups', link: '/arena' },
  { label: 'My Activity', icon: 'history', link: '/matches' },
  { label: 'Challenges', icon: 'swords', link: '/challenges' },
  { label: 'Rankings', icon: 'leaderboard', link: '/leaderboard' },
  { label: 'Me', icon: 'person', link: '/profile' },
];
// Five tabs on a phone, always with a word under the icon. Challenges and Rankings live in the desktop nav and the account menu.
const PLAYER_BOTTOM = ['/dashboard', '/football', '/arena', '/challenges', '/profile'];

const ADMIN_NAV: NavItem[] = [
  { label: 'Overview', icon: 'monitoring', link: '/admin', exact: true },
  { label: 'Users', icon: 'group', link: '/admin/users' },
  { label: 'Matches', icon: 'sports_esports', link: '/admin/matches' },
  { label: 'Transactions', icon: 'receipt_long', link: '/admin/transactions' },
  { label: 'Challenges', icon: 'swords', link: '/admin/challenges' },
  { label: 'Games', icon: 'toggle_on', link: '/admin/games' },
  { label: 'Daily Predictions', icon: 'sports_soccer', link: '/admin/daily-predictions' },
  { label: 'Fantasy Arena', icon: 'groups', link: '/admin/arenas' },
  { label: 'Audit trail', icon: 'history', link: '/admin/audit' },
  { label: 'Settings', icon: 'tune', link: '/admin/settings' },
];
const ADMIN_BOTTOM = ['/admin', '/admin/users', '/admin/matches', '/admin/transactions', '/admin/settings'];
const PUBLIC_NAV: NavItem[] = [{label:'Rankings',icon:'leaderboard',link:'/leaderboard'}, { label: 'Daily Predictions', icon: 'sports_soccer', link: '/daily-predictions' }, { label: 'Chess', icon: 'grid_view', link: '/chess' }, { label: 'Football', icon: 'sports_soccer', link: '/football' }, { label: 'Fantasy Arena', icon: 'groups', link: '/arena' }];

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, MatIconModule, MatMenuModule, MatTooltipModule, Avatar, MoneyPipe, AgoPipe, ActiveMatchBar, AdsConsent],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  protected auth = inject(AuthService);
  protected measurement = inject(ExperienceMeasurement);
  protected realtime = inject(RealtimeService);
  protected pwa = inject(PwaService);
  private api = inject(Api);
  protected router = inject(Router);
  protected brand = BRAND;

  protected nav = computed(() => !this.auth.isLoggedIn() ? PUBLIC_NAV : (this.auth.isAdmin() ? ADMIN_NAV : PLAYER_NAV));
  protected desktopNav = computed(() => this.nav().filter(n => !this.auth.isLoggedIn() || this.auth.isAdmin() || !['/daily-predictions','/profile'].includes(n.link)));
  protected bottomNav = computed(() => {
    if (!this.auth.isLoggedIn()) return PUBLIC_NAV.map(n=>n.link==='/daily-predictions'?{...n,label:'Picks'}:n.link==='/arena'?{...n,label:'Arena'}:n);
    const keys = this.auth.isAdmin() ? ADMIN_BOTTOM : PLAYER_BOTTOM;
    return this.nav().filter((n) => keys.includes(n.link)).map(n=>n.link==='/arena'?{...n,label:'Arena'}:n);
  });
  protected navIsActive(item: NavItem) {
    if (item.link === '/dashboard' && /^\/(dashboard|games|chess)(\/|\?|$)/.test(this.router.url)) return true;
    return this.router.isActive(item.link, { paths: item.exact ? 'exact' : 'subset', queryParams: 'ignored', matrixParams: 'ignored', fragment: 'ignored' });
  }

  protected inbox = inject(NotificationInbox);
  private destroyRef = inject(DestroyRef);
  private toast = inject(Toast);
  protected notifications = signal<NotificationItem[]>([]);
  protected notificationGroups = computed(() => groupNotifications(this.notifications()));
  protected loadingNotifications = signal(false);
  protected notificationError = signal('');
  protected notificationActionError = signal('');
  protected notificationIcon = notificationIcon;
  protected notificationLabel = notificationLabel;
  protected notificationLink = notificationLink;
  private notificationSequence = 0;
  private notificationMenuOpen = false;
  private notificationRefresh: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.realtime.notification$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.refreshNotifications());
    this.realtime.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.refreshNotifications());
    this.inbox.changed$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((change) => {
      this.notifications.update((items) => change.kind === 'read' ? items.map((item) => item.id === change.id ? { ...item, isRead: true } : item) : change.confirmed ? items.map((item) => ({ ...item, isRead: true })) : items);
      this.refreshNotifications();
    });
    this.destroyRef.onDestroy(() => { ++this.notificationSequence; if (this.notificationRefresh) clearTimeout(this.notificationRefresh); });
  }

  notificationMenuOpened() { this.notificationMenuOpen = true; void this.loadNotifications(); }
  notificationMenuClosed() { this.notificationMenuOpen = false; }
  private refreshNotifications() {
    ++this.notificationSequence;
    if (!this.notificationMenuOpen) return;
    if (this.notificationRefresh) clearTimeout(this.notificationRefresh);
    this.notificationRefresh = setTimeout(() => { this.notificationRefresh = null; void this.loadNotifications(); }, 150);
  }

  async loadNotifications() {
    const sequence = ++this.notificationSequence;
    const revision = this.inbox.captureRevision();
    this.loadingNotifications.set(true);
    this.notificationError.set('');
    try {
      const res = await this.api.get<NotificationResponse>('/notifications', { pageSize: 8 });
      if (sequence !== this.notificationSequence) return;
      this.notifications.set(res.notifications);
      this.inbox.applyCount(res.unread, revision);
    } catch {
      if (sequence === this.notificationSequence) this.notificationError.set('Could not load your activity. Try again.');
    } finally { if (sequence === this.notificationSequence) this.loadingNotifications.set(false); }
  }

  async open(n: AppNotification) {
    if (!n.isRead) {
      try { await this.inbox.markRead(n); }
      catch (err) { this.toast.error(err); }
    }
  }

  async markAllRead() {
    this.notificationActionError.set('');
    try { await this.inbox.markAllRead(); }
    catch { this.notificationActionError.set('Could not mark notifications as read. Try again.'); }
  }

  logout() { this.auth.logout(); }
}
