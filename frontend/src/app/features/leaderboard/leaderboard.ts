import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { Game, LeaderboardEntry } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar, DemoBadge, EmptyState, LoadError, SkeletonList } from '../../shared/ui';

type Period = 'daily' | 'weekly' | 'all';

@Component({
  selector: 'app-leaderboard',
  imports: [RouterLink, MatIconModule, MoneyPipe, Avatar, DemoBadge, EmptyState, LoadError, SkeletonList],
  template: `
    <div class="page">
      <div class="page-head">
        <div><h1>Leaderboard</h1><p class="sub">Ranked by wins, then win rate, then demo winnings. Live from match results.</p></div>
        <app-demo-badge label="Demo winnings" size="lg" />
      </div>
      <div class="controls">
        <div class="segmented">
          @for (p of periods; track p.key) { <button [class.active]="period() === p.key" (click)="setPeriod(p.key)">{{ p.label }}</button> }
        </div>
        <select class="game-select" [value]="gameId() ?? ''" (change)="setGame($any($event.target).value)" aria-label="Filter by game">
          <option value="">All games</option>
          @for (g of games(); track g.id) { <option [value]="g.id">{{ g.name }}</option> }
        </select>
      </div>

      @if (me(); as m) {
        <div class="card me-card">
          <span class="rank-num">#{{ m.rank }}</span>
          <app-avatar [name]="m.username" [color]="m.avatarColor" [size]="36" />
          <div class="grow"><strong>Your position</strong><div class="muted small">{{ m.wins }}W · {{ m.losses }}L · {{ m.winRate }}%</div></div>
          <strong class="money">{{ m.totalWinnings | money }}</strong>
        </div>
      }

      <div class="card card-flush">
        @if (error()) {
          <app-load-error [message]="error()" (retry)="load()" />
        } @else if (!entries()) {
          <app-skeleton-list [rows]="8" />
        } @else if (entries()!.length === 0) {
          <app-empty icon="leaderboard" title="No ranked players yet" [text]="period() === 'daily' ? 'No matches completed today. Be the first!' : 'No completed matches in this period.'">
            @if (!auth.isAdmin()) { <a class="btn btn-sm btn-primary" routerLink="/games">Play now</a> }
          </app-empty>
        } @else {
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Rank</th><th>Player</th><th class="right">Wins</th><th class="right">Losses</th><th class="right">Win rate</th><th class="right">Winnings</th><th class="right">Streak</th></tr></thead>
              <tbody>
                @for (e of entries(); track e.userId) {
                  <tr [class.mine]="e.userId === auth.user()?.id">
                    <td><span class="rank" [class.r1]="e.rank === 1" [class.r2]="e.rank === 2" [class.r3]="e.rank === 3">{{ e.rank }}</span></td>
                    <td><a class="row" [routerLink]="['/players', e.username]"><app-avatar [name]="e.username" [color]="e.avatarColor" [size]="28" /><span class="uname">{{ e.username }}</span>@if (e.isBot) { <span class="chip">bot</span> }</a></td>
                    <td class="right num win">{{ e.wins }}</td>
                    <td class="right num">{{ e.losses }}</td>
                    <td class="right num">{{ e.winRate }}%</td>
                    <td class="right money">{{ e.totalWinnings | money }}</td>
                    <td class="right"><span class="chip" [class.chip-win]="e.streak.type === 'W'" [class.chip-loss]="e.streak.type === 'L'">{{ e.streak.label }}</span></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
    .game-select { height: 38px; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0 10px; font: inherit; font-size: 13px; }
    .me-card { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; border-color: rgba(200,255,61,.3); .grow { flex: 1; } }
    .rank-num { font-family: var(--font-display); font-size: 22px; font-weight: 700; color: var(--accent); min-width: 44px; }
    .rank { display: inline-flex; width: 28px; height: 28px; align-items: center; justify-content: center; border-radius: 6px; font-weight: 700; font-family: var(--font-display); background: var(--surface-2); }
    .r1 { background: rgba(250, 204, 21, .18); color: #facc15; } .r2 { background: rgba(203, 213, 225, .14); color: #cbd5e1; } .r3 { background: rgba(217, 119, 6, .18); color: #f59e0b; }
    tr.mine td { background: rgba(200,255,61,.05); }
    .uname { font-weight: 600; } a.row:hover .uname { text-decoration: underline; }
  `],
})
export class LeaderboardPage implements OnInit {
  private api = inject(Api);
  protected auth = inject(AuthService);
  private realtime = inject(RealtimeService);
  private destroyRef = inject(DestroyRef);
  protected periods: { key: Period; label: string }[] = [{ key: 'daily', label: 'Daily' }, { key: 'weekly', label: 'Weekly' }, { key: 'all', label: 'All time' }];
  protected period = signal<Period>('all');
  protected gameId = signal<number | null>(null);
  protected games = signal<Game[]>([]);
  protected entries = signal<LeaderboardEntry[] | null>(null);
  protected me = signal<LeaderboardEntry | null>(null);
  protected error = signal('');

  ngOnInit() {
    this.load();
    this.api.get<{ games: Game[] }>('/games').then((r) => this.games.set(r.games)).catch(() => {});
    this.realtime.leaderboard$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load(true));
  }

  setPeriod(p: Period) { this.period.set(p); this.entries.set(null); this.load(); }
  setGame(v: string) { this.gameId.set(v ? Number(v) : null); this.entries.set(null); this.load(); }

  async load(silent = false) {
    if (!silent) this.error.set('');
    try {
      const r = await this.api.get<{ entries: LeaderboardEntry[]; me: LeaderboardEntry | null }>('/leaderboard', { period: this.period(), gameId: this.gameId() });
      this.entries.set(r.entries);
      this.me.set(r.me);
    } catch {
      if (!silent) this.error.set('Could not load the leaderboard.');
    }
  }
}
