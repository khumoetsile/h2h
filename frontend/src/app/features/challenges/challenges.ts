import { Component, computed, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { Challenge, Pick as FootballPick } from '../../core/models';
import { ConfigStore } from '../../core/config.store';
import { ServerClock } from '../../core/server-clock';
import { Countdown } from '../../shared/countdown';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
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
  imports: [RouterLink, MatIconModule, MatProgressSpinnerModule, MoneyPipe, AgoPipe, Avatar, EmptyState, GameIcon, LoadError, SkeletonList, Countdown],
  templateUrl: './challenges.html',
  styleUrl: './challenges.scss',
})
export class ChallengesPage implements OnInit {
  /** ?tab=incoming|outgoing|history */
  readonly tabParam = input<string | undefined>(undefined, { alias: 'tab' });
  protected config = inject(ConfigStore);
  private clock = inject(ServerClock);
  /** The incoming challenge whose Accept & Lock In sheet is open. */
  protected acceptTarget = signal<Challenge | null>(null);
  private api = inject(Api);
  private toast = inject(Toast);
  private router = inject(Router);
  private realtime = inject(RealtimeService);
  private destroyRef = inject(DestroyRef);

  protected challenges = signal<Challenge[] | null>(null);
  protected error = signal('');
  protected tab = signal<Tab>('incoming');
  protected busy = signal<number | null>(null);
  /** The side an incoming football challenge's recipient has tapped, per challenge — nothing is sent until Accept. */
  protected myPick = signal<Record<number, FootballPick>>({});
  protected acceptError = signal<Record<number, string>>({});

  /** A pending challenge whose deadline has passed is shown as expired right away; the server has the final say. */
  protected isLive = (c: Challenge) => c.status === 'PENDING' && this.clock.remainingMs(c.expiresAt) > 0;
  protected incoming = computed(() => (this.challenges() ?? []).filter((c) => c.direction === 'INCOMING' && this.isLive(c)));
  protected outgoing = computed(() => (this.challenges() ?? []).filter((c) => c.direction === 'OUTGOING' && this.isLive(c)));
  protected history = computed(() => (this.challenges() ?? []).filter((c) => !this.isLive(c)));
  protected visible = computed(() => ({ incoming: this.incoming(), outgoing: this.outgoing(), history: this.history() })[this.tab()]);

  ngOnInit() {
    const t = this.tabParam();
    if (t === 'incoming' || t === 'outgoing' || t === 'history') { this.tab.set(t); this.tabFromUrl = true; }
    this.load();
    this.realtime.challenge$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load(true));
    this.realtime.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load(true));
  }

  async load(silent = false) {
    if (!silent) this.error.set('');
    try {
      const { challenges } = await this.api.get<{ challenges: Challenge[] }>('/challenges', { status: 'all' });
      this.challenges.set(challenges);
      if (!silent && !this.tabFromUrl && this.incoming().length === 0 && this.outgoing().length > 0) this.tab.set('outgoing');
    } catch {
      if (!silent) this.error.set("We couldn't load your challenges.");
    }
  }

  choosePick(c: Challenge, pick: FootballPick) {
    this.myPick.update((m) => ({ ...m, [c.id]: pick }));
    this.acceptError.update((m) => ({ ...m, [c.id]: '' }));
  }

  private tabFromUrl = false;

  /** Step 1: open the lock-in sheet (after a side is chosen, for football). */
  openAccept(c: Challenge) {
    if (c.football && !this.myPick()[c.id]) {
      this.acceptError.update((m) => ({ ...m, [c.id]: 'Choose your side before accepting.' }));
      return;
    }
    this.acceptTarget.set(c);
  }
  closeAccept() { if (this.busy() === null) this.acceptTarget.set(null); }
  pickLabel(c: Challenge) {
    const p = this.myPick()[c.id];
    if (!c.football || !p) return '';
    return p === 'HOME' ? c.football.homePickLabel : p === 'AWAY' ? c.football.awayPickLabel : p === 'YES' ? 'Yes' : 'No';
  }

  /** Step 2: ACCEPT & LOCK IN — the server re-checks the deadline and everything else. */
  async accept(c: Challenge) {
    const pick = this.myPick()[c.id];
    if (c.football && !pick) return;
    this.busy.set(c.id);
    this.acceptError.update((m) => ({ ...m, [c.id]: '' }));
    try {
      const { match } = await this.api.post<{ match: { code: string } }>(`/challenges/${c.id}/accept`, c.football ? { pick } : {});
      this.toast.success(c.football ? "Accepted — you're both locked in!" : 'Accepted and locked in — waiting for ' + c.challenger.username + ' to lock in.');
      this.acceptTarget.set(null);
      await this.router.navigate(['/match', match.code]);
    } catch (err) {
      this.acceptTarget.set(null);
      if (c.football) this.acceptError.update((m) => ({ ...m, [c.id]: apiError(err).message }));
      else this.toast.error(err);
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

  statusLabel(c: Challenge) {
    // A PENDING row can only be in history because its timer ran out (the sweeper marks it EXPIRED shortly).
    return ({ ACCEPTED: 'Accepted', DECLINED: 'Declined', CANCELLED: 'Cancelled', EXPIRED: 'Expired', PENDING: 'Expired' } as Record<string, string>)[c.status];
  }
}
