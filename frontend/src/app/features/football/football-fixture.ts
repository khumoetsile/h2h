import { Component, DestroyRef, computed, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { A11yModule } from '@angular/cdk/a11y';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { interval, Subject, debounceTime } from 'rxjs';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { SeoService } from '../../core/seo.service';
import { ConfigStore } from '../../core/config.store';
import { FootballChallengeType, FootballFixture, FootballReaction, FootballFixtureReactions, MatchView, OpenFootballChallenge, Pick as FootballPickValue, PlayerSearchResult } from '../../core/models';
import { RematchIntent, RematchService } from '../../core/rematch.service';
import { formatRemaining, ServerClock } from '../../core/server-clock';
import { Toast } from '../../core/toast.service';
import { Countdown } from '../../shared/countdown';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar, LoadError, Spinner } from '../../shared/ui';
import { JoinSheet, OpenChallengeCard } from './open-challenge';
import { readGuestFollowedFixtures, writeGuestFollowedFixtures } from './football-follow-storage';

/**
 * Fixture + challenge builder: question -> your pick -> stake -> who you
 * want to play (Challenge someone vs Find opponent) -> the lock-in review,
 * which states every commitment, including the abandonment fee, before
 * anything is sent. Nothing here decides a result; that always comes from
 * the backend once the real match finishes.
 */
@Component({
  selector: 'app-football-fixture',
  imports: [A11yModule, FormsModule, RouterLink, DatePipe, MatIconModule, MatProgressSpinnerModule, MoneyPipe, Avatar, LoadError, Spinner, Countdown, OpenChallengeCard, JoinSheet],
  templateUrl: './football-fixture.html',
  styleUrls: ['./football-fixture.scss', './football-fixture-insights.scss'],
})
export class FootballFixturePage implements OnInit {
  readonly fixtureId = input.required<string>();
  private api = inject(Api);
  private seo = inject(SeoService);
  protected auth = inject(AuthService);
  private router = inject(Router);
  private toast = inject(Toast);
  private clock = inject(ServerClock);
  protected config = inject(ConfigStore);
  private destroyRef = inject(DestroyRef);
  private rematchSvc = inject(RematchService);
  private loading = false;

  protected fixture = signal<FootballFixture | null>(null);
  protected openChallenges = signal<OpenFootballChallenge[]>([]);
  protected error = signal('');
  protected refreshError = signal('');
  protected activeEventId = signal<number | null>(null);
  protected reactionBusy = signal(false);
  protected followed = signal(false);
  protected followBusy = signal(false);
  protected target = signal<RematchIntent | null>(null);
  protected type = signal<FootballChallengeType | null>(null);
  protected pick = signal<FootballPickValue | null>(null);
  protected stake = signal<number | null>(null);
  protected mode = signal<'find' | 'direct' | null>(null);

  protected opponent = signal<PlayerSearchResult | null>(null);
  protected query = '';
  protected results = signal<PlayerSearchResult[]>([]);
  protected searching = signal(false);
  protected searchError=signal('');
  private searchVersion=0;
  private search$ = new Subject<{query:string;version:number}>();

  protected message = '';
  protected busy = signal(false);
  protected formError = signal('');
  protected reviewOpen = signal(false);
  protected joinTarget = signal<OpenFootballChallenge | null>(null);

