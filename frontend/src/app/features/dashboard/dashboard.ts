import { ServerClock } from '../../core/server-clock';
import { Favourites } from '../../core/favourites';
import { ExperienceMeasurement } from '../../core/experience-measurement';
import { DailyExperience } from '../../core/daily-experience';
import { ExperiencePreferences } from '../../core/experience-preferences';
import { dashboardNextAction } from '../../core/next-action';
import { Arena } from '../../core/fantasy-arena';
import { DailyOverview } from '../../core/daily-predictions';
import { ExperienceSetup } from '../../shared/experience-setup';
import { ChallengeEntry } from '../../shared/challenge-entry';
import { PersonalizedFeed } from '../../shared/personalized-feed';
import { DailyPreview } from '../daily-predictions/daily-preview';
import { Component, DestroyRef, computed, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { merge, interval } from 'rxjs';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { Challenge, FootballFixture, Game, MatchSummary, UserStats, Wallet } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { Toast } from '../../core/toast.service';
import { apiError } from '../../core/api-error';
import { isLiveGame } from '../../core/featured';
import { MAIN_GAME, QuickPlay } from '../../core/quick-play';
import { ChessDiscovery } from '../../shared/chess-discovery';
import { SaveAccount } from '../../shared/save-account';
import { AgoPipe, MoneyPipe } from '../../shared/pipes';
import { EmptyState, GameIcon, LoadError, OutcomeChip } from '../../shared/ui';

interface Dashboard {
  wallet: Wallet;
  stats: UserStats;
  leaderboard: { rank: number | null; of: number };
  activeMatches: MatchSummary[];
  activeMatchCount?: number;
  recentMatches: MatchSummary[];
  activeChallenges: Challenge[];
  games: Game[];
}

/**
 * Home screen. Shows what a player needs right now: anything mid-game or
 * waiting for a response, the next football fixtures (the main way to play),
 * a few skill games and recent results. Deep stats live on the Profile page.
 */
@Component({
  selector: 'app-dashboard',
  imports: [ExperienceSetup, ChallengeEntry, PersonalizedFeed, DailyPreview, RouterLink, ChessDiscovery, SaveAccount, MoneyPipe, AgoPipe, EmptyState, GameIcon, LoadError, OutcomeChip],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class DashboardPage implements OnInit {
  private api = inject(Api);
  protected measurement = inject(ExperienceMeasurement);
  protected auth = inject(AuthService);
  private realtime = inject(RealtimeService);
  private toast = inject(Toast);
  protected router = inject(Router);
  private destroyRef = inject(DestroyRef);

  private quick = inject(QuickPlay);
  private clock = inject(ServerClock);
  private favourites = inject(Favourites);
  private dailyExperience = inject(DailyExperience);
  protected preferences = inject(ExperiencePreferences);
  protected footballFirst = computed(() => { const interests = this.preferences.settings()?.interests ?? []; return interests.includes('football') && !interests.includes('games'); });
  protected daily = signal<DailyOverview | null>(null);
  protected dailyError = signal(false);
  protected arenas = signal<Arena[] | null>(null);
  protected arenaError = signal(false);
  protected myArenas = signal<Arena[]>([]);
  protected myArenaError = signal(false);
  protected nextAction = computed(() => dashboardNextAction(this.data()?.activeMatches ?? [], this.incomingChallenges(), this.daily(), this.myArenas(), this.clock.now()));
  private loading = false;
  private alive = true;
  constructor() { this.destroyRef.onDestroy(() => this.alive = false); }


  protected data = signal<Dashboard | null>(null);
  protected main = computed(() => this.data()?.games.find((g) => g.slug === MAIN_GAME) ?? null);
  protected others = computed(() => (this.data()?.games ?? []).filter((g) => g.slug !== MAIN_GAME && isLiveGame(g.slug)));
  protected playingSlug = signal<string | null>(null);
  protected heroBusy = signal<'play' | 'invite' | null>(null);
  protected heroError = signal('');
  protected error = signal('');
  protected busy = signal<number | null>(null);
  /** Players currently waiting for a football opponent. */
  protected openCount = signal(0);
  protected fixtures = signal<FootballFixture[] | null>(null);
  protected fixturesError = signal(false);

  /** Live matches first, then the soonest kickoffs that can still be challenged. */
  protected upcoming = computed(() => {
    const now = this.clock.now();
    return (this.fixtures() ?? [])
      .filter(f => !this.favourites.has('team',f.homeTeam.id) && !this.favourites.has('team',f.awayTeam.id) && !this.favourites.has('competition',f.competition.id))
      .filter((f) => f.status === 'LIVE' || (f.status === 'SCHEDULED' && new Date(f.kickoffAt).getTime() > now))
      .sort((a, b) => (a.status === 'LIVE' ? 0 : 1) - (b.status === 'LIVE' ? 0 : 1) || new Date(a.kickoffAt).getTime() - new Date(b.kickoffAt).getTime())
      .slice(0, 6);
  });
  protected anySimulated = computed(() => this.upcoming().some((f) => f.isSimulated));

  protected incomingChallenges() {
    return (this.data()?.activeChallenges ?? []).filter((c) => c.direction === 'INCOMING' && c.status === 'PENDING' && Date.parse(c.expiresAt) > this.clock.now());
  }

  ngOnInit() {
    this.load();
    merge(this.realtime.match$, this.realtime.challenge$, this.realtime.reconnected$, interval(30000))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.load(true));
  }

  async load(silent = false) {
    if (this.loading || !this.alive || (silent && document.hidden)) return;
    this.loading = true;
    const update = (fn: () => void) => { if (this.alive) fn(); };
    await Promise.allSettled([
      this.api.get<Dashboard>('/dashboard').then(d => update(() => { this.data.set(d); this.auth.wallet.set(d.wallet); this.error.set(''); }))
        .catch(() => update(() => this.error.set("We couldn't refresh your activity. Please try again."))),
      this.api.get<{fixtures:FootballFixture[]}>('/football/fixtures').then(r => update(() => { this.fixtures.set(r.fixtures); this.fixturesError.set(false); }))
        .catch(() => update(() => this.fixturesError.set(true))),
      this.dailyExperience.load().then(d => update(() => { this.daily.set(d); this.dailyError.set(false); }))
        .catch(() => update(() => this.dailyError.set(true))),
      this.api.get<{arenas:Arena[]}>('/arenas', {section:'open', pageSize:3}).then(r => update(() => { this.arenas.set(r.arenas); this.arenaError.set(false); }))
        .catch(() => update(() => this.arenaError.set(true))),
      this.api.get<{arenas:Arena[]}>('/arenas', {section:'mine', pageSize:4}).then(r => update(() => { this.myArenas.set(r.arenas); this.myArenaError.set(false); }))
        .catch(() => update(() => this.myArenaError.set(true))),
    ]);
    this.loading = false;
  }

  protected async playNow() { await this.hero('play', () => this.quick.playNow()); }
  /** One tap on a game card: straight into a match of that game. */
  protected async playGame(slug: string) {
    this.playingSlug.set(slug);
    this.heroError.set('');
    try { await this.quick.playNow(slug); } catch (err) { this.heroError.set(apiError(err).message); this.playingSlug.set(null); }
  }
  protected async inviteFriend() { await this.hero('invite', () => this.quick.inviteFriend()); }

  private async hero(kind: 'play' | 'invite', run: () => Promise<void>) {
    this.heroBusy.set(kind);
    this.heroError.set('');
    try { await run(); } catch (err) {
      this.heroError.set(apiError(err).message);
      this.heroBusy.set(null);
    }
  }

  /** "Today 18:30", "Tomorrow 15:00" or "Sat 20:00", in the player's local time. */
  kickoff(f: FootballFixture) {
    const d = new Date(f.kickoffAt);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    const days = Math.floor((d.getTime() - startToday.getTime()) / 86400000);
    if (days <= 0) return `Today ${time}`;
    if (days === 1) return `Tomorrow ${time}`;
    return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }

  greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }

  async respond(c: Challenge, action: 'accept' | 'decline') {
    this.busy.set(c.id);
    try {
      if (action === 'accept') {
        const r = await this.api.post<{ match: { code: string } }>(`/challenges/${c.id}/accept`);
        this.toast.success("Challenge accepted! Get ready to play.");
        await this.router.navigate(['/match', r.match.code]);
      } else {
        await this.api.post(`/challenges/${c.id}/decline`);
        this.toast.info('Challenge declined.');
        await this.load(true);
      }
    } catch (err) {
      this.toast.error(err);
      await this.load(true);
    } finally {
      this.busy.set(null);
    }
  }

  matchLink(m: MatchSummary) {
    return ['COMPLETED', 'CANCELLED'].includes(m.status) ? ['/matches', m.code] : ['/match', m.code];
  }

  resultLabel(m: MatchSummary) {
    if (m.status === 'CANCELLED') return 'Cancelled';
    if (m.outcome === 'WIN') return 'You won';
    if (m.outcome === 'LOSS') return 'You lost';
    if (m.outcome === 'DRAW') return 'Draw';
    return 'In progress';
  }
}
