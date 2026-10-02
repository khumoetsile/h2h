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
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { apiError } from '../../core/api-error';
import { MAIN_GAME, QuickPlay } from '../../core/quick-play';
import { AdSlot } from '../../shared/ad-slot';
import { GetApp } from '../../shared/get-app';
import { PitchArt } from '../../shared/pitch-art';
import { SaveAccount } from '../../shared/save-account';
import { AgoPipe, MoneyPipe } from '../../shared/pipes';
import { Avatar, EmptyState, GameIcon, LoadError, OutcomeChip } from '../../shared/ui';

interface Dashboard {
  wallet: Wallet;
  stats: UserStats;
  leaderboard: { rank: number | null; of: number };
  activeMatches: MatchSummary[];
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
  imports: [RouterLink, MatIconModule, MatProgressSpinnerModule, AdSlot, GetApp, PitchArt, SaveAccount, MoneyPipe, AgoPipe, Avatar, EmptyState, GameIcon, LoadError, OutcomeChip],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class DashboardPage implements OnInit {
  private api = inject(Api);
  protected auth = inject(AuthService);
  private realtime = inject(RealtimeService);
  private toast = inject(Toast);
  protected router = inject(Router);
  private destroyRef = inject(DestroyRef);

  private quick = inject(QuickPlay);

  protected data = signal<Dashboard | null>(null);
  protected main = computed(() => this.data()?.games.find((g) => g.slug === MAIN_GAME) ?? null);
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
    const now = Date.now();
    return (this.fixtures() ?? [])
      .filter((f) => f.status === 'LIVE' || (f.status === 'SCHEDULED' && new Date(f.kickoffAt).getTime() > now))
      .sort((a, b) => (a.status === 'LIVE' ? 0 : 1) - (b.status === 'LIVE' ? 0 : 1) || new Date(a.kickoffAt).getTime() - new Date(b.kickoffAt).getTime())
      .slice(0, 6);
  });
  protected anySimulated = computed(() => this.upcoming().some((f) => f.isSimulated));

  protected incomingChallenges() {
    return (this.data()?.activeChallenges ?? []).filter((c) => c.direction === 'INCOMING');
  }

  ngOnInit() {
    this.load();
    merge(this.realtime.match$, this.realtime.challenge$, this.realtime.reconnected$, interval(30000))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.load(true));
  }

  async load(silent = false) {
    if (!silent) this.error.set('');
    try {
      const d = await this.api.get<Dashboard>('/dashboard');
      this.api.get<{ challenges: unknown[] }>('/football/open-challenges').then((r) => this.openCount.set(r.challenges.length)).catch(() => {});
      this.api.get<{ fixtures: FootballFixture[] }>('/football/fixtures')
        .then((r) => { this.fixtures.set(r.fixtures); this.fixturesError.set(false); })
        .catch(() => { if (!this.fixtures()) this.fixturesError.set(true); });
      this.data.set(d);
      this.auth.wallet.set(d.wallet);
    } catch (err) {
      if (!silent || !this.data()) this.error.set("We couldn't load your home screen. Please try again.");
      void err;
    }
  }

  protected async playNow() { await this.hero('play', () => this.quick.playNow()); }
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
