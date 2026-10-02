import { Injectable, computed, inject, signal } from '@angular/core';
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

  readonly token = signal<string | null>(this.readToken());
  readonly user = signal<User | null>(null);
  readonly wallet = signal<Wallet | null>(null);
  readonly unread = signal(0);
  readonly ready = signal(false);

  readonly isLoggedIn = computed(() => !!this.user());
  readonly isAdmin = computed(() => this.user()?.role === 'ADMIN');

  private readToken(): string | null {
    try { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  }

  private storeToken(token: string | null, remember = false) {
    try {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
      if (token) (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
    } catch { /* storage unavailable */ }
    this.token.set(token);
  }

  /** Called once at startup: restore the session if a token exists. */
  async init() {
    if (this.token()) {
      try { await this.refreshMe(); } catch { this.clear(); }
    }
    this.ready.set(true);
  }

  async refreshMe() {
    const me = await this.api.get<MeResponse>('/me');
    this.user.set(me.user);
    this.wallet.set(me.wallet);
    this.unread.set(me.unreadNotifications);
    return me;
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
  }

  homeUrl() { return this.isAdmin() ? '/admin' : '/dashboard'; }
}
