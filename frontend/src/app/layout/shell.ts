import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AuthService } from '../core/auth.service';
import { Api } from '../core/api.service';
import { BRAND } from '../core/brand';
import { AppNotification } from '../core/models';
import { RealtimeService } from '../core/realtime.service';
import { Avatar } from '../shared/ui';
import { ActiveMatchBar } from './active-match-bar';
import { AdsConsent } from './ads-consent';
import { AgoPipe, MoneyPipe } from '../shared/pipes';

interface NavItem { label: string; icon: string; link: string; exact?: boolean; }

// Simple destinations — a player never needs to know these map to
// "matchmaking", "wallet ledger" or any other technical concept underneath.
const PLAYER_NAV: NavItem[] = [
  { label: 'Play', icon: 'sports_esports', link: '/dashboard' },
  { label: 'Football', icon: 'sports_soccer', link: '/football' },
  { label: 'Matches', icon: 'history', link: '/matches' },
  { label: 'Challenges', icon: 'swords', link: '/challenges' },
  { label: 'Rankings', icon: 'leaderboard', link: '/leaderboard' },
  { label: 'Me', icon: 'person', link: '/profile' },
];
// Four tabs on a phone, always with a word under the icon. Challenges and Rankings live in the desktop nav and the account menu.
const PLAYER_BOTTOM = ['/dashboard', '/football', '/matches', '/profile'];

const ADMIN_NAV: NavItem[] = [
  { label: 'Overview', icon: 'monitoring', link: '/admin', exact: true },
  { label: 'Users', icon: 'group', link: '/admin/users' },
  { label: 'Matches', icon: 'sports_esports', link: '/admin/matches' },
  { label: 'Transactions', icon: 'receipt_long', link: '/admin/transactions' },
  { label: 'Challenges', icon: 'swords', link: '/admin/challenges' },
  { label: 'Games', icon: 'toggle_on', link: '/admin/games' },
  { label: 'Audit trail', icon: 'history', link: '/admin/audit' },
  { label: 'Settings', icon: 'tune', link: '/admin/settings' },
];
const ADMIN_BOTTOM = ['/admin', '/admin/users', '/admin/matches', '/admin/transactions', '/admin/settings'];

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule, MatMenuModule, MatTooltipModule, Avatar, MoneyPipe, AgoPipe, ActiveMatchBar, AdsConsent],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  protected auth = inject(AuthService);
  protected realtime = inject(RealtimeService);
  private api = inject(Api);
  private router = inject(Router);
  protected brand = BRAND;

  protected nav = computed(() => (this.auth.isAdmin() ? ADMIN_NAV : PLAYER_NAV));
  protected bottomNav = computed(() => {
    const keys = this.auth.isAdmin() ? ADMIN_BOTTOM : PLAYER_BOTTOM;
    return this.nav().filter((n) => keys.includes(n.link));
  });

  protected notifications = signal<AppNotification[]>([]);
  protected loadingNotifications = signal(false);

  constructor() {
    this.realtime.notification$.subscribe((n) => this.notifications.update((list) => [n, ...list].slice(0, 20)));
  }

  async loadNotifications() {
    this.loadingNotifications.set(true);
    try {
      const res = await this.api.get<{ notifications: AppNotification[]; unread: number }>('/notifications');
      this.notifications.set(res.notifications.slice(0, 8));
      this.auth.unread.set(res.unread);
    } catch { /* dropdown shows empty state */ }
    this.loadingNotifications.set(false);
  }

  async open(n: AppNotification) {
    if (!n.isRead) {
      try {
        const r = await this.api.post<{ unread: number }>(`/notifications/${n.id}/read`);
        this.auth.unread.set(r.unread);
        this.notifications.update((l) => l.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
      } catch { /* ignore */ }
    }
    if (n.link) this.router.navigateByUrl(n.link);
  }

  async markAllRead() {
    try {
      await this.api.post('/notifications/read-all');
      this.auth.unread.set(0);
      this.notifications.update((l) => l.map((x) => ({ ...x, isRead: true })));
    } catch { /* ignore */ }
  }

  logout() { this.auth.logout(); }
}
