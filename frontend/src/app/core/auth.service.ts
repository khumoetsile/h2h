import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { Api } from './api.service';
import { User, Wallet } from './models';

const TOKEN_KEY = 'rivalis.token';

interface AuthResponse { user: User; token: string; expiresAt: string; }
interface MeResponse { user: User; wallet: Wallet; unreadNotifications: number; }

/**
 * Session state. "Remember me" stores the token in localStorage (30 days);
 * otherwise it lives in sessionStorage and is dropped when the tab closes.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private api = inject(Api);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  private identityVersion = 0;
  private sessionRequest: { version: number; promise: Promise<MeResponse> } | null = null;

  readonly token = signal<string | null>(this.readToken());
  readonly user = signal<User | null>(null);
  readonly wallet = signal<Wallet | null>(null);
  readonly unread = signal(0);
  readonly ready = signal(false);
  /** A saved session could not be checked because the service is unavailable. Its token is retained. */
  readonly sessionUnavailable = signal(false);
  readonly sessionRefreshing = signal(false);

  readonly isLoggedIn = computed(() => !!this.user());
  readonly isAdmin = computed(() => this.user()?.role === 'ADMIN');

  constructor() {
    const retry = () => { if (this.sessionUnavailable() && this.token() && !document.hidden) void this.retrySession(); };
    const timer = setInterval(retry, 15000);
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retry);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retry);
    });
  }

  private readToken(): string | null {
    try { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  }

  private storeToken(token: string | null, remember = false) {
    ++this.identityVersion;
    try {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
      if (token) (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
    } catch { /* storage unavailable */ }
    this.token.set(token);
    this.sessionUnavailable.set(false);
  }

  /** Called once at startup: restore the session if a token exists. */
  async init() {
    if (this.token()) {
      try { await this.refreshMe(); } catch { /* refreshMe distinguishes an invalid session from an unavailable service */ }
    }
    this.ready.set(true);
  }

  refreshMe(): Promise<MeResponse> {
    const version = this.identityVersion;
    if (this.sessionRequest?.version === version) return this.sessionRequest.promise;
    const savedToken = this.token();
    this.sessionRefreshing.set(true);
    const request: Promise<MeResponse> = Promise.resolve().then(() => this.api.get<MeResponse>('/me')).then((me) => {
      // A delayed response for an account that was signed out/replaced must never restore that account.
      if (version !== this.identityVersion || savedToken !== this.token()) throw new Error('The session changed while it was being checked.');
      this.user.set(me.user);
      this.wallet.set(me.wallet);
      this.unread.set(me.unreadNotifications);
      this.sessionUnavailable.set(false);
      return me;
    }).catch((err: unknown) => {
      if (version === this.identityVersion && savedToken && savedToken === this.token()) {
        if (this.invalidSession(err)) this.clear();
        else this.sessionUnavailable.set(true);
      }
      throw err;
    }).finally(() => {
      if (this.sessionRequest?.promise === request) { this.sessionRequest = null; this.sessionRefreshing.set(false); }
    });
    this.sessionRequest = { version, promise: request };
    return request;
  }

  private invalidSession(err: unknown) {
    if (!(err instanceof HttpErrorResponse)) return false;
    if (err.status === 401) return true;
    const detail = err.error?.error;
    return err.status === 403 && (/^(ACCOUNT_DISABLED|USER_DISABLED|DISABLED)$/.test(detail?.code ?? '') || (detail?.code === 'FORBIDDEN' && /disabled/i.test(detail?.message ?? '')));
  }

  /** A manual/automatic retry always checks the saved account; it never creates a replacement guest. */
  async retrySession(): Promise<boolean> {
    if (!this.token()) { this.sessionUnavailable.set(false); return false; }
    const recoveringUnknownAccount = !this.user() && this.sessionUnavailable();
    try {
      await this.refreshMe();
      if (recoveringUnknownAccount && /^\/login(?:\?|$)/.test(this.router.url)) {
        const next = this.router.parseUrl(this.router.url).queryParams['next'];
        const safeNext = typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !/^\/(login|register)(?:[/?#]|$)/.test(next);
        await this.router.navigateByUrl(!this.isAdmin() && safeNext ? next : this.homeUrl());
      }
      return true;
    } catch { return false; }
  }

  async login(identifier: string, password: string, remember: boolean) {
    const res = await this.api.post<AuthResponse>('/auth/login', { identifier, password, remember });
    this.storeToken(res.token, remember);
    await this.refreshMe();
    return res.user;
  }

  async register(data: Record<string, unknown>) {
    const res = await this.api.post<AuthResponse>('/auth/register', data);
    this.storeToken(res.token, !!data['remember']);
    await this.refreshMe();
    return res.user;
  }

  /** No form: a guest account with a generated name, so someone can play before deciding to sign up. */
  async guest() {
    if (this.user() && this.token()) return this.user()!;
    if (this.token()) {
      if (await this.retrySession() && this.user()) return this.user()!;
      throw new HttpErrorResponse({ status: this.token() ? 503 : 401, error: { error: {
        code: this.token() ? 'SESSION_UNAVAILABLE' : 'SESSION_EXPIRED',
        message: this.token() ? 'We are reconnecting your existing account. Use Retry account above before starting a game. Your saved account has been kept.' : 'Your saved session has expired. Sign in to your account to continue.',
      } } });
    }
    const res = await this.api.post<AuthResponse>('/auth/guest', {});
    this.storeToken(res.token, true);
    await this.refreshMe();
    return res.user;
  }

  /** A guest saves their account by choosing a password (and, if they like, a different name). */
  async claim(password: string, username?: string) {
    const res = await this.api.post<{ user: User }>('/auth/claim', username ? { password, username } : { password });
    this.user.set(res.user);
    return res.user;
  }

  /** Account with just a name and password, for people arriving from an invite link. */
  async quickSignup(username: string, password: string) {
    const res = await this.api.post<AuthResponse>('/auth/quick', { username, password });
    this.storeToken(res.token, true);
    await this.refreshMe();
    return res.user;
  }

  async logout() {
    try { await this.api.post('/auth/logout'); } catch { /* token may already be invalid */ }
    this.clear();
    await this.router.navigateByUrl('/login');
  }

  /** Drop local session state (e.g. after a 401). */
  clear() {
    this.storeToken(null);
    this.user.set(null);
    this.wallet.set(null);
    this.unread.set(0);
    this.sessionUnavailable.set(false);
  }

  homeUrl() { return this.isAdmin() ? '/admin' : '/dashboard'; }
}
