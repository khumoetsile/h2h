import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { Challenge } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { Toast } from '../../core/toast.service';
import { AgoPipe, MoneyPipe } from '../../shared/pipes';
import { Avatar, EmptyState, GameIcon, LoadError, SkeletonList } from '../../shared/ui';

type Tab = 'incoming' | 'outgoing' | 'history';

/**
 * Challenges inbox. This screen has one job: show what's waiting for a
 * response and let a player start a new challenge — the actual "build a
 * challenge" flow lives in the step-by-step /challenges/new wizard.
 */
@Component({
  selector: 'app-challenges',
  imports: [RouterLink, MatIconModule, MoneyPipe, AgoPipe, Avatar, EmptyState, GameIcon, LoadError, SkeletonList],
  templateUrl: './challenges.html',
  styleUrl: './challenges.scss',
})
export class ChallengesPage implements OnInit {
  private api = inject(Api);
  private toast = inject(Toast);
  private router = inject(Router);
  private realtime = inject(RealtimeService);
  private destroyRef = inject(DestroyRef);

  protected challenges = signal<Challenge[] | null>(null);
  protected error = signal('');
  protected tab = signal<Tab>('incoming');
  protected busy = signal<number | null>(null);

  protected incoming = computed(() => (this.challenges() ?? []).filter((c) => c.direction === 'INCOMING' && c.status === 'PENDING'));
  protected outgoing = computed(() => (this.challenges() ?? []).filter((c) => c.direction === 'OUTGOING' && c.status === 'PENDING'));
  protected history = computed(() => (this.challenges() ?? []).filter((c) => c.status !== 'PENDING'));
  protected visible = computed(() => ({ incoming: this.incoming(), outgoing: this.outgoing(), history: this.history() })[this.tab()]);

  ngOnInit() {
    this.load();
    this.realtime.challenge$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load(true));
    this.realtime.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load(true));
  }

  async load(silent = false) {
    if (!silent) this.error.set('');
    try {
      const { challenges } = await this.api.get<{ challenges: Challenge[] }>('/challenges', { status: 'all' });
      this.challenges.set(challenges);
      if (!silent && this.incoming().length === 0 && this.outgoing().length > 0) this.tab.set('outgoing');
    } catch {
      if (!silent) this.error.set("We couldn't load your challenges.");
    }
  }

  async accept(c: Challenge) {
    this.busy.set(c.id);
    try {
      const { match } = await this.api.post<{ match: { code: string } }>(`/challenges/${c.id}/accept`);
      this.toast.success('Challenge accepted! Get ready to play.');
      await this.router.navigate(['/match', match.code]);
    } catch (err) {
      this.toast.error(err);
      await this.load(true);
    } finally { this.busy.set(null); }
  }

  async decline(c: Challenge) {
    this.busy.set(c.id);
    try {
      await this.api.post(`/challenges/${c.id}/decline`);
      this.toast.info(`You declined ${c.challenger.username}'s challenge.`);
      await this.load(true);
    } catch (err) { this.toast.error(err); await this.load(true); } finally { this.busy.set(null); }
  }

  async cancel(c: Challenge) {
    this.busy.set(c.id);
    try {
      await this.api.post(`/challenges/${c.id}/cancel`);
      this.toast.info('Challenge cancelled.');
      await this.load(true);
    } catch (err) { this.toast.error(err); await this.load(true); } finally { this.busy.set(null); }
  }

  expiresIn(c: Challenge) {
    const ms = new Date(c.expiresAt).getTime() - Date.now();
    if (ms <= 0) return 'Expired';
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${Math.round(m / 60)}h left to respond` : `${m}m left to respond`;
  }

  statusLabel(c: Challenge) {
    return ({ ACCEPTED: 'Accepted', DECLINED: 'Declined', CANCELLED: 'Cancelled', EXPIRED: 'Expired', PENDING: 'Pending' } as Record<string, string>)[c.status];
  }
}
