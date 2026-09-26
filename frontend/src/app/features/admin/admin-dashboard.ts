import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from '../../core/api.service';
import { MoneyPipe } from '../../shared/pipes';
import { DemoBadge, LoadError, Spinner } from '../../shared/ui';

interface Stats {
  users: { total: number; enabled: number; disabled: number; active24h: number; active7d: number; new7d: number };
  matches: { total: number; completed: number; cancelled: number; active: number; waiting: number };
  finance: {
    demoDeposits: { count: number; total: number }; demoWithdrawals: { count: number; total: number };
    demoGamingVolume: number; demoPlatformFees: number; demoPrizesPaid: number; demoRefunds: { count: number; total: number };
    walletsAvailable: number; walletsLocked: number;
  };
  challenges: { active: number; total: number; accepted: number };
  daily: { day: string; matches: number; volume: number; fees: number }[];
  byGame: { name: string; accentColor: string; matches: number; volume: number }[];
}

@Component({
  selector: 'app-admin-dashboard',
  imports: [RouterLink, MatIconModule, MatTooltipModule, MoneyPipe, DemoBadge, LoadError, Spinner],
  template: `
    <div class="page">
      <div class="page-head">
        <div><h1>Platform overview</h1><p class="sub">Live figures from the database.</p></div>
        <button class="btn btn-sm" (click)="load()"><mat-icon>refresh</mat-icon>Refresh</button>
      </div>
      <div class="demo-strip" style="margin-bottom:16px">All financial figures are DEMO — simulated funds, no real money</div>
      @if (error()) { <app-load-error [message]="error()" (retry)="load()" /> }
      @else if (!s()) { <app-spinner /> }
      @else {
        @let d = s()!;
        <h3 class="grp">Users & activity</h3>
        <div class="grid-4">
          <a class="card kpi card-interactive" routerLink="/admin/users"><div class="label">Total users</div><div class="value">{{ d.users.total }}</div><div class="hint">{{ d.users.new7d }} new this week · {{ d.users.disabled }} disabled</div></a>
          <div class="card kpi"><div class="label">Active users (24h)</div><div class="value">{{ d.users.active24h }}</div><div class="hint">{{ d.users.active7d }} in the last 7 days</div></div>
          <a class="card kpi card-interactive" routerLink="/admin/challenges"><div class="label">Active challenges</div><div class="value">{{ d.challenges.active }}</div><div class="hint">{{ d.challenges.accepted }} accepted of {{ d.challenges.total }}</div></a>
          <a class="card kpi card-interactive" routerLink="/admin/matches"><div class="label">Live matches</div><div class="value">{{ d.matches.active }}</div><div class="hint">{{ d.matches.waiting }} waiting for opponent</div></a>
        </div>
        <h3 class="grp">Matches</h3>
        <div class="grid-4">
          <div class="card kpi"><div class="label">Total matches</div><div class="value">{{ d.matches.total }}</div></div>
          <div class="card kpi"><div class="label">Completed</div><div class="value win">{{ d.matches.completed }}</div></div>
          <div class="card kpi"><div class="label">Cancelled</div><div class="value">{{ d.matches.cancelled }}</div></div>
          <div class="card kpi"><div class="label">Completion rate</div><div class="value">{{ d.matches.total ? ((d.matches.completed / d.matches.total) * 100).toFixed(0) : 0 }}%</div></div>
        </div>
        <h3 class="grp">Finance <app-demo-badge label="Demo" /></h3>
        <div class="grid-4">
          <div class="card kpi"><div class="label">Demo deposits</div><div class="value money">{{ d.finance.demoDeposits.total | money }}</div><div class="hint">{{ d.finance.demoDeposits.count }} transactions</div></div>
          <div class="card kpi"><div class="label">Demo withdrawals</div><div class="value money">{{ d.finance.demoWithdrawals.total | money }}</div><div class="hint">{{ d.finance.demoWithdrawals.count }} transactions</div></div>
          <div class="card kpi"><div class="label">Demo gaming volume</div><div class="value money">{{ d.finance.demoGamingVolume | money }}</div><div class="hint">Pools of completed matches</div></div>
          <div class="card kpi fees"><div class="label">Demo platform fees</div><div class="value money accent">{{ d.finance.demoPlatformFees | money }}</div><div class="hint">Prizes paid {{ d.finance.demoPrizesPaid | money }}</div></div>
          <div class="card kpi"><div class="label">Demo refunds</div><div class="value money">{{ d.finance.demoRefunds.total | money }}</div><div class="hint">{{ d.finance.demoRefunds.count }} refunds</div></div>
          <div class="card kpi"><div class="label">Player balances</div><div class="value money">{{ d.finance.walletsAvailable | money }}</div><div class="hint">Available (demo)</div></div>
          <div class="card kpi"><div class="label">Locked in matches</div><div class="value money">{{ d.finance.walletsLocked | money }}</div><div class="hint">Demo stakes held</div></div>
          <a class="card kpi card-interactive" routerLink="/admin/settings"><div class="label">Settings</div><div class="value"><mat-icon>tune</mat-icon></div><div class="hint">Fee, stakes, timeouts</div></a>
        </div>

        <div class="charts">
          <div class="card">
            <div class="row-between"><h3>Completed matches per day</h3><span class="muted tiny">Last 14 days</span></div>
            <div class="bars">
              @for (p of d.daily; track p.day) {
                <div class="bar-col" [matTooltip]="dayLabel(p.day) + ': ' + p.matches + ' matches'">
                  <div class="bar" [style.height.%]="(p.matches / maxMatches()) * 100"></div>
                </div>
              }
            </div>
            <div class="axis muted tiny"><span>{{ dayLabel(d.daily[0].day) }}</span><span>Today</span></div>
          </div>
          <div class="card">
            <div class="row-between"><h3>Demo platform fees per day</h3><span class="muted tiny">Last 14 days</span></div>
            <div class="bars">
              @for (p of d.daily; track p.day) {
                <div class="bar-col" [matTooltip]="dayLabel(p.day) + ': P' + p.fees.toFixed(2) + ' DEMO fees · P' + p.volume.toFixed(2) + ' volume'">
                  <div class="bar" [style.height.%]="(p.fees / maxFees()) * 100"></div>
                </div>
              }
            </div>
            <div class="axis muted tiny"><span>{{ dayLabel(d.daily[0].day) }}</span><span>Today</span></div>
          </div>
        </div>

        <div class="card card-flush" style="margin-top:16px">
          <div class="card-head"><h3>Volume by game</h3><a class="link small" routerLink="/admin/games">Manage games</a></div>
          <table class="table">
            <thead><tr><th>Game</th><th class="right">Completed matches</th><th class="right">Demo volume</th></tr></thead>
            <tbody>
              @for (g of d.byGame; track g.name) {
                <tr><td><span class="dot" [style.background]="g.accentColor"></span>{{ g.name }}</td><td class="right num">{{ g.matches }}</td><td class="right money">{{ g.volume | money }}</td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
  styles: [`
    .grp { margin: 20px 0 10px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; display: flex; align-items: center; gap: 8px; }
    .grp:first-of-type { margin-top: 0; }
    .kpi .value { font-size: 24px; }
    .fees { border-color: rgba(200,255,61,.25); }
    .charts { display: grid; gap: 16px; grid-template-columns: 1fr; margin-top: 20px; }
    @media (min-width: 900px) { .charts { grid-template-columns: 1fr 1fr; } }
    .bars { display: flex; align-items: flex-end; gap: 2px; height: 140px; margin-top: 16px; border-bottom: 1px solid var(--border); }
    .bar-col { flex: 1; height: 100%; display: flex; align-items: flex-end; cursor: default; }
    .bar-col:hover .bar { background: #d6ff6b; }
    .bar { width: 100%; min-height: 2px; background: var(--accent); border-radius: 4px 4px 0 0; transition: height .3s ease; }
    .axis { display: flex; justify-content: space-between; margin-top: 6px; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; }
  `],
})
export class AdminDashboardPage implements OnInit {
  private api = inject(Api);
  protected s = signal<Stats | null>(null);
  protected error = signal('');
  protected maxMatches = computed(() => Math.max(1, ...(this.s()?.daily.map((d) => d.matches) ?? [1])));
  protected maxFees = computed(() => Math.max(1, ...(this.s()?.daily.map((d) => d.fees) ?? [1])));

  ngOnInit() { this.load(); }
  dayLabel(d: string) { return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }

  async load() {
    this.error.set('');
    try { this.s.set(await this.api.get<Stats>('/admin/stats')); } catch { this.error.set('Could not load platform statistics.'); }
  }
}
