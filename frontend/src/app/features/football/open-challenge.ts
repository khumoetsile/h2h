import { Component, computed, inject, input, output, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { ConfigStore } from '../../core/config.store';
import { MatchView, OpenFootballChallenge } from '../../core/models';
import { ServerClock } from '../../core/server-clock';
import { Toast } from '../../core/toast.service';
import { Countdown } from '../../shared/countdown';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar } from '../../shared/ui';

/** The side a joiner gets: always the one the creator didn't pick. */
export function joinerPickLabel(c: OpenFootballChallenge) {
  if (c.challengeType.pickType === 'YES_NO') return c.creatorPick === 'YES' ? 'No' : 'Yes';
  return c.creatorPick === 'HOME' ? c.awayTeam : c.homeTeam;
}

/** One "player looking for an opponent" card. */
@Component({
  selector: 'app-open-challenge-card',
  imports: [MatIconModule, MoneyPipe, Avatar, Countdown],
  template: `
    @let c = challenge();
    <article class="card oc fade-in" [class.gone]="expired()">
      <div class="oc-top">
        <span class="muted tiny comp">{{ c.competition.name }}</span>
        <span class="stake money">{{ c.stake | money }}</span>
      </div>
      <div class="teams-line"><span class="team">{{ c.homeTeam }}</span><span class="vs">vs</span><span class="team">{{ c.awayTeam }}</span></div>
      <p class="q">{{ c.challengeType.question }}</p>
      <div class="by">
        <app-avatar [name]="c.creator.username" [color]="c.creator.avatarColor" [size]="24" />
        <span class="small grow">Created by <strong>{{ c.creator.username }}</strong> · picked {{ c.creatorPickLabel }}</span>
      </div>
      <div class="timer small">
        @if (expired()) { <span class="muted">Expired</span> }
        @else { <span class="muted">Accept within</span> <app-countdown [deadline]="c.acceptanceDeadline" /> }
      </div>
      <button class="btn btn-primary btn-block" [disabled]="expired()" (click)="join.emit(c)">
        <mat-icon>swords</mat-icon> Join challenge
      </button>
    </article>
  `,
  styles: [`
    .oc { display: flex; flex-direction: column; gap: 8px; padding: 16px; min-width: 0; }
    .oc.gone { opacity: .5; }
    .oc-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .comp { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stake { font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--accent); flex-shrink: 0; }
    .q { font-size: 14px; color: var(--text-2); }
    .by { display: flex; align-items: center; gap: 8px; min-width: 0; .grow { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } }
    .timer { display: flex; align-items: center; gap: 6px; }
  `],
})
export class OpenChallengeCard {
  private clock = inject(ServerClock);
  readonly challenge = input.required<OpenFootballChallenge>();
  readonly join = output<OpenFootballChallenge>();
  protected expired = computed(() => this.clock.remainingMs(this.challenge().acceptanceDeadline) === 0);
}

/**
 * "Before you join" sheet. The joiner sees exactly what they're committing
 * to — including the abandonment fee — and the only way in is the explicit
 * ACCEPT & LOCK IN button. The server re-checks the acceptance deadline and
 * the 1v1 slot; nothing here is trusted.
 */
@Component({
  selector: 'app-join-sheet',
  imports: [MatIconModule, MatProgressSpinnerModule, MoneyPipe, Countdown],
  template: `
    @let c = challenge();
    <div class="confirm-backdrop" (click)="close()">
      <div class="confirm-card" role="dialog" aria-modal="true" aria-labelledby="join-title" (click)="$event.stopPropagation()">
        <h2 id="join-title">Join this challenge?</h2>
        <p class="text-2">You are joining a <strong>1v1 challenge</strong> against {{ c.creator.username }}. Once both players lock in, the challenge will begin.</p>
        <div class="confirm-summary">
          <div class="cs-row"><span>Match</span><strong>{{ c.homeTeam }} vs {{ c.awayTeam }}</strong></div>
          <div class="cs-row"><span>Question</span><strong>{{ c.challengeType.question }}</strong></div>
          <div class="cs-row"><span>{{ c.creator.username }}'s pick</span><strong>{{ c.creatorPickLabel }}</strong></div>
          <div class="cs-row"><span>Your pick</span><strong class="accent">{{ pick() }}</strong></div>
          <div class="cs-row"><span>Stake</span><strong class="money">{{ c.stake | money }}</strong></div>
          <div class="cs-row"><span>Time left to accept</span><app-countdown [deadline]="c.acceptanceDeadline" /></div>
        </div>
        <div class="fee-box">
          <mat-icon>info</mat-icon>
          <div>Leaving after the challenge is locked incurs a <strong>{{ config.abandonmentFee() }} abandonment fee</strong>. A draw, a void result or a cancelled match costs you nothing.</div>
        </div>
        @if (error()) { <div class="form-error" style="margin-top:12px"><mat-icon>error</mat-icon>{{ error() }}</div> }
        <div class="confirm-actions">
          <button class="btn btn-primary btn-lg btn-block" [disabled]="busy()" (click)="accept()">
            @if (busy()) { <mat-spinner diameter="20" /> } @else { <mat-icon>lock</mat-icon> }
            Accept &amp; lock in {{ c.stake | money }}
          </button>
          <button class="btn btn-ghost btn-block" [disabled]="busy()" (click)="close()">Not now</button>
        </div>
      </div>
    </div>
  `,
})
export class JoinSheet {
  private api = inject(Api);
  private router = inject(Router);
  private toast = inject(Toast);
  protected config = inject(ConfigStore);
  readonly challenge = input.required<OpenFootballChallenge>();
  readonly closed = output<{ refresh: boolean }>();
  protected busy = signal(false);
  protected error = signal('');
  protected pick = computed(() => joinerPickLabel(this.challenge()));

  close(refresh = false) {
    if (!this.busy()) this.closed.emit({ refresh });
  }

  async accept() {
    const c = this.challenge();
    this.busy.set(true);
    this.error.set('');
    try {
      const { match } = await this.api.post<{ match: MatchView }>(`/football/open-challenges/${c.matchId}/join`);
      this.toast.success(`You're in, you and ${c.creator.username} are both locked in.`);
      await this.router.navigate(['/match', match.code]);
    } catch (err) {
      const e = apiError(err);
      if (e.code === 'CHALLENGE_ALREADY_TAKEN' || e.code === 'CHALLENGE_EXPIRED' || e.code === 'MATCH_ALREADY_STARTED' || e.code === 'MATCH_CANCELLED') {
        this.toast.info(e.code === 'CHALLENGE_EXPIRED' ? 'That challenge just expired. No one joined in time.' : 'Another player already took that challenge.');
        this.busy.set(false);
        this.closed.emit({ refresh: true });
        return;
      }
      this.error.set(e.message);
    } finally {
      this.busy.set(false);
    }
  }
}
