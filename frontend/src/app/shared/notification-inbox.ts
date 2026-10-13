import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject } from 'rxjs';
import { Api } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { RealtimeService } from '../core/realtime.service';
import { NotificationItem } from './notification-presentation';

export interface NotificationResponse {
  notifications: NotificationItem[]; unread: number; total: number; page: number; pageSize: number;
}
export type NotificationChange = { kind: 'read'; id: number | string } | { kind: 'all'; confirmed: boolean };

/** Shared mutations keep the bell and the activity page in step. */
@Injectable({ providedIn: 'root' })
export class NotificationInbox {
  private api = inject(Api);
  private auth = inject(AuthService);
  private realtime = inject(RealtimeService);
  private destroyRef = inject(DestroyRef);
  readonly pending = signal<Array<number | string>>([]);
  readonly readingAll = signal(false);
  readonly changed$ = new Subject<NotificationChange>();
  private requests = new Map<number | string, Promise<void>>();
  private realtimeRevision = 0;
  private mutationRevision = 0;
  private countSequence = 0;

  constructor() {
    this.realtime.notification$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      ++this.realtimeRevision;
      void this.refreshCount();
    });
  }

  isPending(id: number | string) { return this.pending().includes(id); }
  captureRevision() { return `${this.mutationRevision}:${this.realtimeRevision}`; }
  applyCount(unread: number, revision: string) {
    if (revision === this.captureRevision()) this.auth.unread.set(unread);
  }

  markRead(item: NotificationItem): Promise<void> {
    if (item.isRead) return Promise.resolve();
    const existing = this.requests.get(item.id);
    if (existing) return existing;
    const revision = ++this.mutationRevision;
    const realtimeRevision = this.realtimeRevision;
    this.pending.update((ids) => [...ids, item.id]);
    const request = this.api.post<{ unread: number }>(`/notifications/${encodeURIComponent(item.id)}/read`).then((response) => {
      if (revision === this.mutationRevision && realtimeRevision === this.realtimeRevision) this.auth.unread.set(response.unread);
      else void this.refreshCount();
      this.changed$.next({ kind: 'read', id: item.id });
    }).finally(() => {
      this.requests.delete(item.id);
      this.pending.update((ids) => ids.filter((id) => id !== item.id));
    });
    this.requests.set(item.id, request);
    return request;
  }

  async markAllRead() {
    if (this.readingAll()) return;
    this.readingAll.set(true);
    const revision = ++this.mutationRevision;
    const realtimeRevision = this.realtimeRevision;
    try {
      const response = await this.api.post<{ unread: number }>('/notifications/read-all');
      const current = revision === this.mutationRevision && realtimeRevision === this.realtimeRevision;
      if (current) this.auth.unread.set(response.unread); else void this.refreshCount();
      this.changed$.next({ kind: 'all', confirmed: current && response.unread === 0 });
    } finally { this.readingAll.set(false); }
  }

  private async refreshCount() {
    const sequence = ++this.countSequence;
    const realtimeRevision = this.realtimeRevision;
    const mutationRevision = this.mutationRevision;
    try {
      const response = await this.api.get<NotificationResponse>('/notifications', { pageSize: 1 });
      if (sequence === this.countSequence && realtimeRevision === this.realtimeRevision && mutationRevision === this.mutationRevision) this.auth.unread.set(response.unread);
    } catch { /* The next notification, refresh or read action obtains the current count. */ }
  }
}
