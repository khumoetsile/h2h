import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { PwaService } from '../../core/pwa.service';
import { RealtimeService } from '../../core/realtime.service';
import { Toast } from '../../core/toast.service';
import { NotificationItem } from '../../shared/notification-presentation';
import { NotificationsPage } from './notifications';

const item = (id = 1): NotificationItem => ({ id, type: 'CHESS_TURN', title: 'Your move', message: 'A friend played e4.', link: '/chess/M-EXAMPLE', isRead: false, createdAt: new Date().toISOString(), category: 'games' });
const response = (items: NotificationItem[], total = items.length) => ({ notifications: items, unread: items.filter((n) => !n.isRead).length, total, page: 1, pageSize: 20 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }

describe('notification activity', () => {
  let get: ReturnType<typeof vi.fn>; let post: ReturnType<typeof vi.fn>; let incoming: Subject<NotificationItem>;
  beforeEach(() => {
    get = vi.fn().mockImplementation((path) => Promise.resolve(path === '/notifications' ? response([item()]) : { settings: { challenges: true, waiting: false } })); post = vi.fn().mockResolvedValue({ unread: 0 }); incoming = new Subject();
    TestBed.configureTestingModule({ imports: [NotificationsPage], providers: [provideRouter([]), { provide: Api, useValue: { get, post } }, { provide: AuthService, useValue: { unread: signal(1), isLoggedIn: () => true } },
      { provide: RealtimeService, useValue: { notification$: incoming, reconnected$: new Subject() } }, { provide: Toast, useValue: { error: vi.fn() } },
      { provide: PwaService, useValue: { pushState: signal('unsupported'), canInstall: signal(false), needsIosSteps: signal(false), refreshPush: vi.fn().mockResolvedValue(undefined) } }] });
  });
  async function page() { const fixture = TestBed.createComponent(NotificationsPage); fixture.detectChanges(); await fixture.whenStable(); await vi.waitFor(() => expect((fixture.componentInstance as any).items()).not.toBeNull()); fixture.detectChanges(); return fixture; }
  it('keeps the latest unread filter when an older request returns last', async () => {
    const fixture = await page(); const component = fixture.componentInstance as any; const old = deferred<ReturnType<typeof response>>();
    const primary = fixture.nativeElement.querySelector('.notification-primary');
    expect(fixture.nativeElement.querySelector('#'+primary.getAttribute('aria-describedby')).textContent).toContain('A friend played e4.');
    get.mockImplementationOnce(() => old.promise); const oldLoad = component.load();
    get.mockResolvedValueOnce(response([item(2)])); component.setUnread(true);
    await vi.waitFor(() => expect(component.items()[0].id).toBe(2)); old.resolve(response([item(1)])); await oldLoad;
    expect(component.items()[0].id).toBe(2); expect(get).toHaveBeenLastCalledWith('/notifications', expect.objectContaining({ unread: true }));
  });
  it('offers retry after marking read fails, then removes the row from Unread', async () => {
    const fixture = await page(); const component = fixture.componentInstance as any; component.unreadOnly.set(true);
    post.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 })); await component.markRead(item()); fixture.detectChanges();
    expect(component.items()).toHaveLength(1); expect(fixture.nativeElement.textContent).toContain('Retry marking read');
    await component.markRead(item()); expect(component.items()).toEqual([]); expect(post).toHaveBeenCalledTimes(2);
  });
  it('requests the chosen server category and appends older real activity', async () => {
    const fixture = await page(); const component = fixture.componentInstance as any;
    component.moreError.set('Previous activity could not load.');
    get.mockResolvedValueOnce(response([item(2)], 21)); component.setCategory('football'); await vi.waitFor(() => expect(component.items()[0].id).toBe(2));
    expect(get).toHaveBeenLastCalledWith('/notifications', expect.objectContaining({ category: 'football', page: 1 })); expect(component.moreError()).toBe('');
    get.mockResolvedValueOnce(response([item(3)], 21)); await component.load(true); expect(component.items().map((n: NotificationItem) => n.id)).toEqual([2, 3]); expect(component.page()).toBe(2);
  });
  it('refreshes live activity without guessing category or moving the reader', async () => {
    const fixture = await page(); const component = fixture.componentInstance as any;
    get.mockResolvedValue(response([item(2), item(1)])); incoming.next(item(2));
    await vi.waitFor(() => expect(component.items().map((n: NotificationItem) => n.id)).toEqual([2, 1]));
    expect(component.page()).toBe(1); expect(fixture.nativeElement.querySelector('details')?.open).toBe(false);
  });
  it('debounces the working notification search and clears it', async () => {
    const fixture = await page(); const component = fixture.componentInstance as any; component.setSearch('  chess  ');
    await vi.waitFor(() => expect(get).toHaveBeenLastCalledWith('/notifications', expect.objectContaining({ search: 'chess' }))); component.clearSearch();
    await vi.waitFor(() => expect(get).toHaveBeenLastCalledWith('/notifications', expect.objectContaining({ search: null })));
  });
});
