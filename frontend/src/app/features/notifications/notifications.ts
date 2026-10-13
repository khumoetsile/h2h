import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { RealtimeService } from '../../core/realtime.service';
import { Toast } from '../../core/toast.service';
import { GetApp } from '../../shared/get-app';
import { NotificationInbox, NotificationResponse } from '../../shared/notification-inbox';
import { NotificationItem, groupNotifications, notificationCategoryLabel, notificationIcon, notificationLabel, notificationLink } from '../../shared/notification-presentation';
import { AgoPipe } from '../../shared/pipes';
import { EmptyState, LoadError, SkeletonList } from '../../shared/ui';

const PAGE_SIZE = 20;

@Component({
  selector: 'app-notifications',
  imports: [DatePipe, FormsModule, RouterLink, MatIconModule, GetApp, AgoPipe, EmptyState, LoadError, SkeletonList],
  templateUrl: './notifications.html', styleUrl: './notifications.scss',
})
export class NotificationsPage implements OnInit {
  private api = inject(Api);
  protected auth = inject(AuthService);
  protected inbox = inject(NotificationInbox);
  private realtime = inject(RealtimeService);
  private toast = inject(Toast);
  private destroyRef = inject(DestroyRef);
  protected items = signal<NotificationItem[] | null>(null);
  protected groups = computed(() => groupNotifications(this.items() ?? []));
  protected unreadOnly = signal(false);
  protected category = signal('all');
  protected search = '';
  protected total = signal(0);
  protected page = signal(1);
  protected loading = signal(false);
  protected loadingMore = signal(false);
  protected error = signal('');
  protected moreError = signal('');
  protected readAllError = signal('');
  protected rowErrors = signal<Record<string, string>>({});
  protected expanded = signal<Array<number | string>>([]);
  protected categories = [{ value: 'all', label: 'All activity' }, { value: 'games', label: 'Games' }, { value: 'football', label: 'Football' }, { value: 'wallet', label: 'Wallet' }];
  protected icon = notificationIcon;
  protected label = notificationLabel;
  protected link = notificationLink;
  protected categoryLabel = notificationCategoryLabel;
  private requestSequence = 0;
  private searchQuery = '';
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor() {
    this.realtime.notification$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.scheduleRefresh());
    this.realtime.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.scheduleRefresh());
    this.inbox.changed$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((change) => {
      if (change.kind === 'read') this.items.update((items) => items && (this.unreadOnly() ? items.filter((item) => item.id !== change.id) : items.map((item) => item.id === change.id ? { ...item, isRead: true } : item)));
      else if (change.confirmed) this.items.update((items) => items && (this.unreadOnly() ? [] : items.map((item) => ({ ...item, isRead: true }))));
      this.scheduleRefresh();
    });
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      if (this.searchTimer) clearTimeout(this.searchTimer);
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
    });
  }
  ngOnInit() { void this.load(); }
  setUnread(value: boolean) { if (this.unreadOnly() !== value) { this.unreadOnly.set(value); this.reset(); } }
  setCategory(value: string) { if (this.category() !== value) { this.category.set(value); this.reset(); } }
  setSearch(value: string) {
    this.search = value; ++this.requestSequence;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { this.searchTimer = null; this.searchQuery = this.search.trim(); this.reset(); }, 300);
  }
  clearSearch() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null; this.search = ''; this.searchQuery = ''; this.reset();
  }
  private reset() {
    this.page.set(1); this.items.set(null); this.total.set(0); this.expanded.set([]); this.rowErrors.set({}); this.moreError.set(''); this.loadingMore.set(false);
    void this.load();
  }
  private scheduleRefresh() {
    ++this.requestSequence;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; void this.load(); }, 150);
  }
  async load(append = false) {
    if (append && this.loadingMore()) return;
    const sequence = ++this.requestSequence;
    const revision = this.inbox.captureRevision();
    const page = append ? this.page() + 1 : this.page();
    const params = { unread: this.unreadOnly() || null, category: this.category(), search: this.searchQuery || null, pageSize: PAGE_SIZE };
    if (append) { this.loadingMore.set(true); this.moreError.set(''); } else { this.loading.set(true); this.error.set(''); }
    try {
      // Refresh all visible pages so new entries cannot shift older boundaries
      // into duplicates or erase the activity a person is currently reading.
      const responses = await Promise.all((append ? [page] : Array.from({ length: page }, (_, index) => index + 1)).map((number) => this.api.get<NotificationResponse>('/notifications', { ...params, page: number })));
      if (this.destroyed || sequence !== this.requestSequence) return;
      const incoming = responses.flatMap((response) => response.notifications);
      const merged = append ? [...(this.items() ?? []), ...incoming] : incoming;
      this.items.set([...new Map(merged.map((item) => [item.id, item])).values()]);
      this.moreError.set('');
      this.total.set(responses.at(-1)!.total ?? incoming.length); this.page.set(page);
      this.inbox.applyCount(responses.at(-1)!.unread, revision);
    } catch (err) {
      if (this.destroyed || sequence !== this.requestSequence) return;
      if (append) this.moreError.set(apiError(err).message); else this.error.set(apiError(err).message);
    } finally { if (sequence === this.requestSequence) { this.loading.set(false); this.loadingMore.set(false); } }
  }
  toggleExpanded(id: number | string) { this.expanded.update((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]); }
  async markRead(item: NotificationItem) {
    this.rowErrors.update((errors) => ({ ...errors, [item.id]: '' }));
    try { await this.inbox.markRead(item); }
    catch (err) { this.rowErrors.update((errors) => ({ ...errors, [item.id]: apiError(err).message })); }
  }
  open(item: NotificationItem) {
    if (item.isRead) return;
    if (notificationLink(item)) void this.inbox.markRead(item).catch((err) => this.toast.error(err));
    else void this.markRead(item);
  }
  async readAll() {
    this.readAllError.set('');
    try { await this.inbox.markAllRead(); }
    catch (err) { this.readAllError.set(apiError(err).message); }
  }
}
