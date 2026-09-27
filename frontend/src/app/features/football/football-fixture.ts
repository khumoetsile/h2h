import { Component, DestroyRef, computed, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { interval, Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { ConfigStore } from '../../core/config.store';
import { FootballChallengeType, FootballFixture, MatchView, OpenFootballChallenge, Pick as FootballPickValue, PlayerSearchResult } from '../../core/models';
import { RematchIntent, RematchService } from '../../core/rematch.service';
import { formatRemaining, ServerClock } from '../../core/server-clock';
import { Toast } from '../../core/toast.service';
import { Countdown } from '../../shared/countdown';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar, LoadError, Spinner } from '../../shared/ui';
import { JoinSheet, OpenChallengeCard } from './open-challenge';

/**
 * Fixture + challenge builder: question -> your pick -> stake -> who you
 * want to play (Challenge someone vs Find opponent) -> the lock-in review,
 * which states every commitment, including the abandonment fee, before
 * anything is sent. Nothing here decides a result; that always comes from
 * the backend once the real match finishes.
 */
@Component({
  selector: 'app-football-fixture',
  imports: [FormsModule, RouterLink, DatePipe, MatIconModule, MatProgressSpinnerModule, MoneyPipe, Avatar, LoadError, Spinner, Countdown, OpenChallengeCard, JoinSheet],
  templateUrl: './football-fixture.html',
  styleUrl: './football-fixture.scss',
})
export class FootballFixturePage implements OnInit {
  readonly fixtureId = input.required<string>();
  private api = inject(Api);
  private auth = inject(AuthService);
  private router = inject(Router);
  private toast = inject(Toast);
  private clock = inject(ServerClock);
  protected config = inject(ConfigStore);
  private destroyRef = inject(DestroyRef);
  private rematchSvc = inject(RematchService);

  protected fixture = signal<FootballFixture | null>(null);
  protected openChallenges = signal<OpenFootballChallenge[]>([]);
  protected error = signal('');
  protected target = signal<RematchIntent | null>(null);

  protected type = signal<FootballChallengeType | null>(null);
  protected pick = signal<FootballPickValue | null>(null);
  protected stake = signal<number | null>(null);
  protected mode = signal<'find' | 'direct' | null>(null);

  protected opponent = signal<PlayerSearchResult | null>(null);
  protected query = '';
  protected results = signal<PlayerSearchResult[]>([]);
  protected searching = signal(false);
  private search$ = new Subject<string>();

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
    this.search$.pipe(debounceTime(250), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef)).subscribe((q) => this.doSearch(q));
    const t = this.rematchSvc.consume();
    if (t) {
      this.target.set(t);
      this.opponent.set({ id: 0, username: t.username, displayName: t.username, avatarColor: t.avatarColor, isBot: false, online: false });
      this.query = `@${t.username}`;
      this.mode.set('direct');
    }
    this.load();
    interval(15000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load(true));
  }

  async load(silent = false) {
    if (!silent) this.error.set('');
    try {
      const res = await this.api.get<{ fixture: FootballFixture; openChallenges: OpenFootballChallenge[] }>(`/football/fixtures/${this.fixtureId()}`);
      const first = !this.fixture();
      this.fixture.set(res.fixture);
      this.openChallenges.set(res.openChallenges ?? []);
      if (first) this.applyDefaults(res.fixture);
      if (!silent) this.auth.refreshMe().catch(() => {});
    } catch (err) {
      if (!silent) this.error.set(apiError(err).message);
    }
  }

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
    this.search$.next(q.trim());
  }

  private async doSearch(q: string) {
    if (!q) { this.results.set([]); return; }
    this.searching.set(true);
    try {
      this.results.set((await this.api.get<{ users: PlayerSearchResult[] }>('/users/search', { q })).users);
    } catch { this.results.set([]); }
    this.searching.set(false);
  }

  pickOpponent(u: PlayerSearchResult) {
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
        if (r.matched) this.toast.success('Opponent found — you are both locked in!');
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
