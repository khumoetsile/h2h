import { Injectable, inject, signal, effect } from '@angular/core';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { AuthService } from './auth.service';
import { AppNotification, MatchView, Wallet } from './models';
import { Toast } from './toast.service';
import { ConfigStore } from './config.store';

/**
 * Socket.IO connection (proxied via /socket.io). Pages also poll as a
 * fallback, so the app keeps working if the socket can't connect.
 */
@Injectable({ providedIn: 'root' })
export class RealtimeService {
  private auth = inject(AuthService);
  private toast = inject(Toast);
  private router = inject(Router);
  private configStore = inject(ConfigStore);
  private socket: Socket | null = null;

  readonly connected = signal(false);
  readonly match$ = new Subject<MatchView>();
  readonly notification$ = new Subject<AppNotification>();
  readonly challenge$ = new Subject<{ id: number }>();
  readonly queue$ = new Subject<Record<string, { total: number; byStake: Record<string, number> }>>();
  readonly leaderboard$ = new Subject<void>();
  readonly config$ = new Subject<void>();

  constructor() {
    effect(() => {
      const token = this.auth.token();
      const loggedIn = this.auth.isLoggedIn();
      if (token && loggedIn) this.connect(token); else this.disconnect();
    });
  }

  private connect(token: string) {
    if (this.socket) {
      if ((this.socket.auth as { token?: string }).token === token) return;
      this.disconnect();
    }
    const s = io({ path: '/socket.io', auth: { token }, transports: ['websocket', 'polling'], reconnectionDelay: 1500 });
    this.socket = s;
    s.on('connect', () => this.connected.set(true));
    s.on('disconnect', () => this.connected.set(false));
    s.on('wallet:update', (w: Wallet) => this.auth.wallet.set(w));
    s.on('notification', (n: AppNotification) => {
      this.auth.unread.update((c) => c + 1);
      this.notification$.next(n);
      // Don't toast about the match you're already looking at.
      if (!(n.link && this.router.url.startsWith(n.link))) this.toast.info(`${n.title} — ${n.message}`);
    });
    s.on('match:update', (m: MatchView) => this.match$.next(m));
    s.on('challenge:update', (c: { id: number }) => this.challenge$.next(c));
    s.on('queue:update', (q: Record<string, { total: number; byStake: Record<string, number> }>) => this.queue$.next(q));
    s.on('leaderboard:update', () => this.leaderboard$.next());
    s.on('config:update', () => { this.configStore.load(); this.config$.next(); });
    s.on('session:revoked', () => {
      this.auth.clear();
      this.router.navigate(['/login'], { queryParams: { reason: 'disabled' } });
    });
  }

  private disconnect() {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.connected.set(false);
  }
}
