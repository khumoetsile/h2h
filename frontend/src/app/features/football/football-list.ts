import { Component, DestroyRef, computed, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { interval } from 'rxjs';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { SeoService } from '../../core/seo.service';
import { DISPLAY_STATE } from '../../core/challenge-state';
import { FootballCompetition, FootballFixture, MatchSummary, OpenFootballChallenge, Paged } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { RematchService } from '../../core/rematch.service';
import { ServerClock } from '../../core/server-clock';
import { Countdown } from '../../shared/countdown';
import { MoneyPipe } from '../../shared/pipes';
import { formatMoney } from '../../core/format';
import { EmptyState, LoadError } from '../../shared/ui';
import { JoinSheet, OpenChallengeCard } from './open-challenge';
import { readGuestFollowedFixtures, writeGuestFollowedFixtures } from './football-follow-storage';

type DayTab = 'live' | 'today' | 'tomorrow' | 'later';

/**
 * FOOTBALL home — built around what players actually do: join someone
 * who's already waiting, check on their own challenges, or start a new one
 * on a real upcoming fixture. Head2Head never runs the football match; the
 * fixture is just the event two players compete over.
 */
@Component({
  selector: 'app-football-list',
  imports: [RouterLink, DatePipe, MatIconModule, MoneyPipe, EmptyState, LoadError, Countdown, OpenChallengeCard, JoinSheet],
  template: `
    <div class="page">
      <div class="segmented tabs play-tabs">
        <a routerLink="/games"><mat-icon inline>sports_esports</mat-icon> Games</a>
        <button class="active"><mat-icon inline>sports_soccer</mat-icon> Football</button>
      </div>

      <header class="hero">
        <div class="grow">
          <h1>Football fixtures &amp; results</h1>
          <p class="sub">Browse upcoming matches, live scores and past results for free.</p>
        </div>
        <button class="btn btn-ghost btn-lg" (click)="scrollToResults()"><mat-icon>history</mat-icon>Past results</button>
        <button class="btn btn-primary btn-lg create" (click)="scrollToFixtures()"><mat-icon>{{ auth.isLoggedIn() ? 'swords' : 'sports_soccer' }}</mat-icon> {{ auth.isLoggedIn() ? 'Create challenge' : 'Browse fixtures' }}</button>
      </header>

      @if (!auth.isLoggedIn()) {
        <div class="card public-join">
          <div class="grow"><strong>Follow the fixtures. Challenge a player when you're ready.</strong><p class="muted small">Browse football without an account. Joining a 1v1 challenge requires an account; all funds in this demo are simulated.</p></div>
          <a class="btn btn-primary btn-sm" routerLink="/register">Create account</a>
        </div>
      }

      @if (rematch.current(); as r) {
        <div class="card target-banner fade-in">
          <mat-icon>swords</mat-icon>
          <div class="grow"><strong>Challenging {{ r.username }}</strong><p class="muted small">Pick a fixture below to set up your challenge.</p></div>
          <button class="btn btn-ghost btn-sm" (click)="rematch.clear()">Clear</button>
        </div>
      }

      @if (followedFixtures().length) {
        <section aria-labelledby="followed-title">
          <div class="section-title">
            <div><h2 id="followed-title">Followed matches</h2><p class="sub">Quick access to matches you’re keeping an eye on.</p></div>
          </div>
          <div class="followed-list">
            @for (f of followedFixtures(); track f.id) {
              <div class="card followed-row">
                <a [routerLink]="['/football', f.id]" class="grow">
                  <strong>{{ f.homeTeam.shortName || f.homeTeam.name }} <span class="muted">{{ f.status === 'LIVE' || f.status === 'FINISHED' ? f.homeScore + '–' + f.awayScore : 'vs' }}</span> {{ f.awayTeam.shortName || f.awayTeam.name }}</strong>
                  <span class="muted tiny">{{ f.competition.name }} · {{ f.status === 'LIVE' && f.minute ? 'LIVE ' + f.minute + '′' : (f.kickoffAt | date: 'EEE d MMM, HH:mm') }}</span>
                </a>
                <button class="btn btn-ghost btn-sm" type="button" (click)="unfollow(f.id)" [attr.aria-label]="'Stop following ' + f.homeTeam.name + ' versus ' + f.awayTeam.name"><mat-icon>star</mat-icon><span class="unfollow-label">Following</span></button>
              </div>
            }
          </div>
          @if (followError()) { <p class="muted small" role="status">{{ followError() }}</p> }
        </section>
      }

      @if (auth.isLoggedIn()) {
      <!-- Open challenges -->
      <section>
        <div class="section-title">
          <div><h2>Open challenges</h2><p class="sub">Players looking for an opponent</p></div>
          @if (visibleOpen().length > 3) {
            <button class="btn btn-ghost btn-sm" (click)="showAllOpen.set(!showAllOpen())">{{ showAllOpen() ? 'Show less' : 'Show all ' + visibleOpen().length }}</button>
          }
        </div>
        @if (openError()) {
          <app-load-error [message]="openError()" (retry)="loadOpen()" />
        } @else if (!open()) {
          <div class="card-grid">@for (i of [1,2]; track i) { <div class="card sk"><div class="skeleton" style="height:120px"></div></div> }</div>
        } @else if (visibleOpen().length === 0) {
          <div class="card empty-open">
            <mat-icon>group_off</mat-icon>
            <div class="grow"><strong>No one is waiting right now</strong><p class="muted small">Start one: pick a fixture and choose <em>Find opponent</em>.</p></div>
          </div>
        } @else {
          <div class="card-grid">
            @for (c of shownOpen(); track c.matchId) {
              <app-open-challenge-card [challenge]="c" (join)="joinTarget.set($event)" />
            }
          </div>
        }
      </section>
      }

      <!-- My challenges (active) -->
      @if (active() && active()!.length) {
        <section>
          <div class="section-title">
            <div><h2>My challenges</h2><p class="sub">Your active challenges</p></div>
            <a class="btn btn-ghost btn-sm" routerLink="/matches">All</a>
          </div>
          <div class="list card card-flush">
            @for (m of active(); track m.id) {
              <a class="list-item mine" [routerLink]="['/match', m.code]">
                <div class="grow">
                  <div class="t">{{ m.football?.homeTeam }} vs {{ m.football?.awayTeam }}</div>
                  <div class="muted small ellip">{{ m.football?.questionName }} · <span class="money">{{ m.stake | money }}</span>
                    @if (m.opponent) { · vs {{ m.opponent.username }} }</div>
                </div>
                <div class="end">
                  @if (m.displayState === 'LOCKING_IN' && m.lockedIn === false) {
                    <span class="chip chip-accent">Your turn</span>
                  } @else if (m.displayState === 'IN_PROGRESS' && m.football?.fixtureStatus === 'LIVE') {
                    <span class="chip chip-win"><span class="live-dot"></span> LIVE {{ m.football?.homeScore }}-{{ m.football?.awayScore }}</span>
                  } @else {
                    <span [class]="state(m).chip">{{ state(m).label }}</span>
                  }
                  @if (activeDeadline(m); as d) { <app-countdown [deadline]="d" /> }
                </div>
              </a>
            }
          </div>
        </section>
      }

      <!-- Fixtures -->
      <section id="fixtures">
        <div class="section-title">
          <div><h2>Upcoming fixtures &amp; live scores</h2><p class="sub">Browse by competition or date. Open any match for its match centre.</p></div>
        </div>
        <div class="football-filters">
          <label>Competition
            <select #competition (change)="selectCompetition(competition.value)">
              <option value="">All competitions</option>
              @for (c of competitions(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }
            </select>
          </label>
          <label>From <input #dateFrom type="date" aria-label="Filter fixtures and results from this date" (change)="selectDates(dateFrom.value, dateTo.value)" /></label>
          <label>To <input #dateTo type="date" aria-label="Filter fixtures and results through this date" (change)="selectDates(dateFrom.value, dateTo.value)" /></label>
        </div>
        @if (competitionError()) { <p class="muted small">{{ competitionError() }}</p> }
        <div class="segmented tabs day-tabs">
          @for (t of dayTabs; track t.key) {
            <button [class.active]="day() === t.key" (click)="day.set(t.key)">
              @if (t.key === 'live') { <span class="live-dot live-red"></span> }
              {{ t.label }} <span class="count-muted">{{ byDay()[t.key].length }}</span>
            </button>
          }
        </div>
        @if (error()) {
          <app-load-error [message]="error()" (retry)="load()" />
        } @else if (!lastUpdatedAt() && fixtures()?.length === 0) {
          <div class="card notice"><mat-icon>cloud_off</mat-icon><div><strong>Football data is not available yet</strong><p class="muted small">No synced fixtures are available. Please check back after the football data source has been configured and synchronized.</p></div></div>
        } @else if (!fixtures()) {
          <div class="card-grid">@for (i of [1,2,3]; track i) { <div class="card sk"><div class="skeleton" style="height:90px"></div></div> }</div>
        } @else if (byDay()[day()].length === 0) {
          <app-empty icon="sports_soccer" [title]="emptyTitle()" text="Try another day." />
        } @else {
          <div class="card-grid">
            @for (f of byDay()[day()]; track f.id) {
              <a class="card fixture card-interactive fade-in" [routerLink]="['/football', f.id]">
                <div class="fx-top">
                  <span class="muted tiny ellip">{{ f.competition.name }}</span>
                  @if (f.status === 'LIVE') {
                    <span class="chip chip-win"><span class="live-dot"></span> LIVE @if (f.minute) { {{ f.minute }}' }</span>
                  } @else {
                    <span class="small kick">{{ f.kickoffAt | date: 'EEE HH:mm' }}</span>
                  }
                </div>
                <div class="teams-line">
                  <span class="team">{{ f.homeTeam.name }}</span>
                  @if (f.status === 'LIVE') { <span class="score">{{ f.homeScore }} - {{ f.awayScore }}</span> } @else { <span class="vs">vs</span> }
                  <span class="team">{{ f.awayTeam.name }}</span>
                </div>
                <div class="fx-foot">
                  @if (f.status === 'SCHEDULED') {
                    <span class="small muted">Kickoff in <app-countdown [deadline]="f.kickoffAt" [icon]="false" /></span>
                    <span class="btn btn-sm btn-primary">{{ auth.isLoggedIn() ? 'Challenge' : 'View match' }}<mat-icon>chevron_right</mat-icon></span>
                  } @else {
                    <span class="small muted">Challenges closed at kickoff</span>
                  }
                </div>
                @if (f.openChallenges > 0 && f.status === 'SCHEDULED') {
                  <div class="tiny waiting"><mat-icon inline>person_search</mat-icon> {{ f.openChallenges }} player{{ f.openChallenges === 1 ? '' : 's' }} waiting for an opponent</div>
                }
              </a>
            }
          </div>
        }
        @if (anySimulated()) { <p class="muted tiny sim-note">Simulated demo fixtures are shown because no live football data provider is configured.</p> }
        @if (lastUpdatedAt()) { <p class="muted tiny">Football data last updated {{ lastUpdatedAt() | date: 'EEE d MMM, HH:mm' }}. Live updates may be delayed.</p> }
      </section>

      <section id="past-results">
        <div class="section-title">
          <div>
            <h2>Past match results</h2>
            <p class="sub">Browse completed scores. Use the competition and date filters above to narrow your search.</p>
          </div>
          @if (resultsTotal() > 0) { <span class="muted small">{{ results()?.length ?? 0 }} of {{ resultsTotal() }} matches</span> }
        </div>
        @if (resultsError()) {
          <app-load-error [message]="resultsError()" (retry)="load()" />
        } @else if (!results()) {
          <div class="card-grid">@for (i of [1,2,3]; track i) { <div class="card sk"><div class="skeleton" style="height:90px"></div></div> }</div>
        } @else if (results()!.length === 0) {
          <app-empty icon="sports_soccer" title="No past results for these filters" text="Try a different competition or date range." />
        } @else {
          <div class="card-grid">
            @for (f of results(); track f.id) {
              <a class="card fixture card-interactive" [routerLink]="['/football', f.id]">
                <div class="fx-top"><span class="muted tiny ellip">{{ f.competition.name }}</span><span class="small kick">{{ f.kickoffAt | date: 'EEE d MMM' }}</span></div>
                <div class="teams-line"><span class="team">{{ f.homeTeam.name }}</span><span class="score">{{ f.homeScore }}–{{ f.awayScore }}</span><span class="team">{{ f.awayTeam.name }}</span></div>
                <div class="fx-foot"><span class="small muted">Final score</span><span class="btn btn-sm btn-ghost">Match centre<mat-icon>chevron_right</mat-icon></span></div>
              </a>
            }
          </div>
          @if (results()!.length < resultsTotal()) {
            <div class="results-more">
              <button class="btn btn-ghost" [disabled]="loadingMoreResults()" (click)="loadMoreResults()">
                <mat-icon>{{ loadingMoreResults() ? 'hourglass_top' : 'expand_more' }}</mat-icon>
                {{ loadingMoreResults() ? 'Loading results…' : 'Load more results' }}
              </button>
            </div>
          }
        }
      </section>

      <!-- Recent player challenges -->
      @if (recent() && recent()!.length) {
        <section>
          <div class="section-title">
            <div><h2>Your recent challenges</h2><p class="sub">Your latest battles</p></div>
            <a class="btn btn-ghost btn-sm" routerLink="/matches">History</a>
          </div>
          <div class="list card card-flush">
            @for (m of recent(); track m.id) {
              <div class="list-item result-row">
                <a class="grow link-area" [routerLink]="['/matches', m.code]">
                  <div class="t">{{ m.football?.homeTeam }} vs {{ m.football?.awayTeam }}</div>
                  <div class="muted small ellip">{{ m.football?.questionName }}@if (m.opponent) { · vs {{ m.opponent.username }} }</div>
                </a>
                <div class="end">
                  <span [class]="state(m).chip">{{ state(m).label }}</span>
                  <span class="small money" [class.win]="m.displayState === 'WON'" [class.loss]="m.displayState === 'LOST'">{{ moneyLine(m) }}</span>
                </div>
                @if (m.opponent && !m.opponent.isBot) {
                  <button class="btn btn-sm rematch" (click)="rematchWith(m)" [attr.aria-label]="'Rematch ' + m.opponent.username"><mat-icon>replay</mat-icon></button>
                }
              </div>
            }
          </div>
        </section>
      }
    </div>

    @if (joinTarget(); as c) {
      <app-join-sheet [challenge]="c" (closed)="onJoinClosed($event)" />
    }
  `,
  styles: [`
    .play-tabs { margin-bottom: 16px; }
    .hero { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-bottom: 4px;
      .grow { flex: 1; min-width: 200px; } .sub { color: var(--text-2); margin-top: 4px; } }
    .create { flex: 1 1 100%; }
    @media (min-width: 640px) { .create { flex: 0 0 auto; } }
    .results-more { display: flex; justify-content: center; margin-top: 16px; }
    .target-banner { display: flex; align-items: center; gap: 12px; padding: 14px 16px; margin-top: 16px; border-color: var(--accent);
      mat-icon { color: var(--accent); } .grow { flex: 1; min-width: 0; } }
    .empty-open { display: flex; align-items: center; gap: 12px; padding: 16px; mat-icon { color: var(--muted); } .grow { flex: 1; min-width: 0; } }
    .sk { padding: 16px; }
    .mine, .result-row { gap: 10px; }
    .grow { flex: 1; min-width: 0; }
    .t { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .end { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
    .link-area { color: inherit; text-decoration: none; }
    .rematch { padding: 0 10px; flex-shrink: 0; }
    .followed-list { display: grid; gap: 8px; }
    .followed-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px;
      a { display: grid; gap: 4px; color: inherit; text-decoration: none; min-width: 0; }
      strong { overflow-wrap: anywhere; } }
    .unfollow-label { font-size: 11px; }
    .day-tabs { margin-bottom: 12px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); overflow: hidden; }
    .day-tabs button { padding: 8px 4px; min-width: 0; font-size: 13px; gap: 3px; }
    @media (min-width: 640px) { .day-tabs { display: inline-grid; } .day-tabs button { padding: 8px 14px; font-size: 14px; } }
    .count-muted { color: var(--muted); font-weight: 500; font-size: 12px; }
    .live-red { color: var(--loss); margin-right: 2px; }
    .fixture { display: flex; flex-direction: column; gap: 10px; padding: 16px; min-width: 0; text-decoration: none; color: inherit; }
    .fx-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .kick { font-weight: 600; flex-shrink: 0; }
    .fx-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
    .waiting { color: var(--demo); display: flex; align-items: center; gap: 4px; }
    .sim-note { margin-top: 10px; }
    .public-join { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 16px 0; padding: 16px;
      .grow { flex: 1; min-width: 0; } }
    .football-filters { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0;
      label { display: grid; gap: 4px; color: var(--text-2); font-size: 12px; }
      select, input { min-height: 40px; padding: 7px 10px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); } }
  `],
})
export class FootballListPage implements OnInit {
  /** ?opponent=<username> — arriving from a profile's "Challenge" button. */
  readonly opponent = input<string | undefined>();
  private api = inject(Api);
  private seo = inject(SeoService);
  protected auth = inject(AuthService);
  private router = inject(Router);
  private realtime = inject(RealtimeService);
  private clock = inject(ServerClock);
  private destroyRef = inject(DestroyRef);
  protected rematch = inject(RematchService);

  protected fixtures = signal<FootballFixture[] | null>(null);
  protected followedFixturesServer = signal<FootballFixture[]>([]);
  protected guestFollowedIds = signal<number[]>(readGuestFollowedFixtures());
  protected followError = signal('');
  protected results = signal<FootballFixture[] | null>(null);
  protected resultsTotal = signal(0);
  protected loadingMoreResults = signal(false);
  protected resultsError = signal('');
  private resultsPage = 1;
  private resultsQueryVersion = 0;
  protected competitions = signal<FootballCompetition[]>([]);
  protected lastUpdatedAt = signal<string | null>(null);
  private competitionId = signal<number | null>(null);
  private dateFrom = signal('');
  private dateTo = signal('');
  protected error = signal('');
  protected competitionError = signal('');
  protected open = signal<OpenFootballChallenge[] | null>(null);
  protected openError = signal('');
  protected showAllOpen = signal(false);
  protected joinTarget = signal<OpenFootballChallenge | null>(null);
  protected active = signal<MatchSummary[] | null>(null);
  protected recent = signal<MatchSummary[] | null>(null);
  protected day = signal<DayTab>('today');
  private dayChosen = false;

  protected dayTabs: { key: DayTab; label: string }[] = [
    { key: 'live', label: 'Live' }, { key: 'today', label: 'Today' }, { key: 'tomorrow', label: 'Tomorrow' }, { key: 'later', label: 'Later' },
  ];

  /** Anything whose accept timer has run out disappears immediately, even before the next refresh. */
  protected visibleOpen = computed(() => (this.open() ?? []).filter((c) => this.clock.remainingMs(c.acceptanceDeadline) > 0));
  protected shownOpen = computed(() => (this.showAllOpen() ? this.visibleOpen() : this.visibleOpen().slice(0, 3)));
  protected anySimulated = computed(() => (this.fixtures() ?? []).some((f) => f.isSimulated));
  protected followedFixtures = computed(() => {
    if (this.auth.isLoggedIn()) return this.followedFixturesServer();
    const byId = new Map([...(this.fixtures() ?? []), ...(this.results() ?? [])].map((fixture) => [fixture.id, fixture]));
    return this.guestFollowedIds().map((id) => byId.get(id)).filter((fixture): fixture is FootballFixture => !!fixture);
  });

  /** Fixtures bucketed by the player's local calendar day, relative to server time. */
  protected byDay = computed(() => {
    const out: Record<DayTab, FootballFixture[]> = { live: [], today: [], tomorrow: [], later: [] };
    const now = new Date(this.clock.now());
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startTomorrow = startToday + 86400000;
    const startLater = startTomorrow + 86400000;
    for (const f of this.fixtures() ?? []) {
      const k = new Date(f.kickoffAt).getTime();
      if (f.status === 'LIVE') out.live.push(f);
      else if (k < startTomorrow) out.today.push(f);
      else if (k < startLater) out.tomorrow.push(f);
      else out.later.push(f);
    }
    return out;
  });
  protected emptyTitle = computed(() => ({ live: 'No matches are live right now', today: 'No more fixtures today', tomorrow: 'No fixtures tomorrow', later: 'No later fixtures yet' })[this.day()]);

  ngOnInit() {
    this.seo.publish('Football fixtures, live scores and results', 'Browse upcoming football fixtures, live scores and recent results. View match centres and find relevant Head2Head challenges.', '/football');
    const opp = this.opponent();
    if (opp) this.rematch.setPending({ username: opp.replace(/^@/, ''), avatarColor: '#64748B' });
    this.load();
    this.loadCompetitions();
    if (this.auth.isLoggedIn()) {
      this.loadOpen();
      this.loadMine();
      this.loadFollowed();
    }
    const refresh = () => { this.loadOpen(); this.loadMine(); };
    this.realtime.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => { this.load(); refresh(); });
    this.realtime.match$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(refresh);
    this.realtime.queue$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.loadOpen());
    this.realtime.config$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load());
    // Other players' new challenges aren't pushed to everyone — poll gently.
    interval(10000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.loadOpen());
    interval(60000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => { this.load(); this.loadMine(); });
  }

  state(m: MatchSummary) { return DISPLAY_STATE[m.displayState]; }

  /** The timer that matters for an active row, from the server's own deadlines. */
  activeDeadline(m: MatchSummary) {
    const t = m.timers;
    if (!t) return null;
    if (m.displayState === 'WAITING_FOR_OPPONENT') return t.acceptanceDeadline;
    if (m.displayState === 'LOCKING_IN') return t.myDeadline ?? t.lockInDeadline;
    if (m.displayState === 'LOCKED_IN' && m.football?.kickoffAt) return m.football.kickoffAt;
    return null;
  }

  moneyLine(m: MatchSummary) {
    const fmt = (v: number) => formatMoney(v);
    switch (m.displayState) {
      case 'WON': return `+${fmt((m.payout ?? m.prize) - m.stake)}`;
      case 'LOST': return `−${fmt(m.stake)}`;
      case 'LEFT': return 'Refunded − fee';
      default: return `${fmt(m.stake)} refunded`;
    }
  }

  scrollToFixtures() {
    document.getElementById('fixtures')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  scrollToResults() {
    document.getElementById('past-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  rematchWith(m: MatchSummary) {
    if (!m.opponent) return;
    this.rematch.setPending({ username: m.opponent.username, avatarColor: m.opponent.avatarColor, challengeTypeSlug: m.football?.challengeTypeSlug, stake: m.stake });
    this.scrollToFixtures();
  }

  onJoinClosed(e: { refresh: boolean }) {
    this.joinTarget.set(null);
    if (e.refresh) this.loadOpen();
  }

  async load() {
    const queryVersion = ++this.resultsQueryVersion;
    this.error.set('');
    this.resultsError.set('');
    this.resultsPage = 1;
    this.results.set(null);
    this.resultsTotal.set(0);
    try {
      const filters = { competitionId: this.competitionId(), dateFrom: this.dateFrom(), dateTo: this.dateTo(), pageSize: 100 };
      const [upcoming, results] = await Promise.all([
        this.api.get<{ fixtures: FootballFixture[]; lastUpdatedAt: string | null }>('/football/fixtures', filters),
        this.api.get<{ fixtures: FootballFixture[]; total: number }>('/football/fixtures', { ...filters, status: 'completed', pageSize: 12 }),
      ]);
      if (queryVersion !== this.resultsQueryVersion) return;
      this.fixtures.set(upcoming.fixtures);
      this.results.set(results.fixtures);
      this.resultsTotal.set(results.total);
      this.lastUpdatedAt.set(upcoming.lastUpdatedAt);
      this.guestFollowedIds.set(readGuestFollowedFixtures());
      if (this.auth.isLoggedIn()) void this.loadFollowed();
      this.seo.publish(
        'Football fixtures, live scores and results',
        'Browse upcoming football fixtures, live scores and recent results. View match centres and find relevant Head2Head challenges.',
        '/football',
        upcoming.fixtures.length > 0 && !upcoming.fixtures.some((f) => f.isSimulated),
      );
      if (!this.dayChosen) {
        // Open on the first day that actually has something to show.
        const b = this.byDay();
        this.day.set((['live', 'today', 'tomorrow', 'later'] as DayTab[]).find((k) => b[k].length) ?? 'today');
        this.dayChosen = true;
      }

    } catch (err) {
      if (queryVersion === this.resultsQueryVersion) {
        const message = apiError(err).message;
        this.error.set(message);
        this.resultsError.set(message);
        this.results.set([]);
      }
    }
  }

  async loadFollowed() {
    try {
      const result = await this.api.get<{ fixtures: FootballFixture[] }>('/football/followed-fixtures');
      this.followedFixturesServer.set(result.fixtures);
      this.followError.set('');
    } catch (err) {
      this.followError.set(apiError(err).message);
    }
  }

  async unfollow(fixtureId: number) {
    this.followError.set('');
    if (this.auth.isLoggedIn()) {
      try {
        await this.api.delete(`/football/fixtures/${fixtureId}/follow`);
        this.followedFixturesServer.update((fixtures) => fixtures.filter((fixture) => fixture.id !== fixtureId));
      } catch (err) {
        this.followError.set(apiError(err).message);
      }
      return;
    }
    const remaining = this.guestFollowedIds().filter((id) => id !== fixtureId);
    if (!writeGuestFollowedFixtures(remaining)) {
      this.followError.set('Your browser could not update followed matches. Check local storage settings and try again.');
      return;
    }
    this.guestFollowedIds.set(remaining);
  }

  async loadMoreResults() {
    if (this.loadingMoreResults() || this.resultsPage * 12 >= this.resultsTotal()) return;
    this.loadingMoreResults.set(true);
    this.resultsError.set('');
    const queryVersion = this.resultsQueryVersion;
    const nextPage = this.resultsPage + 1;
    try {
      const response = await this.api.get<{ fixtures: FootballFixture[]; total: number }>('/football/fixtures', {
        competitionId: this.competitionId(),
        dateFrom: this.dateFrom(),
        dateTo: this.dateTo(),
        status: 'completed',
        page: nextPage,
        pageSize: 12,
      });
      if (queryVersion !== this.resultsQueryVersion) return;
      this.results.update((current) => [...(current ?? []), ...response.fixtures]);
      this.resultsPage = nextPage;
      this.resultsTotal.set(response.total);
    } catch (err) {
      if (queryVersion === this.resultsQueryVersion) this.resultsError.set(apiError(err).message);
    } finally {
      this.loadingMoreResults.set(false);
    }
  }
  async loadCompetitions() {
    this.competitionError.set('');
    try {
      this.competitions.set((await this.api.get<{ competitions: FootballCompetition[] }>('/football/competitions')).competitions);
    } catch (err) {
      this.competitionError.set(`Competition filters are unavailable. ${apiError(err).message}`);
    }
  }

  selectCompetition(value: string) {
    this.competitionId.set(value ? Number(value) : null);
    this.load();
  }

  selectDates(from: string, to: string) {
    this.dateFrom.set(from);
    this.dateTo.set(to);
    this.load();
  }

  async loadOpen() {
    if (!this.auth.isLoggedIn()) return;
    this.openError.set('');
    try {
      this.open.set((await this.api.get<{ challenges: OpenFootballChallenge[] }>('/football/open-challenges')).challenges);
    } catch (err) {
      if (!this.open()) this.openError.set(apiError(err).message);
    }
  }

  async loadMine() {
    if (!this.auth.isLoggedIn()) return;
    try {
      const [a, r] = await Promise.all([
        this.api.get<Paged<MatchSummary>>('/matches', { category: 'FOOTBALL', status: 'active', pageSize: 20 }),
        this.api.get<Paged<MatchSummary>>('/matches', { category: 'FOOTBALL', filter: 'ended', pageSize: 5 }),
      ]);
      this.active.set(a.items);
      this.recent.set(r.items);
    } catch { /* sections simply stay hidden */ }
  }
}
