import { Component, inject, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { MatchSummary, Paged } from '../../core/models';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar, DemoBadge, EmptyState, GameIcon, LoadError, OutcomeChip, SkeletonList } from '../../shared/ui';

type Filter = 'all' | 'wins' | 'losses' | 'cancelled';

@Component({
  selector: 'app-match-history',
  imports: [RouterLink, DatePipe, MatIconModule, MoneyPipe, Avatar, DemoBadge, EmptyState, GameIcon, LoadError, OutcomeChip, SkeletonList],
  template: `
    <div class="page">
      <div class="page-head">
        <div><h1>Match history</h1><p class="sub">Every match you've played, with results and prizes.</p></div>
        <app-demo-badge label="Demo stakes" size="lg" />
      </div>
      <div class="segmented" style="margin-bottom:16px">
        @for (f of filters; track f.key) {
          <button [class.active]="filter() === f.key" (click)="setFilter(f.key)">{{ f.label }}</button>
        }
      </div>

      <div class="card card-flush">
        @if (error()) {
          <app-load-error [message]="error()" (retry)="load()" />
        } @else if (!data()) {
          <app-skeleton-list [rows]="6" />
        } @else if (data()!.items.length === 0) {
          <app-empty icon="sports_esports" [title]="filter() === 'all' ? 'No matches yet' : 'No ' + filter() + ' yet'" text="Play a game to start building your record.">
            <a class="btn btn-primary btn-sm" routerLink="/games">Find a match</a>
          </app-empty>
        } @else {
          <div class="table-wrap hide-mobile">
            <table class="table">
              <thead><tr><th>Game</th><th>Opponent</th><th>Stake</th><th>Score</th><th>Result</th><th class="right">Prize</th><th>Date</th><th>Match ID</th></tr></thead>
              <tbody>
                @for (m of data()!.items; track m.id) {
                  <tr class="clickable" (click)="open(m)">
                    <td><div class="row"><app-game-icon [slug]="m.game.slug" [color]="m.game.accentColor" [size]="28" />{{ m.game.name }}</div></td>
                    <td>@if (m.opponent) { <div class="row"><app-avatar [name]="m.opponent.username" [color]="m.opponent.avatarColor" [size]="24" />&#64;{{ m.opponent.username }}</div> } @else { <span class="muted">—</span> }</td>
                    <td class="money">{{ m.stake | money }}</td>
                    <td class="num">{{ m.myScore ?? '—' }} <span class="muted">–</span> {{ m.opponentScore ?? '—' }}</td>
                    <td><app-outcome [outcome]="m.outcome" [status]="m.status" /></td>
                    <td class="right money" [class.win]="m.outcome === 'WIN'">{{ m.outcome === 'WIN' ? (m.prize | money) : '—' }}</td>
                    <td class="muted">{{ (m.completedAt || m.cancelledAt || m.createdAt) | date: 'd MMM, HH:mm' }}</td>
                    <td class="muted small">{{ m.code }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="list hide-desktop">
            @for (m of data()!.items; track m.id) {
              <a class="list-item" (click)="open(m)">
                <app-game-icon [slug]="m.game.slug" [color]="m.game.accentColor" [size]="36" />
                <div class="grow">
                  <div class="t">{{ m.game.name }} <span class="muted small">vs &#64;{{ m.opponent?.username ?? '—' }}</span></div>
                  <div class="muted tiny">{{ (m.completedAt || m.cancelledAt || m.createdAt) | date: 'd MMM, HH:mm' }} · {{ m.code }}</div>
                </div>
                <div class="end">
                  <app-outcome [outcome]="m.outcome" [status]="m.status" />
                  <span class="small money" [class.win]="m.outcome === 'WIN'">{{ m.outcome === 'WIN' ? '+' + (m.prize | money) : (m.stake | money) }}</span>
                </div>
              </a>
            }
          </div>
          @if (data()!.items.length < data()!.total) {
            <div class="more"><button class="btn btn-sm" [disabled]="loadingMore()" (click)="more()">Load more</button></div>
          }
        }
      </div>
    </div>
  `,
  styles: [`
    .grow { flex: 1; min-width: 0; } .t { font-weight: 600; font-size: 14px; }
    .end { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
    .more { display: flex; justify-content: center; padding: 14px; border-top: 1px solid var(--border); }
  `],
})
export class MatchHistoryPage implements OnInit {
  private api = inject(Api);
  private router = inject(Router);
  protected filters: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'wins', label: 'Wins' }, { key: 'losses', label: 'Losses' }, { key: 'cancelled', label: 'Cancelled' },
  ];
  protected filter = signal<Filter>('all');
  protected data = signal<Paged<MatchSummary> | null>(null);
  protected error = signal('');
  protected loadingMore = signal(false);

  ngOnInit() { this.load(); }

  setFilter(f: Filter) { this.filter.set(f); this.data.set(null); this.load(); }

  async load() {
    this.error.set('');
    try {
      this.data.set(await this.api.get<Paged<MatchSummary>>('/matches', { filter: this.filter(), pageSize: 20 }));
    } catch {
      this.error.set('Could not load your matches.');
    }
  }

  async more() {
    const d = this.data();
    if (!d) return;
    this.loadingMore.set(true);
    try {
      const next = await this.api.get<Paged<MatchSummary>>('/matches', { filter: this.filter(), pageSize: 20, page: d.page + 1 });
      this.data.set({ ...next, items: [...d.items, ...next.items] });
    } finally { this.loadingMore.set(false); }
  }

  open(m: MatchSummary) {
    const active = !['COMPLETED', 'CANCELLED'].includes(m.status);
    this.router.navigate(active ? ['/match', m.code] : ['/matches', m.code]);
  }
}
