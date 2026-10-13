import { Component, DestroyRef, computed, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { interval, Subject, debounceTime } from 'rxjs';
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

type DayTab = 'all' | 'live' | 'today' | 'tomorrow' | 'later';

/**
 * FOOTBALL home — built around what players actually do: join someone
 * who's already waiting, check on their own challenges, or start a new one
 * on a real upcoming fixture. Head2Head never runs the football match; the
 * fixture is just the event two players compete over.
 */
@Component({
  selector: 'app-football-list',
  imports: [RouterLink, FormsModule, DatePipe, MatIconModule, MoneyPipe, EmptyState, LoadError, Countdown, OpenChallengeCard, JoinSheet],
  template: `
    <div class="page">
      <div class="segmented tabs play-tabs">
        <a routerLink="/games"><mat-icon inline>sports_esports</mat-icon> Games</a>
        <button class="active" aria-pressed="true"><mat-icon inline>sports_soccer</mat-icon> Football</button>
      </div>

      <header class="hero">
        <div class="grow">
          <h1>Football fixtures &amp; results</h1>
          <p class="sub">Fixtures, scores and rivalries. Find your match.</p>
        </div>
        <button class="btn btn-ghost btn-lg" (click)="scrollToResults()"><mat-icon>history</mat-icon>Past results</button>
        <button class="btn btn-primary btn-lg create" (click)="scrollToFixtures()"><mat-icon>{{ auth.isLoggedIn() ? 'swords' : 'sports_soccer' }}</mat-icon> {{ auth.isLoggedIn() ? 'Create challenge' : 'Browse fixtures' }}</button>
      </header>

      <div class="football-search-row"><label class="fixture-search"><mat-icon aria-hidden="true">search</mat-icon><input type="search" [ngModel]="searchText" (ngModelChange)="onSearch($event)" maxlength="80" aria-label="Search available fixtures and results by team or competition" placeholder="Search teams or competitions…"/>@if(searchText){<button type="button" (click)="onSearch('')" aria-label="Clear fixture search">×</button>}</label><a class="research-entry" routerLink="/football/research">Football research <span aria-hidden="true">↗</span></a></div>

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
      <section id="fixtures" tabindex="-1" aria-labelledby="fixtures-title" [attr.aria-busy]="fixtures() === null && !error()">
        <div class="section-title">
          <div><h2 id="fixtures-title">Fixtures &amp; live scores</h2><p class="sub">{{searchQuery()?'Matches in available football data':'Choose a day. Open a match.'}}</p></div><button class="btn btn-ghost btn-sm" (click)="load()">Refresh</button>
        </div>
        <div class="football-filters">
          <label>Competition
            <input type="search" [ngModel]="competitionSearch()" (ngModelChange)="competitionSearch.set($event)" aria-label="Search competition filters" placeholder="Find a competition…"/>
            <select #competition [value]="competitionId()??''" (change)="selectCompetition(competition.value)">
              <option value="">All competitions</option>
              @for (c of filteredCompetitions(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }
            </select>
          </label>
          <label>From <input #fromInput type="date" [value]="dateFrom()" aria-label="Filter fixtures and results from this date" (change)="selectDates(fromInput.value, toInput.value)" /></label>
          <label>To <input #toInput type="date" [value]="dateTo()" aria-label="Filter fixtures and results through this date" (change)="selectDates(fromInput.value, toInput.value)" /></label>
        </div>
        @if (competitionError()) { <p class="muted small">{{ competitionError() }}</p> }
        @if(filterError()){<p class="form-error" role="alert">{{filterError()}}</p>}
        <div class="segmented tabs day-tabs">
          @for (t of dayTabs; track t.key) {
            <button [class.active]="day() === t.key" [attr.aria-pressed]="day() === t.key" (click)="selectDay(t.key)">
              @if (t.key === 'live') { <span class="live-dot live-red"></span> }
              {{ t.label }} @if (fixtures()) { <span class="count-muted">{{ byDay()[t.key].length }}</span> }
            </button>
          }
        </div>
        @if (error()) {
          <app-load-error [message]="error()" (retry)="load()" />
        } @else if (!fixtures()) {
          <div class="card-grid">@for (i of [1,2,3]; track i) { <div class="card sk"><div class="skeleton" style="height:90px"></div></div> }</div>
        } @else if (byDay()[day()].length === 0) {
          <app-empty icon="sports_soccer" [title]="emptyTitle()" text="Try All, another competition or a different search.">@if(hasFilters()){<button class="btn btn-ghost" (click)="clearFilters()">Clear filters</button>}</app-empty>
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
                  <span class="team" [title]="f.homeTeam.name">{{ f.homeTeam.name }}</span>
                  @if (f.status === 'LIVE') { <span class="score">{{ f.homeScore }} - {{ f.awayScore }}</span> } @else { <span class="vs">vs</span> }
                  <span class="team" [title]="f.awayTeam.name">{{ f.awayTeam.name }}</span>
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
        @if(fixturesMoreError()){<p class="form-error" role="status">{{fixturesMoreError()}}</p>}
        @if(fixtures()&&fixtures()!.length<fixturesTotal()) {<div class="results-more"><button class="btn btn-ghost" [disabled]="loadingMoreFixtures()" (click)="loadMoreFixtures()">{{loadingMoreFixtures()?'Loading fixtures…':'More fixtures'}} <span aria-hidden="true">↓</span></button></div>}
        @if (anySimulated()) { <p class="muted tiny sim-note">Simulated demo fixtures are shown because no live football data provider is configured.</p> }
        @if (fixtures() && lastUpdatedAt()) { <p class="muted tiny">Football data last updated {{ lastUpdatedAt() | date: 'EEE d MMM, HH:mm' }}. Live updates may be delayed.</p> }
      </section>

      <section id="past-results" tabindex="-1" aria-labelledby="results-title">
        <div class="section-title">
          <div>
            <h2 id="results-title">Past match results</h2>
            <p class="sub">Available scores. Search and filters apply here too.</p>
          </div>
          @if (resultsTotal() > 0) { <span class="muted small">{{ results()?.length ?? 0 }} of {{ resultsTotal() }} matches</span> }
        </div>
        @if (resultsError()) {
          <app-load-error [message]="resultsError()" (retry)="load()" />
        } @else if (!results()) {
          <div class="card-grid">@for (i of [1,2,3]; track i) { <div class="card sk"><div class="skeleton" style="height:90px"></div></div> }</div>
        } @else if (results()!.length === 0) {
          <app-empty icon="sports_soccer" [title]="hasFilters()?'No past results match these filters':'No past results available yet'" text="Try a different search or date range.">@if(hasFilters()){<button class="btn btn-ghost" (click)="clearFilters()">Clear filters</button>}</app-empty>
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
          @if(resultsMoreError()){<p class="form-error" role="status">{{resultsMoreError()}}</p>}
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
    .football-search-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-block:20px}.fixture-search{display:flex;align-items:center;gap:10px;flex:1;min-width:210px;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;padding:0 14px}.fixture-search:focus-within{outline:2px solid var(--accent);outline-offset:2px}.fixture-search>mat-icon{color:var(--muted);flex-shrink:0}.fixture-search input{width:100%;min-width:0;min-height:52px;border:0;background:transparent;color:var(--text);font:inherit;outline:none!important}.fixture-search button{width:44px;height:44px;color:var(--text-2);font-size:26px;flex-shrink:0}.research-entry{display:flex;align-items:center;gap:10px;min-height:48px;padding:0 14px;border:1px solid #8f875155;border-radius:9px;font-size:13px;color:#e3d19e;background:#d9c8910c}
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
    .day-tabs { margin-bottom: 12px; display: flex;flex-wrap:wrap;overflow:visible; }
    .day-tabs button{flex:1 0 55px;min-height:44px}
    .day-tabs button { padding: 8px 4px; min-width: 0; font-size: 13px; gap: 3px; }
    @media (min-width: 640px) { .day-tabs { display: inline-flex; } .day-tabs button { padding: 8px 14px; font-size: 14px; } }
    .count-muted { color: var(--muted); font-weight: 500; font-size: 12px; }
    .live-red { color: var(--loss); margin-right: 2px; }
    .fixture { display: flex; flex-direction: column; gap: 10px; padding: 16px; min-width: 0; text-decoration: none; color: inherit; }
    .fixture .teams-line .team {white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;line-height:1.25;}
    .fx-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .kick { font-weight: 600; flex-shrink: 0; }
    .fx-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
    .waiting { color: var(--demo); display: flex; align-items: center; gap: 4px; }
    .sim-note { margin-top: 10px; }
    .public-join { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 16px 0; padding: 16px;
      .grow { flex: 1; min-width: 0; } p { margin-top: 6px; } .btn { flex-shrink: 0; } }
    @media (max-width: 599px) { .public-join { flex-direction: column; align-items: stretch; } }
    section[id] { scroll-margin-top: calc(var(--header-h) + 16px); }
    .football-filters { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; margin: 16px 0;
      label { display: grid; min-width: 0; gap: 6px; color: var(--text-2); font-size: 14px; }
      select, input { width: 100%; min-width: 0; min-height: 48px; padding: 10px 12px; font-size: 16px; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); } }
    @media (min-width: 600px) { .football-filters { grid-template-columns: minmax(0, 2fr) repeat(2, minmax(0, 1fr)); } }
  `],
})
export class FootballListPage implements OnInit {
  /** ?opponent=<username> — arriving from a profile's "Challenge" button. */
  readonly opponent = input<string | undefined>();
  private api = inject(Api);
  private seo = inject(SeoService);
  protected auth = inject(AuthService);
  private router = inject(Router);
  private route=inject(ActivatedRoute);
  private realtime = inject(RealtimeService);
  private clock = inject(ServerClock);
  private destroyRef = inject(DestroyRef);
  protected rematch = inject(RematchService);

