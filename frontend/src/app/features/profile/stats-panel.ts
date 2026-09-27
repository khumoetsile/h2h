import { Component, input } from '@angular/core';
import { UserStats } from '../../core/models';
import { MoneyPipe } from '../../shared/pipes';
import { GameIcon } from '../../shared/ui';

/** Shared stats block used on the own profile and public player profiles. */
@Component({
  selector: 'app-stats-panel',
  imports: [MoneyPipe, GameIcon],
  template: `
    @let s = stats();
    <div class="kpis">
      <div class="card kpi"><div class="label">Games played</div><div class="value">{{ s.played }}</div></div>
      <div class="card kpi"><div class="label">Wins</div><div class="value win">{{ s.wins }}</div></div>
      <div class="card kpi"><div class="label">Losses</div><div class="value">{{ s.losses }}</div></div>
      <div class="card kpi"><div class="label">Win rate</div><div class="value">{{ s.winRate }}%</div></div>
      <div class="card kpi"><div class="label">Current streak</div><div class="value" [class.win]="s.streak.type === 'W'" [class.loss]="s.streak.type === 'L'">{{ s.streak.label }}</div></div>
      <div class="card kpi"><div class="label">Demo winnings</div><div class="value money">{{ s.totalWinnings | money }}</div><div class="hint">Net {{ s.netResult | money:'sign' }}</div></div>
    </div>
    <div class="card card-flush">
      <div class="card-head"><h3>Game statistics</h3>
        @if (s.reactionRush.bestReactionMs) { <span class="muted small">Best reaction <strong class="accent">{{ s.reactionRush.bestReactionMs }} ms</strong> · avg {{ s.reactionRush.averageReactionMs }} ms</span> }
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Game</th><th class="right">Played</th><th class="right">W</th><th class="right">L</th><th class="right">Win %</th><th class="right">Best score</th><th class="right">Winnings</th></tr></thead>
          <tbody>
            @for (g of s.perGame; track g.gameId) {
              <tr>
                <td><div class="row"><app-game-icon [slug]="g.slug" [color]="g.accentColor" [size]="26" />{{ g.name }}</div></td>
                <td class="right num">{{ g.played }}</td>
                <td class="right num win">{{ g.wins }}</td>
                <td class="right num">{{ g.losses }}</td>
                <td class="right num">{{ g.wins + g.losses ? ((g.wins / (g.wins + g.losses)) * 100).toFixed(0) + '%' : '-' }}</td>
                <td class="right num">{{ g.bestScore ?? '-' }}</td>
                <td class="right money">{{ g.winnings | money }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  styles: [`
    .kpis { display: grid; gap: 12px; grid-template-columns: repeat(2, 1fr); margin-bottom: 16px; }
    @media (min-width: 700px) { .kpis { grid-template-columns: repeat(3, 1fr); } }
    @media (min-width: 1000px) { .kpis { grid-template-columns: repeat(6, 1fr); } }
    .kpis .card { padding: 14px; }
  `],
})
export class StatsPanel {
  readonly stats = input.required<UserStats>();
}
