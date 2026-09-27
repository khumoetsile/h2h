import { Component, computed, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { interval } from 'rxjs';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { challengeStanding, competitionName, DISPLAY_STATE, picksFor, viewDisplayState } from '../../core/challenge-state';
import { ConfigStore } from '../../core/config.store';
import { relevantStat } from '../../core/football-stat';
import { MatchView } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { ServerClock } from '../../core/server-clock';
import { Toast } from '../../core/toast.service';
import { Countdown } from '../../shared/countdown';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar, GameIcon, LoadError, Spinner } from '../../shared/ui';

/**
 * The live state of one 1v1 challenge. Every timer shown here is a deadline
 * the server stamped; when one reaches zero the page simply asks the server
 * what happened — it never decides an outcome itself.
 */
@Component({
  selector: 'app-match-lobby',
  imports: [RouterLink, DatePipe, MatIconModule, MatProgressSpinnerModule, MoneyPipe, Avatar, GameIcon, LoadError, Spinner, Countdown],
  templateUrl: './match-lobby.html',
  styleUrl: './match-lobby.scss',
})
export class MatchLobbyPage implements OnInit {
  readonly code = input.required<string>();
  private api = inject(Api);
  private router = inject(Router);
  private toast = inject(Toast);
  private realtime = inject(RealtimeService);
  private clock = inject(ServerClock);
  protected config = inject(ConfigStore);
  private destroyRef = inject(DestroyRef);

  protected match = signal<MatchView | null>(null);
  protected error = signal('');
  protected busy = signal<string | null>(null);
  protected leaveOpen = signal(false);

  protected me = computed(() => this.match()?.players.find((p) => p.userId === this.match()?.viewerId) ?? null);
  protected opponent = computed(() => this.match()?.players.find((p) => p.userId !== this.match()?.viewerId) ?? null);
  protected isFootball = computed(() => this.match()?.category === 'FOOTBALL');
  protected state = computed(() => { const m = this.match(); return m ? DISPLAY_STATE[viewDisplayState(m)] : null; });
  protected picks = computed(() => { const m = this.match(); return m ? picksFor(m) : { mine: '', theirs: '' }; });
  protected stat = computed(() => { const f = this.match()?.football; return f ? relevantStat(f) : null; });
  protected standing = computed(() => { const m = this.match(); return m ? challengeStanding(m) : { headline: '', tone: 'none' as const }; });
  /** LOCKED = both players locked in. Leaving from here on costs the abandonment fee. */
  protected isLocked = computed(() => this.match()?.status === 'READY');
  protected kickedOff = computed(() => {
    const k = this.match()?.timers.kickoffAt;
    return !!k && this.clock.remainingMs(k) === 0;
  });
  protected competition = competitionName;

  ngOnInit() {
    this.load();
    this.realtime.match$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((m) => {
      if (m.code === this.code()) this.apply(m);
    });
    // Back online: re-sync straight away — the server state is authoritative.
    this.realtime.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load(true));
    interval(4000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load(true));
  }

  private apply(m: MatchView) {
    const prev = this.match();
    this.match.set(m);
    if (prev && prev.status === 'WAITING' && m.status !== 'WAITING' && ['MATCHED', 'READY'].includes(m.status)) {
      const opp = m.players.find((p) => p.userId !== m.viewerId);
      this.toast.success(m.status === 'READY' ? `${opp?.username} joined, you're both locked in!` : `Opponent found: ${opp?.username}. Lock in now.`);
    }
    if (m.status === 'COMPLETED' || m.status === 'CANCELLED' || m.status === 'VOID') {
      this.router.navigate(['/match', m.code, 'result'], { replaceUrl: true });
    }
  }

  async load(silent = false) {
    try {
      const { match } = await this.api.get<{ match: MatchView }>(`/matches/${this.code()}`);
      this.apply(match);
      this.error.set('');
    } catch (err) {
      if (!silent || !this.match()) this.error.set(apiError(err).message);
    }
  }

  /** A countdown hit zero: ask the server for its verdict (it may already have applied the timeout). */
  onTimerExpired() {
    setTimeout(() => this.load(true), 1200);
  }

  private async act(name: string, path: string, success?: string) {
    this.busy.set(name);
    try {
      const { match } = await this.api.post<{ match: MatchView }>(`/matches/${this.code()}/${path}`);
      if (success) this.toast.success(success);
      this.apply(match);
      return true;
    } catch (err) {
      this.toast.error(err);
      this.load(true);
      return false;
    } finally {
      this.busy.set(null);
    }
  }

  lockIn() { return this.act('lock', 'ready'); }
  demoOpponent() { return this.act('bot', 'demo-opponent'); }
  play() { this.router.navigate(['/match', this.code(), 'play']); }

  openLeave() { this.leaveOpen.set(true); }
  closeLeave() { if (!this.busy()) this.leaveOpen.set(false); }
  async confirmLeave() {
    const locked = this.isLocked();
    const ok = await this.act('cancel', 'cancel', locked
      ? `You left the challenge. Your stake was refunded and the ${this.config.abandonmentFee()} abandonment fee was charged.`
      : 'Challenge cancelled. Your stake was returned in full.');
    if (ok) this.leaveOpen.set(false);
  }
}