  protected fixtures = signal<FootballFixture[] | null>(null);
  protected fixturesTotal=signal(0);
  protected fixturesMoreError=signal('');protected resultsMoreError=signal('');
  protected loadingMoreFixtures=signal(false);
  private fixturesPage=1;
  protected followedFixturesServer = signal<FootballFixture[]>([]);
  protected guestFollowedIds = signal<number[]>(readGuestFollowedFixtures());
  protected followError = signal('');
  protected results = signal<FootballFixture[] | null>(null);
  protected resultsTotal = signal(0);
  protected loadingMoreResults = signal(false);
  protected resultsError = signal('');
  private resultsPage = 1;
  private resultsQueryVersion = 0;
  private loadingGeneration:number|null=null;
  protected competitions = signal<FootballCompetition[]>([]);
  protected lastUpdatedAt = signal<string | null>(null);
  protected competitionId = signal<number | null>(null);
  protected dateFrom = signal('');
  protected dateTo = signal('');
  protected searchQuery=signal('');protected searchText='';protected competitionSearch=signal('');protected filterError=signal('');
  protected filteredCompetitions=computed(()=>this.competitions().filter(c=>c.id===this.competitionId()||`${c.name} ${c.code} ${c.country??''}`.toLowerCase().includes(this.competitionSearch().trim().toLowerCase())));
  private searchChanges=new Subject<string>();private filterKey='';
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
    {key:'all',label:'All'},
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
    const out: Record<DayTab, FootballFixture[]> = { all:this.fixtures()??[],live: [], today: [], tomorrow: [], later: [] };
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
  protected hasFilters=computed(()=>!!(this.searchQuery()||this.competitionId()||this.dateFrom()||this.dateTo()));
  protected emptyTitle = computed(() => this.hasFilters()?'No fixtures match these filters':({ all:'No upcoming fixtures available yet',live: 'No matches are live right now', today: 'No more fixtures today', tomorrow: 'No fixtures tomorrow', later: 'No later fixtures yet' })[this.day()]);

