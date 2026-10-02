import { Component, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { AppNotification } from '../../core/models';
import { Toast } from '../../core/toast.service';
import { AgoPipe } from '../../shared/pipes';
import { EmptyState, LoadError, SkeletonList } from '../../shared/ui';

const ICONS: Record<string, string> = {
  CHALLENGE_RECEIVED: 'swords', CHALLENGE_ACCEPTED: 'handshake', CHALLENGE_DECLINED: 'block', CHALLENGE_EXPIRED: 'schedule',
  MATCH_FOUND: 'person_search', MATCH_STARTING: 'play_circle', MATCH_WON: 'emoji_events', MATCH_LOST: 'sentiment_dissatisfied',
  MATCH_DRAW: 'balance', MATCH_CANCELLED: 'cancel', DEPOSIT: 'savings', WITHDRAWAL: 'payments', WELCOME: 'waving_hand', ADMIN: 'campaign',
};

@Component({
  selector: 'app-notifications',
  imports: [MatIconModule, AgoPipe, EmptyState, LoadError, SkeletonList],
  template: `
    <div class="page page-narrow">
      <div class="page-head">
        <div><h1>Notifications</h1><p class="sub">{{ auth.unread() }} unread</p></div>
        <div class="row">
          <div class="segmented">
            <button [class.active]="!unreadOnly()" (click)="setUnread(false)">All</button>
            <button [class.active]="unreadOnly()" (click)="setUnread(true)">Unread</button>
          </div>
          <button class="btn btn-sm" [disabled]="auth.unread() === 0" (click)="readAll()"><mat-icon>done_all</mat-icon>Mark all read</button>
        </div>
      </div>
      <div class="card card-flush">
        @if (error()) { <app-load-error [message]="error()" (retry)="load()" /> }
        @else if (!items()) { <app-skeleton-list [rows]="6" /> }
        @else if (items()!.length === 0) { <app-empty icon="notifications_off" [title]="unreadOnly() ? 'No unread notifications' : 'No notifications yet'" text="Challenges, match results and wallet activity show up here." /> }
        @else {
          <div class="list">
            @for (n of items(); track n.id) {
              <div class="list-item clickable" [class.unread]="!n.isRead" (click)="open(n)">
                <span class="ic"><mat-icon>{{ icon(n.type) }}</mat-icon></span>
                <div class="grow">
                  <div class="t">{{ n.title }}</div>
                  <div class="text-2 small">{{ n.message }}</div>
                  <div class="muted tiny">{{ n.createdAt | ago }}</div>
                </div>
                @if (!n.isRead) { <button class="btn btn-ghost btn-sm" (click)="$event.stopPropagation(); markRead(n)">Mark read</button> }
              </div>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .ic { width: 36px; height: 36px; border-radius: 8px; background: var(--surface-2); display: flex; align-items: center; justify-content: center; color: var(--text-2); flex-shrink: 0; }
    .grow { flex: 1; min-width: 0; } .t { font-weight: 600; }
    .unread { background: rgba(245,112,31,.05); .ic { color: var(--accent); background: var(--accent-soft); } }
    .list-item { align-items: flex-start; }
  `],
})
export class NotificationsPage implements OnInit {
  private api = inject(Api);
  protected auth = inject(AuthService);
  private router = inject(Router);
  private toast = inject(Toast);
  protected items = signal<AppNotification[] | null>(null);
  protected unreadOnly = signal(false);
  protected error = signal('');

  ngOnInit() { this.load(); }
  icon(type: string) { return ICONS[type] ?? 'notifications'; }
  setUnread(v: boolean) { this.unreadOnly.set(v); this.items.set(null); this.load(); }

  async load() {
    this.error.set('');
    try {
      const r = await this.api.get<{ notifications: AppNotification[]; unread: number }>('/notifications', { unread: this.unreadOnly() || null });
      this.items.set(r.notifications);
      this.auth.unread.set(r.unread);
    } catch { this.error.set('Could not load notifications.'); }
  }

  async markRead(n: AppNotification) {
    try {
      const r = await this.api.post<{ unread: number }>(`/notifications/${n.id}/read`);
      this.auth.unread.set(r.unread);
      this.items.update((l) => (this.unreadOnly() ? l!.filter((x) => x.id !== n.id) : l!.map((x) => (x.id === n.id ? { ...x, isRead: true } : x))));
    } catch (err) { this.toast.error(err); }
  }

  async open(n: AppNotification) {
    if (!n.isRead) await this.markRead(n);
    if (n.link) this.router.navigateByUrl(n.link);
  }

  async readAll() {
    try {
      await this.api.post('/notifications/read-all');
      this.auth.unread.set(0);
      this.items.update((l) => (this.unreadOnly() ? [] : l!.map((x) => ({ ...x, isRead: true }))));
      this.toast.success('All notifications marked as read.');
    } catch (err) { this.toast.error(err); }
  }
}
