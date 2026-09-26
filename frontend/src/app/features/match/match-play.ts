import { Component, inject, input, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
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
import { MoneyPipe } from '../../shared/pipes';
import { GameIcon, Spinner } from '../../shared/ui';

interface StartResponse { matchId: number; code: string; game: string; spec: any; startedAt: string; deadline: string; resumed: boolean; }

@Component({
  selector: 'app-match-play',
  imports: [RouterLink, MatIconModule, MatProgressSpinnerModule, MoneyPipe, GameIcon, Spinner,
    ReactionRushGame, AimChallengeGame, MemoryBattleGame, WordBattleGame, PenaltyShootoutGame],
  template: `
    <div class="page play-page">
      @if (error()) {
        <div class="card state">
          <mat-icon class="loss">error</mat-icon>
          <h2>Can't start this game</h2>
          <p class="text-2">{{ error() }}</p>
          <a class="btn" [routerLink]="['/match', code()]">Back to match</a>
        </div>
      } @else if (!start()) {
        <app-spinner />
      } @else {
        <div class="play-head">
          <app-game-icon [slug]="start()!.game" [color]="match()?.game?.accentColor ?? '#22D3EE'" [size]="36" />
          <div class="grow">
            <strong>{{ match()?.game?.name }}</strong>
            <div class="muted tiny">{{ code() }} · vs &#64;{{ opponentName() }} · prize {{ match()?.prize | money:'demo' }}</div>
          </div>
          @if (start()!.resumed) { <span class="chip chip-demo">Resumed</span> }
        </div>

        @if (submitting() || submitted() || submitError()) {
          <div class="card state">
            @if (submitting()) { <mat-spinner diameter="32" /><h2>Submitting your run…</h2><p class="muted">The server is scoring your moves.</p> }
            @if (submitError()) {
              <p class="loss">{{ submitError() }}</p>
              <button class="btn btn-primary" (click)="retrySubmit()">Retry submit</button>
            }
          </div>
        } @else {
          @switch (start()!.game) {
            @case ('reaction-rush') { <app-reaction-rush [spec]="start()!.spec" (finished)="submit($event)" /> }
            @case ('aim-challenge') { <app-aim-challenge [spec]="start()!.spec" (finished)="submit($event)" /> }
            @case ('memory-battle') { <app-memory-battle [spec]="start()!.spec" (finished)="submit($event)" /> }
            @case ('word-battle') { <app-word-battle [spec]="start()!.spec" (finished)="submit($event)" /> }
            @case ('penalty-shootout') { <app-penalty-shootout [spec]="start()!.spec" (finished)="submit($event)" /> }
          }
          <p class="muted tiny center">Scores are calculated on the server from your moves. Leaving now forfeits if you don't return before the deadline.</p>
        }
      }
    </div>
  `,
  styles: [`
    .play-page { max-width: 900px; }
    .play-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; .grow { flex: 1; min-width: 0; } }
    .state { display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; padding: 40px 20px; }
    .center { text-align: center; margin-top: 12px; }
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
  private pending: GameFinish | null = null;

  protected opponentName = () => this.match()?.players.find((p) => p.userId !== this.match()?.viewerId)?.username ?? '';

  async ngOnInit() {
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
        this.router.navigate(['/match', this.code()], { replaceUrl: true });
        return;
      }
      this.error.set(e.message);
    }
  }

  async submit(result: GameFinish) {
    this.pending = result;
    this.submitting.set(true);
    this.submitError.set('');
    try {
      const r = await this.api.post<{ result: { valid: boolean; invalidReason: string | null; score: number }; match: MatchView }>(
        `/matches/${this.code()}/result`, result,
      );
      this.submitted.set(true);
      if (!r.result.valid) this.toast.error(`Your run was flagged: ${r.result.invalidReason}`);
      const target = r.match.status === 'COMPLETED' ? ['/matches', this.code()] : ['/match', this.code()];
      await this.router.navigate(target, { replaceUrl: true });
    } catch (err) {
      const e = apiError(err);
      if (e.code === 'ALREADY_SUBMITTED' || e.code === 'MATCH_COMPLETED') {
        await this.router.navigate(['/match', this.code()], { replaceUrl: true });
        return;
      }
      this.submitError.set(e.message);
    } finally {
      this.submitting.set(false);
    }
  }

  retrySubmit() { if (this.pending) this.submit(this.pending); }
}