  protected available = computed(() => this.auth.wallet()?.available ?? 0);
  /** Closed at kickoff — judged against the server clock, and re-checked by the server on submit. */
  protected closed = computed(() => {
    const f = this.fixture();
    return !!f && (f.status !== 'SCHEDULED' || this.clock.remainingMs(f.kickoffAt) === 0);
  });
  protected visibleOpen = computed(() => this.openChallenges().filter((c) => this.clock.remainingMs(c.acceptanceDeadline) > 0));
  protected recentForm = computed(() => {
    const fixture = this.fixture();
    const headToHead = fixture?.headToHead;
    if (!fixture || !headToHead) return [];
    return [
      { team: fixture.homeTeam, form: headToHead.recentForm.home },
      { team: fixture.awayTeam, form: headToHead.recentForm.away },
    ];
  });
  protected pulseRows = computed(() => {
    const stats = this.fixture()?.stats;
    if (!stats) return [];
    const values = [
      { label: 'Possession', home: stats.possession.home, away: stats.possession.away, suffix: '%', proportional: true },
      { label: 'Shots on target', home: stats.shotsOnTarget.home, away: stats.shotsOnTarget.away, suffix: '', proportional: false },
      { label: 'Shots', home: stats.shots.home, away: stats.shots.away, suffix: '', proportional: false },
      { label: 'Corners', home: stats.corners.home, away: stats.corners.away, suffix: '', proportional: false },
      { label: 'Cards', home: stats.cards.home, away: stats.cards.away, suffix: '', proportional: false },
    ];
    return values.filter((row) => row.home !== null && row.away !== null).map((row) => {
      const home = row.home!;
      const away = row.away!;
      const total = row.proportional ? home + away : Math.max(home, away);
      return {
        ...row,
        homeWidth: total ? Math.round(home / total * 100) : 50,
        awayWidth: total ? Math.round(away / total * 100) : 50,
      };
    });
  });
  protected pulseInsight = computed(() => {
    const fixture = this.fixture();
    const rows = this.pulseRows();
    if (!fixture) return '';
    const target = rows.find((row) => row.label === 'Shots on target');
    if (target && target.home !== null && target.away !== null && target.home !== target.away) {
      return `${target.home > target.away ? fixture.homeTeam.name : fixture.awayTeam.name} have more shots on target`;
    }
    const possession = rows.find((row) => row.label === 'Possession');
    if (possession && possession.home !== null && possession.away !== null && possession.home !== possession.away) {
      return `${possession.home > possession.away ? fixture.homeTeam.name : fixture.awayTeam.name} have more possession`;
    }
    return rows.length ? 'Available match statistics are level' : '';
  });
  protected readonly reactionOptions: Array<{ code: FootballReaction; emoji: string; label: string }> = [
    { code: 'FIRE', emoji: '🔥', label: 'Fire' },
    { code: 'SHOCK', emoji: '😱', label: 'Surprised' },
    { code: 'GOAL', emoji: '⚽', label: 'Goal' },
  ];

  protected pickLabel = computed(() => {
    const t = this.type();
    const f = this.fixture();
    const p = this.pick();
    if (!t || !f || !p) return '';
    if (t.pickType === 'TEAM') return p === 'HOME' ? f.homeTeam.name : f.awayTeam.name;
    return p === 'YES' ? 'Yes' : 'No';
  });

  protected potentialPrize = computed(() => {
    const s = this.stake();
    if (!s) return null;
    return this.config.config()?.stakeBreakdown.find((b) => b.stake === s)?.prize ?? null;
  });

  /** The acceptance window the server will apply — never later than kickoff. */
  protected acceptWindow = computed(() => {
    const secs = this.config.timers()?.challengeAcceptanceSeconds ?? 300;
    const f = this.fixture();
    const untilKickoff = f ? this.clock.remainingMs(f.kickoffAt) : Infinity;
    return formatRemaining(Math.min(secs * 1000, untilKickoff));
  });

  get readyToConfirm() {
    if (!this.type() || !this.pick() || !this.stake()) return false;
    if (this.mode() === 'direct') return !!this.opponent();
    return this.mode() === 'find';
  }

