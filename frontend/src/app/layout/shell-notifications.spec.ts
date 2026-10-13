import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { OverlayContainer } from '@angular/cdk/overlay';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Api } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { PwaService } from '../core/pwa.service';
import { RealtimeService } from '../core/realtime.service';
import { Toast } from '../core/toast.service';
import { ActiveMatchBar } from './active-match-bar';
import { AdsConsent } from './ads-consent';
import { Shell } from './shell';

@Component({ selector: 'app-active-match-bar', template: '' }) class MatchBarStub {}
@Component({ selector: 'app-ads-consent', template: '' }) class ConsentStub {}
const activity = { id: 7, title: 'Your move', message: 'A friend played e4.', type: 'CHESS_TURN', category: 'games', link: '/chess/M-EXAMPLE', isRead: false, createdAt: new Date().toISOString() };

describe('notification bell menu', () => {
  let get: ReturnType<typeof vi.fn>; let post: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    get = vi.fn().mockResolvedValue({ notifications: [activity], unread: 1, total: 1, page: 1, pageSize: 8 }); post = vi.fn().mockResolvedValue({ unread: 0 });
    TestBed.configureTestingModule({ imports: [Shell], providers: [provideRouter([]), provideNoopAnimations(), { provide: Api, useValue: { get, post } },
      { provide: AuthService, useValue: { user: signal({ id: 1, username: 'Player', firstName: 'Test', lastName: 'Player' }), unread: signal(1), wallet: signal(null), isLoggedIn: () => true, isAdmin: () => false, homeUrl: () => '/dashboard' } },
      { provide: PwaService, useValue: { updateAvailable: signal(false) } }, { provide: RealtimeService, useValue: { notification$: new Subject(), reconnected$: new Subject() } }, { provide: Toast, useValue: { error: vi.fn() } }] });
    TestBed.overrideComponent(Shell, { remove: { imports: [ActiveMatchBar, AdsConsent] }, add: { imports: [MatchBarStub, ConsentStub] } });
  });
  it('opens semantic menu items and closes with Escape, restoring the bell focus', async () => {
    const fixture = TestBed.createComponent(Shell); fixture.detectChanges();
    const bell = fixture.nativeElement.querySelector('.icon-btn') as HTMLButtonElement; bell.click(); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const row = overlay.querySelector('.np-item') as HTMLElement;
    expect(row.getAttribute('role')).toBe('menuitem'); expect(row.getAttribute('aria-label')).toContain('Unread notification'); expect(row.textContent).toContain('Your move');
    expect(document.getElementById(row.getAttribute('aria-describedby')!)?.textContent).toContain('A friend played e4.');
    const panel = overlay.querySelector('[role="menu"]') as HTMLElement; panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    fixture.detectChanges(); await fixture.whenStable();
    await vi.waitFor(() => expect(overlay.querySelector('[role="menu"]')).toBeNull()); expect(document.activeElement).toBe(bell);
  });
  it('shows a retry error instead of a false empty state after loading fails', async () => {
    get.mockRejectedValueOnce(new Error('Unavailable'));
    const fixture = TestBed.createComponent(Shell); fixture.detectChanges(); (fixture.nativeElement.querySelector('.icon-btn') as HTMLButtonElement).click(); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const overlay = TestBed.inject(OverlayContainer).getContainerElement(); expect(overlay.textContent).toContain('Retry loading activity'); expect(overlay.textContent).not.toContain('You’re all caught up.');
    await fixture.componentInstance.loadNotifications(); fixture.detectChanges(); expect(overlay.textContent).toContain('Your move');
  });
});
