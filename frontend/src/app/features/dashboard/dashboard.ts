import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { merge, interval } from 'rxjs';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { Challenge, Game, MatchSummary, UserStats, Wallet } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { Toast } from '../../core/toast.service';
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
 * Home screen. Deliberately shows only what an ordinary player needs right
 * now — balance, one big "Play now" action, anything waiting for a response,
 * and a taste of games/recent activity. Deep stats live on the Profile page,
 * not here — this screen is not a dashboard.
 */
@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, MatIconModule, MoneyPipe, AgoPipe, Avatar, EmptyState, GameIcon, LoadError, OutcomeChip],
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

  protected data = signal<Dashboard | null>(null);
  protected error = signal('');
  protected busy = signal<number | null>(null);

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
      this.data.set(d);
      this.auth.wallet.set(d.wallet);
    } catch (err) {
      if (!silent || !this.data()) this.error.set("We couldn't load your home screen. Please try again.");
      void err;
    }
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
