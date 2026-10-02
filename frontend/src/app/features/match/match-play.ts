import { Component, inject, input, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { MatchView } from '../../core/models';
import { Toast } from '../../core/toast.service';
import { GameFinish } from '../../games/game-types';
import { ReactionRushGame } from '../../games/reaction-rush';
import { AimChallengeGame } from '../../games/aim-challenge';
import { MemoryBattleGame } from '../../games/memory-battle';
import { WordBattleGame } from '../../games/word-battle';
import { PenaltyShootoutGame } from '../../games/penalty-shootout';
import { GameIcon, Spinner } from '../../shared/ui';
import { Countdown } from '../../shared/countdown';

interface StartResponse { matchId: number; code: string; game: string; spec: any; startedAt: string; deadline: string; resumed: boolean; }

const MAX_AUTO_RETRIES = 3;

/**
 * The actual game screen. Standalone route — no header, no bottom nav, no
 * balance shown. This screen has one job: let the player focus on the game.
 * A network hiccup while submitting is retried quietly in the background
 * with plain-language status; the match itself can never be lost just
 * because a connection blipped — only the server's own timeout can do that.
 */
@Component({
  selector: 'app-match-play',
  imports: [MatIconModule, MatProgressSpinnerModule, GameIcon, Spinner, Countdown,
    ReactionRushGame, AimChallengeGame, MemoryBattleGame, WordBattleGame, PenaltyShootoutGame],
  template: `
    <div class="play-screen">
      @if (error()) {
        <div class="state fade-in">
          <mat-icon class="loss big-icon">error</mat-icon>
          <h2>We couldn't start this game</h2>
          <p class="text-2">{{ error() }}</p>
          <button class="btn btn-primary" (click)="exit()">Back to match</button>
        </div>
      } @else if (!start()) {
        <app-spinner />
      } @else {
        <div class="play-head">
          <button class="exit-btn" (click)="confirmExit()" aria-label="Exit game"><mat-icon>close</mat-icon></button>
          <div class="grow">
            <strong>{{ match()?.game?.name }}</strong>
            <div class="muted tiny">vs {{ opponentName() }}</div>
          </div>
          <app-countdown [deadline]="start()!.deadline" [urgentUnder]="60" [attr.title]="'Time left to finish'" />
          <app-game-icon [slug]="start()!.game" [color]="match()?.game?.accentColor ?? '#22D3EE'" [size]="32" />
        </div>

        @if (submitting() || submitted() || submitError()) {
          <div class="state fade-in">
            @if (submitting() && !submitError()) {
              <mat-spinner diameter="32" />
              <h2>{{ retryAttempt() > 0 ? "Reconnecting…" : "Sending your result…" }}</h2>
              <p class="muted">{{ retryAttempt() > 0 ? "We're trying again. This won't cost you the match." : "Just a moment." }}</p>
            }
            @if (submitError()) {
              <mat-icon class="loss big-icon">wifi_off</mat-icon>
              <h2>Connection interrupted</h2>
              <p class="text-2">{{ submitError() }}</p>
              <button class="btn btn-primary" (click)="retrySubmit()">Try again</button>
            }
          </div>
        } @else {
          @switch (start()!.game) {
            <!-- Each game is its own lazy chunk, so a phone only downloads the one being played. -->
            @case ('reaction-rush') { @defer (on immediate) { <app-reaction-rush [spec]="start()!.spec" (finished)="submit($event)" /> } @placeholder { <app-spinner /> } }
            @case ('aim-challenge') { @defer (on immediate) { <app-aim-challenge [spec]="start()!.spec" (finished)="submit($event)" /> } @placeholder { <app-spinner /> } }
            @case ('memory-battle') { @defer (on immediate) { <app-memory-battle [spec]="start()!.spec" (finished)="submit($event)" /> } @placeholder { <app-spinner /> } }
            @case ('word-battle') { @defer (on immediate) { <app-word-battle [spec]="start()!.spec" (finished)="submit($event)" /> } @placeholder { <app-spinner /> } }
            @case ('penalty-shootout') { @defer (on immediate) { <app-penalty-shootout [spec]="start()!.spec" (finished)="submit($event)" /> } @placeholder { <app-spinner /> } }
          }
        }
      }
    </div>
  `,
  styles: [`
    .play-screen { max-width: 900px; margin: 0 auto; padding: 14px 16px calc(20px + env(safe-area-inset-bottom)); min-height: 100vh; }
    .play-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; .grow { flex: 1; min-width: 0; text-align: center; } strong { font-size: 15px; } }
    .exit-btn {
      width: 40px; height: 40px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: var(--text-2);
      display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0;
      &:hover { background: var(--surface-2); color: var(--text); }
    }
    .state { display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; padding: 60px 20px; }
    .big-icon { font-size: 40px; width: 40px; height: 40px; }
  `],
})
export class MatchPlayPage implements OnInit {
  readonly code = input.required<string>();
  private api = inject(Api);
  private router = inject(Router);
  private toast = inject(Toast);

  protected start = signal<StartResponse | null>(null);
  protected match = signal<MatchView | null>(null);
  protected error = signal('');
  protected submitting = signal(false);
  protected submitted = signal(false);
  protected submitError = signal('');
  protected retryAttempt = signal(0);
  private pending: GameFinish | null = null;

  protected opponentName = () => this.match()?.players.find((p) => p.userId !== this.match()?.viewerId)?.username ?? '';

  async ngOnInit() {
    // A toast from the lobby (e.g. "Opponent found") can still be on screen
    // when we land here — clear it so the game gets a completely clean start.
    this.toast.dismiss();
    try {
      const [start, view] = await Promise.all([
        this.api.post<StartResponse>(`/matches/${this.code()}/start`),
        this.api.get<{ match: MatchView }>(`/matches/${this.code()}`),
      ]);
      this.match.set(view.match);
      this.start.set(start);
    } catch (err) {
      const e = apiError(err);
      if (e.code === 'ALREADY_SUBMITTED' || e.code === 'MATCH_COMPLETED') {
        this.exit();
        return;
      }
      this.error.set(e.message);
    }
  }

  exit() { this.router.navigate(['/match', this.code()], { replaceUrl: true }); }

  confirmExit() {
    if (confirm("Leave this game screen? The timer keeps running, and if you don't finish before it runs out, you forfeit.")) this.exit();
  }

  async submit(result: GameFinish, isRetry = false) {
    this.pending = result;
    this.submitting.set(true);
    this.submitError.set('');
    try {
      const r = await this.api.post<{ result: { valid: boolean; invalidReason: string | null; score: number }; match: MatchView }>(
        `/matches/${this.code()}/result`, result,
      );
      this.submitted.set(true);
      const target = r.match.status === 'COMPLETED' || r.match.status === 'CANCELLED'
        ? ['/match', this.code(), 'result']
        : ['/match', this.code()];
      await this.router.navigate(target, { replaceUrl: true });
    } catch (err) {
      const e = apiError(err);
      if (e.code === 'ALREADY_SUBMITTED' || e.code === 'MATCH_COMPLETED') {
        this.exit();
        return;
      }
      // A network blip should not cost the player the match: retry quietly a
      // few times in the background before ever bothering them.
      if (e.code === 'NETWORK' && this.retryAttempt() < MAX_AUTO_RETRIES) {
        this.retryAttempt.update((n) => n + 1);
        setTimeout(() => this.submit(result, true), 1500 * this.retryAttempt());
        return;
      }
      this.submitError.set(
        e.code === 'NETWORK'
          ? "We couldn't reach the game server. Check your connection and try again. Your result is safe on your device."
          : e.message,
      );
      this.submitting.set(false);
      void isRetry;
    }
  }

  retrySubmit() {
    this.retryAttempt.set(0);
    if (this.pending) this.submit(this.pending);
  }
}