  ngOnInit() {
    this.search$.pipe(debounceTime(250), takeUntilDestroyed(this.destroyRef)).subscribe(q => this.doSearch(q.query,q.version));
    const t = this.rematchSvc.consume();
    if (t) {
      this.target.set(t);
      this.opponent.set({ id: 0, username: t.username, displayName: t.username, avatarColor: t.avatarColor, isBot: false, online: false });
      this.query = `@${t.username}`;
      this.mode.set('direct');
    }
    this.load();
    interval(15000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((tick) => {
      if (this.fixture()?.status === 'LIVE' || tick % 4 === 3) void this.load(true);
    });
  }

  async load(silent = false) {
    if (this.loading) return;
    this.loading = true;
    if (!silent) this.error.set('');
    try {
      const res = await this.api.get<{ fixture: FootballFixture; openChallenges: OpenFootballChallenge[] }>(`/football/fixtures/${this.fixtureId()}`);
      const first = !this.fixture();
      const previousEvents = new Set(this.fixture()?.events?.map((event) => event.id) ?? []);
      const newEvents = res.fixture.events?.filter((event) => !previousEvents.has(event.id)) ?? [];
      const latestNewEvent = newEvents[newEvents.length - 1];
      this.followed.set(this.auth.isLoggedIn()
        ? !!res.fixture.followed
        : readGuestFollowedFixtures().includes(res.fixture.id));
      this.fixture.set(res.fixture);
      if (latestNewEvent) this.activeEventId.set(latestNewEvent.id);
      else if (first && res.fixture.events?.length) this.activeEventId.set(res.fixture.events[res.fixture.events.length - 1].id);
      this.error.set('');
      this.refreshError.set('');
      const result = res.fixture.homeScore !== null && res.fixture.awayScore !== null
        ? `${res.fixture.homeScore}-${res.fixture.awayScore}`
        : (res.fixture.status === 'SCHEDULED' ? 'Upcoming fixture' : res.fixture.status.toLowerCase());
      this.seo.publish(
        `${res.fixture.homeTeam.name} vs ${res.fixture.awayTeam.name}: ${result}`,
        `${res.fixture.competition.name}: ${res.fixture.homeTeam.name} vs ${res.fixture.awayTeam.name}. Check the match status, score and available match details.`,
        `/football/${res.fixture.id}`,
        !res.fixture.isSimulated,
      );
      this.openChallenges.set(res.openChallenges ?? []);
      if (first) this.applyDefaults(res.fixture);
      if (!silent && this.auth.isLoggedIn()) this.auth.refreshMe().catch(() => {});
    } catch (err) {
      if (!silent) this.error.set(apiError(err).message);
      else this.refreshError.set('Could not refresh match data. Retrying automatically.');
    } finally {
      this.loading = false;
    }
  }

  async react(reaction: FootballReaction) {
    const fixture = this.fixture();
    if (!fixture || this.reactionBusy()) return;
    const selected = fixture.reactions?.mine === reaction ? null : reaction;
    this.reactionBusy.set(true);
    try {
      const result = await this.api.put<{ reactions: FootballFixtureReactions }>(`/football/fixtures/${fixture.id}/reaction`, { reaction: selected });
      this.fixture.update((current) => current?.id === fixture.id ? { ...current, reactions: result.reactions } : current);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.reactionBusy.set(false);
    }
  }

  async toggleFollow(): Promise<void> {
    const fixture = this.fixture();
    if (!fixture || this.followBusy()) return;
    this.followBusy.set(true);
    try {
      const following = !this.followed();
      if (this.auth.isLoggedIn()) {
        await (following
          ? this.api.put(`/football/fixtures/${fixture.id}/follow`, {})
          : this.api.delete(`/football/fixtures/${fixture.id}/follow`));
      } else {
        const ids = readGuestFollowedFixtures().filter((id) => id !== fixture.id);
        if (following) ids.unshift(fixture.id);
        if (!writeGuestFollowedFixtures(ids)) {
          this.toast.error('Your browser could not save followed matches. Check your local storage settings and try again.');
          return;
        }
      }
      this.followed.set(following);
      this.fixture.update((current) => current?.id === fixture.id ? { ...current, followed: following } : current);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.followBusy.set(false);
    }
  }

  protected latestBallCoordinate = computed(() => {
    const points = this.fixture()?.ballCoordinates ?? [];
    return points.length ? points[points.length - 1] : null;
  });

  /** Default stake, plus the question/stake carried over from a rematch. */
  private applyDefaults(f: FootballFixture) {
    const t = this.target();
    const stakes = f.stakes ?? [];
    const wanted = t?.stake && stakes.includes(t.stake) && t.stake <= this.available() ? t.stake : null;
    this.stake.set(wanted ?? stakes.find((s) => s === 20 && s <= this.available()) ?? [...stakes].reverse().find((s) => s <= this.available()) ?? stakes[0] ?? null);
    const sameType = t?.challengeTypeSlug ? f.challengeTypes?.find((ct) => ct.slug === t.challengeTypeSlug) : null;
    if (sameType) this.type.set(sameType);
  }

  chooseType(t: FootballChallengeType) {
    this.type.set(t);
    this.pick.set(null);
    this.formError.set('');
    // On mobile the builder sits below the question list — bring it into view.
    setTimeout(() => document.getElementById('builder')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  choosePick(p: FootballPickValue) { this.pick.set(p); }

  chooseMode(m: 'find' | 'direct') {
    this.mode.set(m);
    this.formError.set('');
  }

  onQuery(q: string) {
    if (this.opponent() && q === `@${this.opponent()!.username}`) return;
    this.opponent.set(null);
    this.results.set([]);this.searchError.set('');this.searching.set(!!q.trim());
    this.search$.next({query:q.trim(),version:++this.searchVersion});
  }

  retrySearch() {return this.doSearch(this.query.trim(),++this.searchVersion);}
  private async doSearch(q: string,version:number) {
    if(version !== this.searchVersion) return;
    if (!q) { this.results.set([]);this.searching.set(false); return; }
    this.searchError.set('');
    this.searching.set(true);
    try {
      const r=await this.api.get<{users:PlayerSearchResult[]}>('/users/search',{q});
      if(version === this.searchVersion) this.results.set(r.users);
    } catch(e) {if(version === this.searchVersion) {this.results.set([]);this.searchError.set(apiError(e).message);}}
    finally {if(version === this.searchVersion) this.searching.set(false);}
  }

  pickOpponent(u: PlayerSearchResult) {
    ++this.searchVersion;this.searching.set(false);
    this.opponent.set(u);
    this.query = `@${u.username}`;
    this.results.set([]);
  }

  closeReview() { if (!this.busy()) this.reviewOpen.set(false); }

  onJoinClosed(e: { refresh: boolean }) {
    this.joinTarget.set(null);
    if (e.refresh) this.load(true);
  }

  async confirm() {
    const f = this.fixture();
    const t = this.type();
    const p = this.pick();
    const s = this.stake();
    if (!f || !t || !p || !s) return;
    this.busy.set(true);
    this.formError.set('');
    try {
      if (this.mode() === 'find') {
        const r = await this.api.post<{ matched: boolean; alreadyQueued: boolean; match: MatchView }>('/football/find', {
          fixtureId: f.id, challengeTypeSlug: t.slug, pick: p, stake: s,
        });
        if (r.matched) this.toast.success('Opponent found, you are both locked in!');
        else if (r.alreadyQueued) this.toast.info("You're already waiting for an opponent on this pick.");
        else this.toast.success('Locked in. Your challenge is now in Open Challenges.');
        this.reviewOpen.set(false);
        await this.router.navigate(['/match', r.match.code]);
      } else {
        const opp = this.opponent();
        if (!opp) return;
        const { challenge } = await this.api.post<{ challenge: { opponent: { username: string } } }>('/football/challenges', {
          opponent: opp.username, fixtureId: f.id, challengeTypeSlug: t.slug, pick: p, stake: s, message: this.message || null,
        });
        this.toast.success(`Challenge sent to ${challenge.opponent.username}!`);
        this.reviewOpen.set(false);
        await this.router.navigate(['/challenges'], { queryParams: { tab: 'outgoing' } });
      }
    } catch (err) {
      this.formError.set(apiError(err).message);
    } finally {
      this.busy.set(false);
    }
  }
}
