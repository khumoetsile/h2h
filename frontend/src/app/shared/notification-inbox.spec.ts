import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { Api } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { RealtimeService } from '../core/realtime.service';
import { NotificationInbox } from './notification-inbox';
import { NotificationItem, groupNotifications, notificationLink } from './notification-presentation';

const notification: NotificationItem = { id: 12, type: 'CHESS_TURN', title: 'Your move', message: 'A friend played e4.', link: '/chess/M-EXAMPLE', isRead: false, createdAt: '2026-10-13T08:00:00Z' };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

describe('notification read actions', () => {
  let post: ReturnType<typeof vi.fn>; let get: ReturnType<typeof vi.fn>; let unread: ReturnType<typeof signal<number>>; let incoming: Subject<NotificationItem>;
  beforeEach(() => {
    post = vi.fn().mockResolvedValue({ unread: 0 }); get = vi.fn().mockResolvedValue({ notifications: [], unread: 1 }); unread = signal(2); incoming = new Subject();
    TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: { post, get } }, { provide: AuthService, useValue: { unread } }, { provide: RealtimeService, useValue: { notification$: incoming } }] });
  });
  it('deduplicates repeated mark-read taps and exposes the pending state', async () => {
    const response = deferred<{ unread: number }>(); post.mockReturnValue(response.promise);
    const inbox = TestBed.inject(NotificationInbox);
    const first = inbox.markRead(notification); const second = inbox.markRead(notification);
    expect(post).toHaveBeenCalledOnce(); expect(inbox.isPending(12)).toBe(true);
    response.resolve({ unread: 1 }); await Promise.all([first, second]);
    expect(unread()).toBe(1); expect(inbox.isPending(12)).toBe(false);
  });
  it('keeps unread state on failure and permits a successful retry', async () => {
    post.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    const inbox = TestBed.inject(NotificationInbox);
    await expect(inbox.markRead(notification)).rejects.toBeTruthy();
    expect(unread()).toBe(2); expect(inbox.isPending(12)).toBe(false);
    await inbox.markRead(notification); expect(post).toHaveBeenCalledTimes(2); expect(unread()).toBe(0);
  });
  it('does not erase a new unread notification arriving during mark-all', async () => {
    const response = deferred<{ unread: number }>(); post.mockReturnValue(response.promise);
    const inbox = TestBed.inject(NotificationInbox); const changes: unknown[] = []; inbox.changed$.subscribe((change) => changes.push(change));
    const pending = inbox.markAllRead(); unread.set(3); incoming.next({ ...notification, id: 13 }); response.resolve({ unread: 0 }); await pending;
    await vi.waitFor(() => expect(unread()).toBe(1)); expect(changes).toEqual([{ kind: 'all', confirmed: false }]); expect(inbox.readingAll()).toBe(false);
  });
  it('rejects older count responses after a read action started', () => {
    const inbox = TestBed.inject(NotificationInbox); const revision = inbox.captureRevision();
    const response = deferred<{ unread: number }>(); post.mockReturnValue(response.promise); void inbox.markRead(notification);
    inbox.applyCount(20, revision); expect(unread()).toBe(2); response.resolve({ unread: 1 });
  });
});

describe('notification presentation', () => {
  it('groups by the reader’s local day and excludes unsafe destinations', () => {
    const now = new Date(2026, 9, 13, 12); const today = { ...notification, createdAt: new Date(2026, 9, 13, 8).toISOString() }; const yesterday = { ...notification, id: 13, createdAt: new Date(2026, 9, 12, 23).toISOString() };
    expect(groupNotifications([today, yesterday], now).map((group) => [group.label, group.items.length])).toEqual([['Today', 1], ['Earlier', 1]]);
    expect(notificationLink(notification)).toBe('/chess/M-EXAMPLE'); expect(notificationLink({ ...notification, link: '//example.test' })).toBeNull(); expect(notificationLink({ ...notification, link: '/\\example.test' })).toBeNull();
  });
});
