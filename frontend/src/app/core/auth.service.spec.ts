import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TimeoutError } from 'rxjs';
import { Api } from './api.service';
import { AuthService } from './auth.service';
import { User, Wallet } from './models';

const STORAGE_KEY = 'rivalis.token';
const savedGuest: User = {
  id: 42, firstName: 'Guest', lastName: '', username: 'Guest42', email: '', phone: '', role: 'PLAYER', status: 'ACTIVE',
  bio: null, avatarColor: '#d9c891', isGuest: true, createdAt: '2026-10-13T10:00:00Z',
};
const wallet: Wallet = { id: 42, currency: 'BWP', available: 245, locked: 5, total: 250, isDemo: true, updatedAt: '2026-10-13T10:00:00Z' };
const me = { user: savedGuest, wallet, unreadNotifications: 2 };

describe('saved session recovery', () => {
  let get: ReturnType<typeof vi.fn>;
  let post: ReturnType<typeof vi.fn>;
  let router: { url: string; parseUrl: ReturnType<typeof vi.fn>; navigateByUrl: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem(STORAGE_KEY, 'saved-guest-token');
    get = vi.fn(); post = vi.fn();
    router = { url: '/chess/M-RECOVERY', parseUrl: vi.fn(), navigateByUrl: vi.fn().mockResolvedValue(true), navigate: vi.fn().mockResolvedValue(true) };
    TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: { get, post } }, { provide: Router, useValue: router }] });
  });
  afterEach(() => { TestBed.resetTestingModule(); localStorage.clear(); sessionStorage.clear(); });
  it.each([
    ['network failure', new HttpErrorResponse({ status: 0 })],
    ['server restart', new HttpErrorResponse({ status: 503 })],
    ['request timeout', new TimeoutError()],
  ])('retains the stored token after %s and restores the same guest and held wallet', async (_name, failure) => {
    get.mockRejectedValueOnce(failure).mockResolvedValueOnce(me);
    const auth = TestBed.inject(AuthService);
    await auth.init();
    expect(auth.ready()).toBe(true);
    expect(auth.user()).toBeNull();
    expect(auth.sessionUnavailable()).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('saved-guest-token');
    expect(await auth.retrySession()).toBe(true);
    expect(auth.user()?.id).toBe(42);
    expect(auth.wallet()?.locked).toBe(5);
    expect(auth.unread()).toBe(2);
    expect(auth.sessionUnavailable()).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
  it('clears a session only after a confirmed invalid-token response', async () => {
    get.mockRejectedValue(new HttpErrorResponse({ status: 401 }));
    const auth = TestBed.inject(AuthService);
    await auth.init();
    expect(auth.token()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(auth.sessionUnavailable()).toBe(false);
  });
  it('clears a confirmed disabled account but retains a generic permission failure', async () => {
    get.mockRejectedValueOnce(new HttpErrorResponse({ status: 403, error: { error: { code:'FORBIDDEN',message:'Access temporarily denied' } } }));
    const auth = TestBed.inject(AuthService);
    await auth.init();
    expect(auth.token()).toBe('saved-guest-token');
    get.mockRejectedValueOnce(new HttpErrorResponse({ status:403, error:{error:{code:'FORBIDDEN',message:'This account is disabled'}} }));
    await auth.retrySession();
    expect(auth.token()).toBeNull();
  });
  it('does not replace an existing unverified guest token when a game action is attempted', async () => {
    get.mockRejectedValue(new HttpErrorResponse({ status: 503 }));
    const auth = TestBed.inject(AuthService);
    await auth.init();
    await expect(auth.guest()).rejects.toMatchObject({status:503,error:{error:{code:'SESSION_UNAVAILABLE'}}});
    expect(post).not.toHaveBeenCalled();
    expect(auth.token()).toBe('saved-guest-token');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('saved-guest-token');
  });
  it('recovers an existing guest before continuing a game action', async () => {
    get.mockRejectedValueOnce(new HttpErrorResponse({ status:0 })).mockResolvedValueOnce(me);
    const auth = TestBed.inject(AuthService);
    await auth.init();
    expect((await auth.guest()).id).toBe(42);
    expect(post).not.toHaveBeenCalled();
    expect(auth.token()).toBe('saved-guest-token');
  });
  it('shares a single session refresh across concurrent retries', async () => {
    let resolve!: (value: typeof me) => void;
    get.mockReturnValue(new Promise((done) => { resolve = done; }));
    const auth = TestBed.inject(AuthService);
    const first = auth.retrySession(); const second = auth.retrySession();
    await Promise.resolve();
    expect(get).toHaveBeenCalledOnce();
    resolve(me);
    expect(await first).toBe(true); expect(await second).toBe(true);
    expect(auth.sessionRefreshing()).toBe(false);
  });
  it('does not restore a late session response after sign-out', async () => {
    let resolve!: (value: typeof me) => void;
    get.mockReturnValue(new Promise((done) => { resolve = done; }));
    const auth = TestBed.inject(AuthService);
    const restore = auth.retrySession();
    await Promise.resolve(); auth.clear(); resolve(me);
    expect(await restore).toBe(false);
    expect(auth.user()).toBeNull(); expect(auth.token()).toBeNull(); expect(auth.wallet()).toBeNull();
  });
  it('returns to the saved chess link when a guarded session recovers on the sign-in page', async () => {
    router.url = '/login?next=%2Fchess%2FM-RECOVERY';
    router.parseUrl.mockReturnValue({queryParams:{next:'/chess/M-RECOVERY'}});
    get.mockRejectedValueOnce(new HttpErrorResponse({ status:0 })).mockResolvedValueOnce(me);
    const auth = TestBed.inject(AuthService);
    await auth.init(); await auth.retrySession();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/chess/M-RECOVERY');
  });
  it('retains a newly created guest when its follow-up account check fails', async () => {
    localStorage.clear();
    post.mockResolvedValue({user:savedGuest,token:'new-guest-token',expiresAt:'2026-11-13T10:00:00Z'});
    get.mockRejectedValueOnce(new HttpErrorResponse({status:503})).mockResolvedValueOnce(me);
    const auth = TestBed.inject(AuthService);
    await expect(auth.guest()).rejects.toBeInstanceOf(HttpErrorResponse);
    expect(auth.token()).toBe('new-guest-token');
    expect((await auth.guest()).id).toBe(42);
    expect(post).toHaveBeenCalledExactlyOnceWith('/auth/guest',{});
  });
});
