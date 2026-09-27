import { Component, computed, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { Game, MatchView, StakeOption } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { Toast } from '../../core/toast.service';
import { durationLabel } from '../../core/format';
import { MoneyPipe } from '../../shared/pipes';
import { GameIcon, LoadError, Spinner } from '../../shared/ui';

/**
 * Game detail + stake selection. One screen, one job: pick how much to play
 * for, then find an opponent. The prize is always shown before the player
 * confirms; the fee/pool breakdown is there for anyone curious but tucked
 * behind a small toggle rather than shown by default.
 */
@Component({
  selector: 'app-game-detail',
  imports: [RouterLink, MatIconModule, MatProgressSpinnerModule, MoneyPipe, GameIcon, LoadError, Spinner],
  template: `
    <div class="page">
      <a class="back muted small" routerLink="/games"><mat-icon>arrow_back</mat-icon>All games</a>
      @if (error()) {
        <app-load-error [message]="error()" (retry)="load()" />
      } @else if (!game()) {
        <app-spinner />
      } @else {
        @let g = game()!;
        <div class="layout fade-in">
          <section class="intro">
            <div class="head">
              <app-game-icon [slug]="g.slug" [color]="g.accentColor" [size]="60" />
              <div>
                <h1>{{ g.name }}</h1>
                <p class="text-2">{{ g.tagline }}</p>
              </div>
            </div>
            <div class="meta">
              <span class="chip"><mat-icon inline>schedule</mat-icon>{{ duration(g.estimatedDurationSeconds) }}</span>
              @if ((g.waiting ?? 0) > 0) { <span class="chip chip-win"><span class="live-dot"></span>{{ g.waiting }} playing now</span> }
              @if (!g.isEnabled) { <span class="chip chip-loss">Unavailable right now</span> }
            </div>
            <div class="card how">
              <h3><mat-icon>menu_book</mat-icon> How to play</h3>
              <p class="text-2">{{ g.howToPlay }}</p>
              <ul class="rules muted small">
                <li>Both players get exactly the same challenge, so it's fair for everyone.</li>
                <li>If it's an exact tie, you get your entry back.</li>
                <li>Changed your mind? Leave before the game starts and get your entry back.</li>
              </ul>
            </div>
          </section>

          <aside class="screen entry">
            <div class="screen-body">
              <h2>Choose your entry</h2>
              <div class="tiles stake-tiles">
                @for (s of g.stakes ?? []; track s.stake) {
                  <button class="tile" [class.selected]="stake()?.stake === s.stake" [disabled]="s.stake > available()" (click)="stake.set(s)">
                    {{ s.stake | money }}
                  </button>
                }
              </div>

              @if (stake(); as s) {
                <div class="prize-box">
                  <div class="pb-row"><span>You pay</span><strong class="money">{{ s.stake | money }}</strong></div>
                  <div class="pb-row win-row"><span>You could win</span><strong class="money accent">{{ s.prize | money }}</strong></div>
                  @if (waitingFor(s.stake) > 0) {
                    <p class="win small instant"><mat-icon inline>bolt</mat-icon> Someone's ready to play now. You'll be matched instantly.</p>
                  }
                  <button type="button" class="link tiny how-link" (click)="showBreakdown.set(!showBreakdown())">
                    {{ showBreakdown() ? 'Hide' : 'How is the prize worked out?' }}
                  </button>
                  @if (showBreakdown()) {
                    <p class="muted tiny breakdown-note">Both entries go into one prize pool. A small platform fee ({{ g.feePercent }}%) is taken out, and the winner gets the rest: {{ s.pool | money }} pool minus {{ s.fee | money }} fee equals {{ s.prize | money }}.</p>
                  }
                </div>
              }

              <div class="balance-row small">
                <span class="muted">Your balance</span>
                <strong class="money">{{ available() | money }}</strong>
              </div>
              @if (stake() && stake()!.stake > available()) {
                <div class="form-error"><mat-icon>account_balance_wallet</mat-icon>You don't have enough balance for this entry.</div>
              }
              @if (findError()) { <div class="form-error"><mat-icon>error</mat-icon>{{ findError() }}</div> }
            </div>

            <div class="screen-actions">
              @if (available() < (g.stakes?.[0]?.stake ?? 0)) {
                <a class="btn btn-primary btn-lg btn-block" routerLink="/wallet/deposit"><mat-icon>add</mat-icon>Add money to play</a>
              } @else {
                <button class="btn btn-primary btn-play btn-block" [disabled]="!stake() || searching() || !g.isEnabled || stake()!.stake > available()" (click)="find()">
                  @if (searching()) { <mat-spinner diameter="22" /> Finding an opponent… } @else { <mat-icon>search</mat-icon> Find an opponent }
                </button>
              }
              <a class="btn btn-ghost btn-block" [routerLink]="['/challenges/new']" [queryParams]="{ gameId: g.id, stake: stake()?.stake }"><mat-icon>swords</mat-icon>Challenge someone directly</a>
            </div>
          </aside>
        </div>
      }
    </div>
  `,
  styles: [`
    .back { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 16px; min-height: 32px; mat-icon { font-size: 18px; width: 18px; height: 18px; } &:hover { color: var(--text); } }
    .layout { display: grid; gap: 20px; grid-template-columns: 1fr; max-width: 880px; }
    @media (min-width: 960px) { .layout { grid-template-columns: 1fr 340px; align-items: start; } .entry { position: sticky; top: 84px; } }
    .head { display: flex; gap: 16px; align-items: center; h1 { font-size: 28px; } }
    @media (min-width: 640px) { .head h1 { font-size: 32px; } }
    .meta { display: flex; gap: 6px; flex-wrap: wrap; margin: 14px 0; }
    .how h3 { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; mat-icon { color: var(--muted); } }
    .how .text-2 { max-width: 56ch; }
    .rules { margin: 12px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; line-height: 1.4; max-width: 56ch; }
    .entry { padding: 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
    .entry h2 { font-size: 18px; margin-bottom: 4px; }
    .stake-tiles { margin-top: 10px; }
    .prize-box { background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px; display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
    .pb-row { display: flex; justify-content: space-between; align-items: baseline; font-size: 14px; color: var(--text-2); }
    .win-row { border-top: 1px dashed var(--border-strong); padding-top: 8px; strong { font-size: 22px; font-family: var(--font-display); } }
    .instant { display: flex; align-items: center; gap: 4px; }
    .how-link { align-self: flex-start; margin-top: 2px; }
    .breakdown-note { line-height: 1.5; }
    .balance-row { display: flex; justify-content: space-between; margin-top: 4px; }
    .live-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: blink 1.4s infinite; }
    @keyframes blink { 50% { opacity: .3; } }
  `],
})
export class GameDetailPage implements OnInit {
  readonly slug = input.required<string>();
  private api = inject(Api);
  private auth = inject(AuthService);
  private router = inject(Router);
  private toast = inject(Toast);
  private realtime = inject(RealtimeService);
  private destroyRef = inject(DestroyRef);

  protected game = signal<Game | null>(null);
  protected stake = signal<StakeOption | null>(null);
  protected error = signal('');
  protected findError = signal('');
  protected searching = signal(false);
  protected showBreakdown = signal(false);
  protected available = computed(() => this.auth.wallet()?.available ?? 0);
  protected duration = durationLabel;

  ngOnInit() {
    this.load();
    this.realtime.queue$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      this.game.update((g) => (g ? { ...g, waiting: q[g.id]?.total ?? 0, waitingByStake: q[g.id]?.byStake ?? {} } : g));
    });
    this.realtime.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load());
  }

  waitingFor(stake: number) {
    return this.game()?.waitingByStake?.[String(stake)] ?? 0;
  }

  async load() {
    this.error.set('');
    try {
      const { game } = await this.api.get<{ game: Game }>(`/games/${this.slug()}`);
      this.game.set(game);
      const prefer = game.stakes?.find((s) => s.stake === 20 && s.stake <= this.available())
        ?? [...(game.stakes ?? [])].reverse().find((s) => s.stake <= this.available())
        ?? game.stakes?.[0] ?? null;
      this.stake.set(prefer);
      this.auth.refreshMe().catch(() => {});
    } catch (err) {
      this.error.set(apiError(err).message);
    }
  }

  async find() {
    const g = this.game();
    const s = this.stake();
    if (!g || !s) return;
    this.searching.set(true);
    this.findError.set('');
    try {
      const r = await this.api.post<{ matched: boolean; alreadyQueued: boolean; match: MatchView }>('/matches/find', { gameId: g.id, stake: s.stake });
      if (r.matched) this.toast.success('Opponent found!');
      else if (r.alreadyQueued) this.toast.info("You're already waiting for an opponent at this entry.");
      await this.router.navigate(['/match', r.match.code]);
    } catch (err) {
      this.findError.set(apiError(err).message);
    } finally {
      this.searching.set(false);
    }
  }
}
