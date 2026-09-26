import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { merge, interval } from 'rxjs';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { Challenge, Game, MatchSummary, UserStats, Wallet } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { Toast } from '../../core/toast.service';
import { durationLabel } from '../../core/format';
import { AgoPipe, MoneyPipe } from '../../shared/pipes';
import { Avatar, DemoBadge, EmptyState, GameIcon, LoadError, MatchStatusChip, OutcomeChip, SkeletonList } from '../../shared/ui';

interface Dashboard {
  wallet: Wallet;
  stats: UserStats;
  leaderboard: { rank: number | null; of: number };
  activeMatches: MatchSummary[];
  recentMatches: MatchSummary[];
  activeChallenges: Challenge[];
  games: Game[];
}

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, MatIconModule, MatTooltipModule, MoneyPipe, AgoPipe, Avatar, DemoBadge, EmptyState, GameIcon, LoadError, MatchStatusChip, OutcomeChip, SkeletonList],
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
  protected duration = durationLabel;

  ngOnInit() {
    this.load();
    merge(this.realtime.match$, this.realtime.challenge$, this.realtime.queue$, interval(30000))
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
      if (!silent || !this.data()) this.error.set('Could not load your dashboard.');
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
        this.toast.success('Challenge accepted — stakes locked. Get ready!');
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
}
