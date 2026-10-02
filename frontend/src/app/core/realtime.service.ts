import { Injectable, inject, signal, computed, effect } from '@angular/core';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { AuthService } from './auth.service';
import { AppNotification, MatchView, Wallet } from './models';
import type { ShootoutState } from '../games/shootout.model';
import { Toast } from './toast.service';
import { ConfigStore } from './config.store';

// After this many seconds offline we escalate from "unstable" to "interrupted"
// wording, and start showing an elapsed-time counter (never a technical code).
const UNSTABLE_GRACE_MS = 4000;

export type ConnectionState = 'online' | 'unstable' | 'lost';

/**
 * Socket.IO connection (proxied via /socket.io). Pages also poll as a
 * fallback, so the app keeps working if the socket can't connect.
 *
 * This also owns the plain-language "network interruption" experience: a
 * player is never shown a WebSocket/HTTP error, only a friendly banner with
 * a reconnection timer. The underlying match/game state stays authoritative
 * on the server the whole time (nothing here can cause an automatic loss).
 */
@Injectable({ providedIn: 'root' })
export class RealtimeService {
  private auth = inject(AuthService);
  private toast = inject(Toast);
  private router = inject(Router);
  private configStore = inject(ConfigStore);
  private socket: Socket | null = null;

  readonly connected = signal(false);
  /** True once we've connected at least once this session — avoids showing a "reconnecting" banner during normal startup. */
  private everConnected = signal(false);
  private disconnectedAt = signal<number | null>(null);
  private now = signal(Date.now());
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private showRestored = signal(false);

  readonly match$ = new Subject<MatchView>();
  /** Live penalty shootout: this player's view after every kick or choice. */
  readonly shootout$ = new Subject<ShootoutState>();
  readonly notification$ = new Subject<AppNotification>();
  readonly challenge$ = new Subject<{ id: number }>();
  readonly queue$ = new Subject<Record<string, { total: number; byStake: Record<string, number> }>>();
  readonly leaderboard$ = new Subject<void>();
  readonly config$ = new Subject<void>();
  /** Fires once the socket comes back after being down — pages use this to refresh their view of server state. */
  readonly reconnected$ = new Subject<void>();

  /** Drives the connection banner. 'online' means nothing should be shown. */
  readonly connectionState = computed<ConnectionState>(() => {
    if (!this.everConnected() || this.connected()) return 'online';
    const since = this.disconnectedAt();
    if (!since) return 'online';
    return this.now() - since < UNSTABLE_GRACE_MS ? 'unstable' : 'lost';
  });
  readonly justRestored = computed(() => this.showRestored());
  /** Seconds offline, for a friendly "reconnecting… 0:07" readout. */
  readonly offlineSeconds = computed(() => {
    const since = this.disconnectedAt();
    return since ? Math.max(0, Math.floor((this.now() - since) / 1000)) : 0;
  });

  constructor() {
    effect(() => {
      const token = this.auth.token();
      const loggedIn = this.auth.isLoggedIn();
      if (token && loggedIn) this.connect(token); else this.disconnect();
    });
  }

  private startTicking() {
    if (this.tickHandle) return;
    this.tickHandle = setInterval(() => this.now.set(Date.now()), 1000);
  }
  private stopTicking() {
    if (this.tickHandle) { clearInterval(this.tickHandle); this.tickHandle = null; }
  }

  private connect(token: string) {
    if (this.socket) {
      if ((this.socket.auth as { token?: string }).token === token) return;
      this.disconnect();
    }
    const s = io({ path: '/socket.io', auth: { token }, transports: ['websocket', 'polling'], reconnectionDelay: 1200, reconnectionDelayMax: 6000 });
    this.socket = s;
    s.on('connect', () => {
      const wasDown = this.disconnectedAt() !== null;
      this.connected.set(true);
      this.disconnectedAt.set(null);
      this.stopTicking();
      if (wasDown && this.everConnected()) {
        this.showRestored.set(true);
        this.reconnected$.next();
        setTimeout(() => this.showRestored.set(false), 2500);
      }
      this.everConnected.set(true);
    });
    s.on('disconnect', () => {
      this.connected.set(false);
      if (this.everConnected()) {
        this.disconnectedAt.set(Date.now());
        this.now.set(Date.now());
        this.startTicking();
      }
    });
    s.on('wallet:update', (w: Wallet) => this.auth.wallet.set(w));
    s.on('notification', (n: AppNotification) => {
      this.auth.unread.update((c) => c + 1);
      this.notification$.next(n);
      // Never interrupt a focused screen (gameplay, the result reveal) with a
      // toast, and don't toast about the match you're already looking at.
      const onFocusedScreen = /\/(play|result)$/.test(this.router.url);
      if (!onFocusedScreen && !(n.link && this.router.url.startsWith(n.link))) this.toast.info(`${n.title}: ${n.message}`);
    });
    s.on('match:update', (m: MatchView) => this.match$.next(m));
    s.on('shootout:state', (st: ShootoutState) => this.shootout$.next(st));
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
    this.everConnected.set(false);
    this.disconnectedAt.set(null);
    this.stopTicking();
  }
}
