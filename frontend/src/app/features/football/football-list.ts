import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { FootballCompetition, FootballFixture } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { EmptyState, LoadError } from '../../shared/ui';

/**
 * "Football" tab. Upcoming/live fixtures as simple cards — team names, kickoff
 * time, competition, a live score when it's underway. Head2Head does not
 * create these matches; the fixtures come from an external data provider via
 * the backend. Tapping a fixture opens the challenge-question picker.
 */
@Component({
  selector: 'app-football-list',
  imports: [RouterLink, MatIconModule, EmptyState, LoadError],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Play</h1>
          <p class="sub">Pick a category to challenge someone.</p>
        </div>
      </div>

      <div class="segmented tabs play-tabs">
        <a routerLink="/games"><mat-icon inline>sports_esports</mat-icon> Games</a>
        <button class="active"><mat-icon inline>sports_soccer</mat-icon> Football</button>
      </div>

      <div class="segmented tabs comp-tabs">
        <button [class.active]="competitionId() === null" (click)="setCompetition(null)">All</button>
        @for (c of competitions(); track c.id) {
          <button [class.active]="competitionId() === c.id" (click)="setCompetition(c.id)">{{ c.code }}</button>
        }
      </div>

      @if (error()) {
        <app-load-error [message]="error()" (retry)="load()" />
      } @else if (!fixtures()) {
        <div class="fixture-list">
          @for (i of [1,2,3,4]; track i) {
            <div class="card fixture-card"><div class="skeleton" style="height:16px;width:60%"></div><div class="skeleton" style="height:22px;width:90%;margin-top:10px"></div></div>
          }
        </div>
      } @else if (fixtures()!.length === 0) {
        <app-empty icon="sports_soccer" title="No upcoming fixtures right now" text="Please check back soon." />
      } @else {
        <div class="fixture-list">
          @for (f of fixtures(); track f.id) {
            <a class="card fixture-card card-interactive fade-in" [routerLink]="['/football', f.id]">
              <div class="fc-top">
                <span class="muted small">{{ f.competition.name }}</span>
                @if (f.status === 'LIVE') {
                  <span class="chip chip-win"><span class="live-dot"></span>LIVE @if (f.minute) { {{ f.minute }}' }</span>
                } @else {
                  <span class="muted tiny">{{ kickoffLabel(f.kickoffAt) }}</span>
                }
              </div>
              <div class="fc-teams">
                <span class="team">{{ f.homeTeam.name }}</span>
                @if (f.status === 'LIVE' || f.status === 'FINISHED') {
                  <span class="score">{{ f.homeScore }} – {{ f.awayScore }}</span>
                } @else {
                  <span class="vs-sep">vs</span>
                }
                <span class="team">{{ f.awayTeam.name }}</span>
              </div>
              <div class="fc-foot">
                @if (f.isSimulated) { <span class="muted tiny">Simulated demo fixture</span> } @else { <span class="muted tiny">Live football data</span> }
                @if (f.status === 'SCHEDULED') { <span class="btn btn-sm btn-primary">Challenge<mat-icon>chevron_right</mat-icon></span> }
              </div>
            </a>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .play-tabs { margin-bottom: 12px; }
    .comp-tabs { margin-bottom: 16px; }
    .fixture-list { display: grid; gap: 12px; grid-template-columns: 1fr; }
    @media (min-width: 640px) { .fixture-list { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 960px) { .fixture-list { grid-template-columns: repeat(3, 1fr); } }
    .fixture-card { display: flex; flex-direction: column; gap: 10px; padding: 16px; }
    .fc-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .fc-teams { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 700; font-family: var(--font-display); font-size: 15px; }
    .team { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .team:last-child { text-align: right; }
    .vs-sep { color: var(--muted); font-size: 12px; font-weight: 500; flex-shrink: 0; }
    .score { color: var(--accent); flex-shrink: 0; font-size: 17px; }
    .fc-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
    .live-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: blink 1.4s infinite; margin-right: 4px; }
    @keyframes blink { 50% { opacity: .3; } }
  `],
})
export class FootballListPage implements OnInit {
  private api = inject(Api);
  private realtime = inject(RealtimeService);
  private destroyRef = inject(DestroyRef);

  protected competitions = signal<FootballCompetition[]>([]);
  protected competitionId = signal<number | null>(null);
  protected fixtures = signal<FootballFixture[] | null>(null);
  protected error = signal('');

  ngOnInit() {
    this.loadCompetitions();
    this.load();
    this.realtime.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load());
  }

  async loadCompetitions() {
    try {
      this.competitions.set((await this.api.get<{ competitions: FootballCompetition[] }>('/football/competitions')).competitions);
    } catch { /* the "All" filter still works without this */ }
  }

  setCompetition(id: number | null) {
    this.competitionId.set(id);
    this.load();
  }

  async load() {
    this.error.set('');
    try {
      const params: Record<string, string> = { status: 'upcoming' };
      if (this.competitionId() !== null) params['competitionId'] = String(this.competitionId());
      this.fixtures.set((await this.api.get<{ fixtures: FootballFixture[] }>('/football/fixtures', params)).fixtures);
    } catch (err) {
      this.error.set(apiError(err).message);
    }
  }

  kickoffLabel(iso: string) {
    const d = new Date(iso);
    const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return `${day}, ${time}`;
  }
}
