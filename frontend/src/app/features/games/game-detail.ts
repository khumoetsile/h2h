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
import { DemoBadge, GameIcon, LoadError, Spinner } from '../../shared/ui';

@Component({
  selector: 'app-game-detail',
  imports: [RouterLink, MatIconModule, MatProgressSpinnerModule, MoneyPipe, DemoBadge, GameIcon, LoadError, Spinner],
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
          <section>
            <div class="head">
              <app-game-icon [slug]="g.slug" [color]="g.accentColor" [size]="60" />
              <div>
                <h1>{{ g.name }}</h1>
                <p class="text-2">{{ g.tagline }}</p>
              </div>
            </div>
            <div class="meta">
              <span class="chip">1v1</span>
              <span class="chip">{{ duration(g.estimatedDurationSeconds) }}</span>
              <span class="chip" [class.chip-win]="(g.waiting ?? 0) > 0">{{ g.waiting ?? 0 }} players waiting</span>
              @if (!g.isEnabled) { <span class="chip chip-loss">Unavailable</span> }
            </div>
            <p class="desc">{{ g.description }}</p>
            <div class="card how">
              <h3><mat-icon>menu_book</mat-icon> How to play</h3>
              <p class="text-2">{{ g.howToPlay }}</p>
              <ul class="rules muted small">
                <li>Both players receive exactly the same sequence.</li>
                <li>Your moves are scored on the server — the highest valid score wins.</li>
                <li>Exact ties are refunded in full.</li>
                <li>Leaving before the game starts refunds both stakes.</li>
              </ul>
            </div>
          </section>

          <aside class="card entry">
            <div class="row-between">
              <h2>Choose your stake</h2>
              <app-demo-badge />
            </div>
            <div class="tiles stake-tiles">
              @for (s of g.stakes ?? []; track s.stake) {
                <button class="tile" [class.selected]="stake()?.stake === s.stake" [disabled]="s.stake > available()" (click)="stake.set(s)">
                  {{ s.stake | money }}
                  <small>win {{ s.prize | money }}</small>
                </button>
              }
            </div>
            @if (stake(); as s) {
              <div class="breakdown">
                <div class="row-between"><span class="muted">Entry</span><strong class="money">{{ s.stake | money:'demo' }}</strong></div>
                <div class="row-between"><span class="muted">Total pool</span><span class="money">{{ s.pool | money }}</span></div>
                <div class="row-between"><span class="muted">Platform fee ({{ g.feePercent }}%)</span><span class="money">−{{ s.fee | money }}</span></div>
                <div class="row-between prize"><span>Potential prize</span><strong class="money">{{ s.prize | money:'demo' }}</strong></div>
                @if (waitingFor(s.stake) > 0) {
                  <p class="win small"><mat-icon inline>bolt</mat-icon> {{ waitingFor(s.stake) }} player{{ waitingFor(s.stake) > 1 ? 's' : '' }} waiting at this stake — instant match.</p>
                }
              </div>
            }
            <div class="balance small">
              <span class="muted">Available demo balance</span>
              <strong class="money">{{ available() | money:'demo' }}</strong>
            </div>
            @if (stake() && stake()!.stake > available()) {
              <div class="form-error">Insufficient demo balance. <a class="link" routerLink="/wallet/deposit">Add demo funds</a></div>
            }
            @if (findError()) { <div class="form-error"><mat-icon>error</mat-icon>{{ findError() }}</div> }
            <button class="btn btn-primary btn-play btn-block" [disabled]="!stake() || searching() || !g.isEnabled || stake()!.stake > available()" (click)="find()">
              @if (searching()) { <mat-spinner diameter="22" /> } @else { <mat-icon>radar</mat-icon> Find opponent }
            </button>
            <p class="muted tiny center">Your stake moves from available to <strong>locked</strong> while you wait. Cancel any time before an opponent joins for a full refund.</p>
            @if (available() < (g.stakes?.[0]?.stake ?? 0)) {
              <a class="btn btn-block" routerLink="/wallet/deposit"><mat-icon>add</mat-icon>Add demo funds</a>
            }
            <a class="btn btn-ghost btn-block" routerLink="/challenges" [queryParams]="{ game: g.id, stake: stake()?.stake }"><mat-icon>swords</mat-icon>Challenge a specific player</a>
          </aside>
        </div>
      }
    </div>
  `,
  styles: [`
    .back { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 16px; mat-icon { font-size: 18px; width: 18px; height: 18px; } &:hover { color: var(--text); } }
    .layout { display: grid; gap: 24px; grid-template-columns: 1fr; }
    @media (min-width: 960px) { .layout { grid-template-columns: 1fr 400px; align-items: start; } .entry { position: sticky; top: 84px; } }
    .head { display: flex; gap: 16px; align-items: center; h1 { font-size: 32px; } }
    .meta { display: flex; gap: 6px; flex-wrap: wrap; margin: 16px 0; }
    .desc { font-size: 16px; color: var(--text-2); margin-bottom: 20px; max-width: 640px; }
    .how h3 { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; mat-icon { color: var(--muted); } }
    .rules { margin: 12px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
    .entry { display: flex; flex-direction: column; gap: 14px; }
    .stake-tiles { grid-template-columns: repeat(3, 1fr); }
    .breakdown { background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; font-size: 14px;
      .prize { border-top: 1px dashed var(--border-strong); padding-top: 8px; margin-top: 2px; strong { color: var(--accent); font-size: 18px; font-family: var(--font-display); } }
      p { display: flex; align-items: center; gap: 4px; margin-top: 4px; } }
    .balance { display: flex; justify-content: space-between; }
    .center { text-align: center; }
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
  protected available = computed(() => this.auth.wallet()?.available ?? 0);
  protected duration = durationLabel;

  ngOnInit() {
    this.load();
    this.realtime.queue$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      this.game.update((g) => (g ? { ...g, waiting: q[g.id]?.total ?? 0, waitingByStake: q[g.id]?.byStake ?? {} } : g));
    });
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
      else if (r.alreadyQueued) this.toast.info('You are already in the queue for this game and stake.');
      await this.router.navigate(['/match', r.match.code]);
    } catch (err) {
      this.findError.set(apiError(err).message);
    } finally {
      this.searching.set(false);
    }
  }
}
