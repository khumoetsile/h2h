import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { ACTIVE_STATES, DISPLAY_STATE } from '../../core/challenge-state';
import { ConfigStore } from '../../core/config.store';
import { formatMoney } from '../../core/format';
import { MatchSummary, Paged } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { Countdown } from '../../shared/countdown';
import { Avatar, EmptyState, GameIcon, LoadError, SkeletonList } from '../../shared/ui';

type Filter = 'all' | 'active' | 'wins' | 'losses' | 'draws' | 'void' | 'timed_out' | 'cancelled';

/**
 * MY CHALLENGES — every challenge a player has been part of, each with one
 * unambiguous state (Waiting for opponent, Locked in, Won, Timed out, …)
 * and exactly what it meant for their money.
 */
@Component({
  selector: 'app-match-history',
  imports: [RouterLink, DatePipe, MatIconModule, Avatar, EmptyState, GameIcon, LoadError, SkeletonList, Countdown],
  template: `
    <div class="page page-narrow">
      <div class="page-head">
        <div><h1>My challenges</h1><p class="sub">What happened to every challenge you've been in.</p></div>
      </div>
      <div class="segmented filters">
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
          <app-empty icon="swords" title="Nothing here yet" text="Challenge another player to start building your record.">
            <a class="btn btn-primary btn-sm" routerLink="/football">Find a challenge</a>
          </app-empty>
        } @else {
          <div class="list">
            @for (m of data()!.items; track m.id) {
              <a class="list-item row-item" [routerLink]="isActive(m) ? ['/match', m.code] : ['/matches', m.code]">
                <app-game-icon [slug]="m.game.slug" [color]="m.game.accentColor" [size]="36" />
                <div class="grow">
                  @if (m.football) {
                    <div class="t">{{ m.football.homeTeam }} vs {{ m.football.awayTeam }}</div>
                    <div class="muted small ellip">{{ m.football.questionName }}</div>
                    @if (m.football.myPickLabel) {
                      <div class="tiny picks">You: <strong>{{ m.football.myPickLabel }}</strong>@if (m.football.opponentPickLabel) { · Opponent: <strong>{{ m.football.opponentPickLabel }}</strong> }</div>
                    }
                  } @else {
                    <div class="t">{{ m.game.name }}</div>
                    @if (m.myScore !== null) { <div class="muted small">Score {{ m.myScore }} – {{ m.opponentScore ?? '—' }}</div> }
                  }
                  <div class="muted tiny opp">
                    @if (m.opponent) { <app-avatar [name]="m.opponent.username" [color]="m.opponent.avatarColor" [size]="16" /> vs {{ m.opponent.username }} · }
                    {{ (m.completedAt || m.cancelledAt || m.createdAt) | date: 'd MMM, HH:mm' }}
                  </div>
                </div>
                <div class="end">
                  <span [class]="label(m).chip">{{ label(m).label }}</span>
                  @if (deadline(m); as d) { <app-countdown [deadline]="d" (expired)="load(true)" /> }
                  @else { <span class="small money" [class.win]="m.displayState === 'WON'" [class.loss]="m.displayState === 'LOST' || m.displayState === 'LEFT'">{{ moneyLine(m) }}</span> }
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
    .filters { margin-bottom: 16px; }
    .row-item { align-items: flex-start; }
    .grow { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .t { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .picks strong { color: var(--text); }
    .opp { line-height: 1.6; app-avatar { display: inline-flex; vertical-align: -3px; margin-right: 2px; } }
    .end { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
    .more { display: flex; justify-content: center; padding: 14px; border-top: 1px solid var(--border); }
  `],
})
export class MatchHistoryPage implements OnInit {
  private api = inject(Api);
  private router = inject(Router);
  private config = inject(ConfigStore);
  private realtime = inject(RealtimeService);
  private destroyRef = inject(DestroyRef);
  protected filters: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'active', label: 'Active' }, { key: 'wins', label: 'Won' }, { key: 'losses', label: 'Lost' },
    { key: 'draws', label: 'Draw' }, { key: 'void', label: 'Void' }, { key: 'timed_out', label: 'Timed out' }, { key: 'cancelled', label: 'Cancelled' },
  ];
  protected filter = signal<Filter>('all');
  protected data = signal<Paged<MatchSummary> | null>(null);
  protected error = signal('');
  protected loadingMore = signal(false);

  ngOnInit() {
    this.load();
    this.realtime.match$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load(true));
  }

  setFilter(f: Filter) { this.filter.set(f); this.data.set(null); this.load(); }

  private params(page = 1) {
    const f = this.filter();
    return f === 'active' ? { status: 'active', pageSize: 20, page } : { filter: f, pageSize: 20, page };
  }

  async load(silent = false) {
    if (!silent) this.error.set('');
    try {
      this.data.set(await this.api.get<Paged<MatchSummary>>('/matches', this.params()));
    } catch {
      if (!silent) this.error.set('Could not load your challenges.');
    }
  }

  async more() {
    const d = this.data();
    if (!d) return;
    this.loadingMore.set(true);
    try {
      const next = await this.api.get<Paged<MatchSummary>>('/matches', this.params(d.page + 1));
      this.data.set({ ...next, items: [...d.items, ...next.items] });
    } finally { this.loadingMore.set(false); }
  }

  label(m: MatchSummary) {
    if (m.displayState === 'LOCKING_IN' && m.lockedIn === false) return { label: 'Your turn — lock in', chip: 'chip chip-accent' };
    return DISPLAY_STATE[m.displayState];
  }
  isActive(m: MatchSummary) { return ACTIVE_STATES.includes(m.displayState); }

  deadline(m: MatchSummary) {
    const t = m.timers;
    if (!t || !this.isActive(m)) return null;
    if (m.displayState === 'WAITING_FOR_OPPONENT') return t.acceptanceDeadline;
    if (m.category === 'FOOTBALL' && m.displayState === 'LOCKED_IN') return m.football?.kickoffAt ?? null;
    return t.myDeadline ?? t.playerActionDeadline ?? t.completionDeadline ?? t.lockInDeadline;
  }

  moneyLine(m: MatchSummary) {
    switch (m.displayState) {
      case 'WON': return `+${formatMoney((m.payout ?? m.prize) - m.stake)}`;
      case 'LOST': return `−${formatMoney(m.stake)}`;
      case 'LEFT': return `−${this.config.abandonmentFee()} fee`;
      case 'IN_PROGRESS': return m.football?.fixtureStatus === 'LIVE' ? `LIVE ${m.football.homeScore}–${m.football.awayScore}` : 'Live';
      default: return `${formatMoney(m.stake)} refunded`;
    }
  }
}
