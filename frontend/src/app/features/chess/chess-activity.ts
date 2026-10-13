import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { apiError } from '../../core/api-error';
import { ChessGame, chessStatus } from '../../core/chess';
import { formatMoney } from '../../core/format';
import { RealtimeService } from '../../core/realtime.service';
import { ServerClock, formatRemaining } from '../../core/server-clock';
import { LoadError, Spinner } from '../../shared/ui';
import { ChessPiece } from './chess-piece';

@Component({
  selector: 'app-chess-activity',
  imports: [RouterLink, DatePipe, LoadError, Spinner, ChessPiece],
  template: `
    @if (auth.isLoggedIn() && (!activeOnly() || loading() || error() || shown().length)) {
      <section class="activity" [class.compact]="compact()" aria-labelledby="chess-activity-title">
        <div class="head"><div><span class="eyebrow">PLAY AT YOUR PACE</span><h2 id="chess-activity-title">Your chess games</h2></div><a class="link" routerLink="/chess">New game <span aria-hidden="true">↗</span></a></div>
        @if (error()) { <app-load-error [message]="error()" (retry)="load()" /> }
        @else if (loading()) { <app-spinner [size]="24" /> }
        @else if (!shown().length) { <p class="empty">Your next rivalry starts with one move. <a routerLink="/chess">Invite a friend to chess.</a></p> }
        @else { <div class="rows">@for (game of shown(); track game.code) {
          <a class="game-row" [routerLink]="['/chess',game.code]">
            <div class="piece"><app-chess-piece [piece]="game.isYourTurn ? 'N' : 'n'" /></div>
            <div class="grow"><strong>{{ opponent(game) }}</strong><span>{{ money(game.stake) }} demo entry · {{ game.code }}</span>
              @if (game.status === 'ACTIVE') { <span class="deadline">{{ game.isYourTurn ? 'Move due in ' : 'Opponent due in ' }}{{ remaining(game.turnDeadline) }} · {{ game.turnDeadline | date:'MMM d, h:mm a' }}</span> }
              @else if (game.status === 'PENDING') { <span class="deadline">Invitation expires in {{ remaining(game.inviteExpiresAt) }}</span> }
            </div>
            <span class="state" [class.your-turn]="game.isYourTurn || game.canAccept">{{ status(game) }} <span aria-hidden="true">→</span></span>
          </a>
        }</div> }
        @if (sorted().length > limit()) { <a class="all" routerLink="/chess">View all {{ sorted().length }} chess games</a> }
      </section>
    }
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .activity { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
    .head { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 20px; }
    .eyebrow { color: #d9c891; font-size: 10px; letter-spacing: .15em; font-weight: 600; }
    h2 { font-family: var(--font-display); font-size: 25px; margin: 3px 0 0; }
    .link,.all { color: var(--accent); font-weight: 600; min-height: 44px; display: flex; align-items: center; gap: 8px; }
    .all { justify-content: center; padding: 10px; border-top: 1px solid var(--border); }
    .empty { padding: 0 20px 22px; color: var(--text-2); }.empty a { text-decoration: underline; }
    .game-row { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-top: 1px solid var(--border); min-height: 72px; }
    .game-row:hover { background: var(--surface-2); }
    .piece { width: 38px; height: 42px; flex-shrink: 0; }.grow { flex: 1; min-width: 0; display: grid; gap: 2px; }
    .grow strong { overflow-wrap: anywhere; }.grow > span { color: var(--muted); font-size: 12px; }
    .state { color: var(--text-2); font-size: 13px; text-align: right; max-width: 135px; }.your-turn { color: var(--win); font-weight: 600; }
    .grow .deadline { color: #d9c891; font-size: 11px; }.compact .head { padding-block: 15px; }
    @media(max-width:400px) { .head,.game-row { padding: 14px; }.head { align-items: flex-start; }.state { max-width: 94px; }.piece { width: 30px; } }
  `],
})
export class ChessActivity {
  protected auth = inject(AuthService);
  private api = inject(Api);
  private destroyRef = inject(DestroyRef);
  private clock = inject(ServerClock);
  private realtime = inject(RealtimeService);
  readonly limit = input(4);
  readonly activeOnly = input(false);
  readonly compact = input(false);
  protected games = signal<ChessGame[]>([]);
  protected loading = signal(true);
  protected error = signal('');
  protected sorted = computed(() => this.games().filter((g) => !this.activeOnly() || g.status === 'ACTIVE' || g.status === 'PENDING').sort((a,b) => {
    const rank = (g: ChessGame) => g.status === 'ACTIVE' && g.isYourTurn ? 0 : g.status === 'PENDING' && g.canAccept ? 1 : g.status === 'ACTIVE' ? 2 : g.status === 'PENDING' ? 3 : 4;
    return rank(a) - rank(b) || Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt);
  }));
  protected shown = computed(() => this.sorted().slice(0, this.limit()));
  protected money = formatMoney;
  protected status = chessStatus;
  private inFlight = false;
  private refreshQueued = false;
  constructor() {
    void this.load();
    const timer = setInterval(() => { if (!document.hidden) void this.load(false); }, 30000);
    this.realtime.chess$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.load(false));
    this.realtime.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.load(false));
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }
  async load(showLoading = true) {
    if (!this.auth.isLoggedIn()) { this.loading.set(false); return; }
    if (this.inFlight) { this.refreshQueued = true; return; }
    this.inFlight = true;
    if (showLoading) this.loading.set(true);
    try { this.games.set((await this.api.get<{ items: ChessGame[] }>('/chess')).items); this.error.set(''); }
    catch (err) { this.error.set(apiError(err).message); }
    finally { this.inFlight = false; this.loading.set(false); if (this.refreshQueued) { this.refreshQueued = false; void this.load(false); } }
  }
  protected opponent(game: ChessGame) { return game.viewerColor === 'b' ? game.white.username : game.black?.username ?? 'Friend invitation'; }
  protected remaining(deadline: string | null) { return formatRemaining(this.clock.remainingMs(deadline)); }
}