  ngOnInit() {
    this.seo.publish('Football fixtures, live scores and results', 'Browse upcoming football fixtures, live scores and recent results. View match centres and find relevant Head2Head challenges.', '/football');
    const opp = this.opponent();
    if (opp) this.rematch.setPending({ username: opp.replace(/^@/, ''), avatarColor: '#64748B' });
    this.searchChanges.pipe(debounceTime(250),takeUntilDestroyed(this.destroyRef)).subscribe(()=>this.persistFilters());
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(query=>{
      const q=(query.get('q')??'').trim().slice(0,80);const c=Number(query.get('competitionId'));const from=query.get('dateFrom')??'',to=query.get('dateTo')??'';
      const key=JSON.stringify({q,competitionId:Number.isSafeInteger(c)&&c>0?c:null,from,to});
      this.searchText=q;this.searchQuery.set(q);this.competitionId.set(Number.isSafeInteger(c)&&c>0?c:null);this.dateFrom.set(from);this.dateTo.set(to);
      const day=query.get('day');if(this.dayTabs.some(t=>t.key===day)){this.day.set(day as DayTab);this.dayChosen=true;}
      if(key!==this.filterKey){this.filterKey=key;this.fixtures.set(null);this.results.set(null);void this.load();}
    });
    this.loadCompetitions();
    if (this.auth.isLoggedIn()) {
      this.loadOpen();
      this.loadMine();
      this.loadFollowed();
    }
    const refresh = () => { this.loadOpen(); this.loadMine(); };
    this.realtime.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => { this.load(true); refresh(); });
    this.realtime.match$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(refresh);
    this.realtime.queue$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.loadOpen());
    this.realtime.config$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load(true));
    // Other players' new challenges aren't pushed to everyone — poll gently.
    interval(10000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {if(!document.hidden)void this.loadOpen();});
    interval(60000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {if(!document.hidden){void this.load(true);void this.loadMine();}});
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
    this.focusSection('fixtures');
  }

  scrollToResults() {
    this.focusSection('past-results');
  }

  private focusSection(id: string) {
    const section = document.getElementById(id);
    section?.focus({ preventScroll: true });
    section?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
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

  async load(silent=false) {
    // Keep expanded lists stable. A deliberate Refresh resets pagination.
    if(silent&&(this.fixturesPage>4||this.resultsPage>8||this.loadingMoreFixtures()||this.loadingMoreResults()))return;
    const queryVersion = ++this.resultsQueryVersion;
    this.loadingGeneration=queryVersion;
    this.error.set('');
    this.resultsError.set('');
    if(!silent){this.resultsPage=1;this.fixturesPage=1;this.fixtures.set(null);this.results.set(null);this.resultsTotal.set(0);this.fixturesTotal.set(0);this.fixturesMoreError.set('');this.resultsMoreError.set('');}
    try {
      const filters = {q:this.searchQuery(),competitionId: this.competitionId(), dateFrom: this.dateFrom(), dateTo: this.dateTo()};
      const [upcomingResult, resultsResult] = await Promise.allSettled([
        this.api.get<{ fixtures: FootballFixture[]; total:number; lastUpdatedAt: string | null }>('/football/fixtures',{...filters,pageSize:this.fixturesPage*24}),
        this.api.get<{ fixtures: FootballFixture[]; total: number }>('/football/fixtures', { ...filters, status: 'completed', pageSize:this.resultsPage*12 }),
      ]);
      if (queryVersion !== this.resultsQueryVersion) return;
      if(upcomingResult.status==='fulfilled'){
        const upcoming=upcomingResult.value;this.fixtures.set(upcoming.fixtures);this.fixturesTotal.set(upcoming.total??upcoming.fixtures.length);this.lastUpdatedAt.set(upcoming.lastUpdatedAt);
        this.seo.publish('Football fixtures, live scores and results','Explore available football fixtures and results. Compare teams in Head2Head research.','/football',upcoming.fixtures.length>0&&!upcoming.fixtures.some(f=>f.isSimulated));
      }else{this.error.set(apiError(upcomingResult.reason).message);if(!this.fixtures())this.fixtures.set([]);}
      if(resultsResult.status==='fulfilled'){this.results.set(resultsResult.value.fixtures);this.resultsTotal.set(resultsResult.value.total);}
      else{this.resultsError.set(apiError(resultsResult.reason).message);if(!this.results())this.results.set([]);}
      this.guestFollowedIds.set(readGuestFollowedFixtures());
      if (this.auth.isLoggedIn()) void this.loadFollowed();
      if (!this.dayChosen) {
        // Open on the first day that actually has something to show.
        const b = this.byDay();
        this.day.set(this.searchQuery()?'all':(['live', 'today', 'tomorrow', 'later'] as DayTab[]).find((k) => b[k].length) ?? 'today');
        this.dayChosen = true;
      }

    } catch (err) {
      if (queryVersion === this.resultsQueryVersion) {
        const message = apiError(err).message;
        this.error.set(message);
        this.resultsError.set(message);
        this.results.set([]);
      }
    }finally{if(this.loadingGeneration===queryVersion)this.loadingGeneration=null;}
  }

  async loadMoreFixtures(){
    if(this.loadingMoreFixtures()||(this.fixtures()?.length??0)>=this.fixturesTotal())return;
    this.loadingMoreFixtures.set(true);this.fixturesMoreError.set('');const version=this.resultsQueryVersion;const next=this.fixturesPage+1;
    try{const response=await this.api.get<{fixtures:FootballFixture[];total:number}>('/football/fixtures',{q:this.searchQuery(),competitionId:this.competitionId(),dateFrom:this.dateFrom(),dateTo:this.dateTo(),page:next,pageSize:24});if(version!==this.resultsQueryVersion)return;this.fixtures.update(current=>[...new Map([...(current??[]),...response.fixtures].map(f=>[f.id,f])).values()]);this.fixturesPage=next;this.fixturesTotal.set(response.total);}
    catch(err){if(version===this.resultsQueryVersion)this.fixturesMoreError.set(apiError(err).message);}finally{this.loadingMoreFixtures.set(false);}
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
    this.resultsMoreError.set('');
    const queryVersion = this.resultsQueryVersion;
    const nextPage = this.resultsPage + 1;
    try {
      const response = await this.api.get<{ fixtures: FootballFixture[]; total: number }>('/football/fixtures', {
        competitionId: this.competitionId(),
        q:this.searchQuery(),
        dateFrom: this.dateFrom(),
        dateTo: this.dateTo(),
        status: 'completed',
        page: nextPage,
        pageSize: 12,
      });
      if (queryVersion !== this.resultsQueryVersion) return;
      this.results.update((current) => [...new Map([...(current??[]),...response.fixtures].map(f=>[f.id,f])).values()]);
      this.resultsPage = nextPage;
      this.resultsTotal.set(response.total);
    } catch (err) {
      if (queryVersion === this.resultsQueryVersion) this.resultsMoreError.set(apiError(err).message);
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
    this.persistFilters();
  }

  selectDates(from: string, to: string) {
    this.dateFrom.set(from);
    this.dateTo.set(to);
    const days=from&&to?(Date.parse(to)-Date.parse(from))/86400000:0;
    if((from&&to&&from>to)||days>90){this.filterError.set('Choose a date range of up to 90 days.');return;}
    this.filterError.set('');this.persistFilters();
  }

  onSearch(value:string){this.searchText=value;const q=value.trim().slice(0,80);if(q===this.searchQuery())return;this.searchQuery.set(q);++this.resultsQueryVersion;this.fixtures.set(null);this.results.set(null);this.error.set('');this.resultsError.set('');this.day.set(q?'all':'today');this.dayChosen=false;this.searchChanges.next(value);}
  selectDay(day:DayTab){this.day.set(day);this.dayChosen=true;this.persistFilters();}
  clearFilters(){this.searchText='';this.searchQuery.set('');this.competitionId.set(null);this.competitionSearch.set('');this.dateFrom.set('');this.dateTo.set('');this.filterError.set('');this.day.set('all');this.dayChosen=true;this.persistFilters();}
  private persistFilters(){const key=JSON.stringify({q:this.searchQuery(),competitionId:this.competitionId(),from:this.dateFrom(),to:this.dateTo()});if(key!==this.filterKey){++this.resultsQueryVersion;this.fixtures.set(null);this.results.set(null);}else if(this.fixtures()===null&&this.loadingGeneration!==this.resultsQueryVersion)void this.load();void this.router.navigate([],{relativeTo:this.route,queryParams:{q:this.searchQuery()||null,competitionId:this.competitionId(),dateFrom:this.dateFrom()||null,dateTo:this.dateTo()||null,day:this.day()},queryParamsHandling:'merge',replaceUrl:true});}

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
