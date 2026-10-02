import { Component, computed, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { ConfigStore } from '../../core/config.store';
import { Game, MatchView, StakeOption } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { Toast } from '../../core/toast.service';
import { durationLabel } from '../../core/format';
import { MoneyPipe } from '../../shared/pipes';
import { GameIcon, LoadError, Spinner } from '../../shared/ui';

const STAKE_KEY = 'h2h.stake';
/** Most players start here, so two people who both just tap Play end up in the same queue. */
const DEFAULT_STAKE = 10;

/**
 * Game page. One job: get the player into a match with as few taps as
 * possible. The big button is "Play" (find a real opponent); right under it,
 * "Practice" starts straight away against a bot with no waiting. The stake
 * that already has someone waiting is pre-selected so people actually meet.
 */
@Component({
  selector: 'app-game-detail',
  imports: [RouterLink, MatIconModule, MatProgressSpinnerModule, MoneyPipe, GameIcon, LoadError, Spinner],
  template: `
    <div class="page page-narrow">
      <a class="back muted small" routerLink="/games"><mat-icon>arrow_back</mat-icon>All games</a>
      @if (error()) {
        <app-load-error [message]="error()" (retry)="load()" />
      } @else if (!game()) {
        <app-spinner />
      } @else {
        @let g = game()!;
        <div class="head">
          <app-game-icon [slug]="g.slug" [color]="g.accentColor" [size]="56" />
          <div>
            <h1>{{ g.name }}</h1>
            <p class="text-2">{{ g.tagline }}</p>
          </div>
        </div>
        <div class="meta">
          <span class="chip">{{ duration(g.estimatedDurationSeconds) }}</span>
          @if ((g.waiting ?? 0) > 0) { <span class="chip chip-win"><span class="live-dot"></span>{{ g.waiting }} waiting to play</span> }
          @if (!g.isEnabled) { <span class="chip chip-loss">Unavailable right now</span> }
        </div>

        <section class="entry card">
          <h2>Pick your stake</h2>
          <div class="tiles stake-tiles">
            @for (s of g.stakes ?? []; track s.stake) {
              <button class="tile" [class.selected]="stake()?.stake === s.stake" [disabled]="s.stake > available()" (click)="choose(s)">
                {{ s.stake | money }}
                @if (waitingFor(s.stake) > 0) { <small>{{ waitingFor(s.stake) }} waiting</small> }
              </button>
            }
          </div>

          @if (stake(); as s) {
            <p class="prize">Win <strong class="money accent">{{ s.prize | money }}</strong><span class="muted"> for a {{ s.stake | money }} entry</span></p>
            @if (waitingFor(s.stake) > 0) { <p class="win small instant"><mat-icon inline>bolt</mat-icon> Someone is ready to play now. You will be matched straight away.</p> }
          }

          @if (stake() && stake()!.stake > available()) {
            <div class="form-error"><mat-icon>account_balance_wallet</mat-icon>You don't have enough balance for this entry.</div>
          }
          @if (findError()) { <div class="form-error"><mat-icon>error</mat-icon>{{ findError() }}</div> }

          <div class="actions">
            @if (available() < (g.stakes?.[0]?.stake ?? 0)) {
              <a class="btn btn-primary btn-play btn-block" routerLink="/wallet/deposit"><mat-icon>add</mat-icon>Add money to play</a>
            } @else {
              <button class="btn btn-primary btn-play btn-block" [disabled]="!stake() || busy() || !g.isEnabled || stake()!.stake > available()" (click)="find()">
                @if (busy() === 'find') { <mat-spinner diameter="22" /> Finding an opponent } @else { Play {{ stake() ? '· ' + (stake()!.stake | money) : '' }} }
              </button>
              @if (config.config()?.demoBotsEnabled) {
                <button class="btn btn-block" [disabled]="!stake() || busy() || !g.isEnabled || stake()!.stake > available()" (click)="practice()">
                  @if (busy() === 'practice') { <mat-spinner diameter="20" /> Setting up } @else { <mat-icon>smart_toy</mat-icon> Practice now, no waiting }
                </button>
              }
            }
            <a class="link small center" [routerLink]="['/challenges/new']" [queryParams]="{ gameId: g.id, stake: stake()?.stake }">Challenge a friend instead</a>
          </div>
          <p class="muted tiny note">Your entry is held while you play and returned if nobody joins. Leaving a match after both players are ready costs {{ config.abandonmentFee() }}.</p>
        </section>

        <details class="how card">
          <summary>How to play</summary>
          <p class="text-2">{{ g.howToPlay }}</p>
          <ul class="rules muted small">
            <li>Both players get exactly the same challenge, so it is fair for everyone.</li>
            <li>If it is an exact tie, you get your entry back.</li>
          </ul>
        </details>
      }
    </div>
  `,
  styles: [`
    .back { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 14px; min-height: 36px; mat-icon { font-size: 18px; width: 18px; height: 18px; } &:hover { color: var(--text); } }
    .head { display: flex; gap: 14px; align-items: center; h1 { font-size: 34px; } }
    .meta { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0 16px; }
    .entry { padding: 18px; display: flex; flex-direction: column; gap: 12px; }
    .entry h2 { font-size: 22px; }
    .stake-tiles { grid-template-columns: repeat(3, 1fr); }
    .prize { font-size: 18px; }
    .prize strong { font-size: 26px; font-family: var(--font-display); }
    .instant { display: flex; align-items: center; gap: 4px; margin: -4px 0 0; }
    .actions { display: flex; flex-direction: column; gap: 10px; margin-top: 4px; }
    .center { text-align: center; padding: 6px; }
    .note { line-height: 1.45; }
    .how { margin-top: 14px; padding: 0; }
    .how summary { cursor: pointer; padding: 16px 18px; font-family: var(--font-display); font-size: 20px; font-weight: 600; list-style: none; }
    .how summary::-webkit-details-marker { display: none; }
    .how[open] summary { border-bottom: 1px solid var(--border); }
    .how p, .how ul { margin: 0; padding: 14px 18px 0; }
    .rules { padding-left: 36px; display: flex; flex-direction: column; gap: 6px; line-height: 1.4; padding-bottom: 16px; }
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
  protected config = inject(ConfigStore);

  protected game = signal<Game | null>(null);
  protected stake = signal<StakeOption | null>(null);
  protected error = signal('');
  protected findError = signal('');
  protected busy = signal<'find' | 'practice' | null>(null);
  protected available = computed(() => this.auth.wallet()?.available ?? 0);
  protected duration = durationLabel;
  /** The player has picked a stake themselves, so live queue updates must not move it. */
  private userChose = false;

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

  protected choose(s: StakeOption) {
    this.userChose = true;
    this.stake.set(s);
    try { localStorage.setItem(STAKE_KEY, String(s.stake)); } catch { /* storage unavailable */ }
  }

  /** Where someone is already waiting, then the last stake used, then the common default, then the cheapest. */
  private defaultStake(game: Game) {
    const stakes = game.stakes ?? [];
    const ok = (s: StakeOption) => s.stake <= this.available();
    const waiting = stakes.find((s) => ok(s) && this.waitingFor(s.stake) > 0);
    let last: number | null = null;
    try { last = Number(localStorage.getItem(STAKE_KEY)) || null; } catch { /* storage unavailable */ }
    return waiting
      ?? stakes.find((s) => ok(s) && s.stake === last)
      ?? stakes.find((s) => ok(s) && s.stake === DEFAULT_STAKE)
      ?? stakes.find(ok)
      ?? stakes[0] ?? null;
  }

  async load() {
    this.error.set('');
    try {
      const { game } = await this.api.get<{ game: Game }>(`/games/${this.slug()}`);
      this.game.set(game);
      if (!this.userChose) this.stake.set(this.defaultStake(game));
      this.auth.refreshMe().catch(() => {});
    } catch (err) {
      this.error.set(apiError(err).message);
    }
  }

  async find() {
    const g = this.game();
    const s = this.stake();
    if (!g || !s) return;
    this.busy.set('find');
    this.findError.set('');
    try {
      const r = await this.api.post<{ matched: boolean; alreadyQueued: boolean; match: MatchView }>('/matches/find', { gameId: g.id, stake: s.stake });
      if (r.matched) this.toast.success('Opponent found!');
      else if (r.alreadyQueued) this.toast.info("You're already waiting for an opponent at this entry.");
      await this.router.navigate(['/match', r.match.code]);
    } catch (err) {
      this.findError.set(apiError(err).message);
    } finally {
      this.busy.set(null);
    }
  }

  /** A match against a bot, locked in and ready: straight onto the pitch. */
  async practice() {
    const g = this.game();
    const s = this.stake();
    if (!g || !s) return;
    this.busy.set('practice');
    this.findError.set('');
    try {
      const r = await this.api.post<{ match: MatchView }>('/matches/practice', { gameId: g.id, stake: s.stake });
      await this.router.navigate(['/match', r.match.code, 'play']);
    } catch (err) {
      this.findError.set(apiError(err).message);
    } finally {
      this.busy.set(null);
    }
  }
}
