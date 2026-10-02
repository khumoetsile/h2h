import { Component, computed, inject, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ConfigStore } from '../../core/config.store';
import { MatchView } from '../../core/models';
import { ServerClock } from '../../core/server-clock';
import { Countdown } from '../../shared/countdown';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar, GameIcon } from '../../shared/ui';

/** After this long without an opponent, "Practice" becomes the main button. */
const OFFER_PRACTICE_AFTER_S = 8;

export type RoomPhase = 'searching' | 'found' | 'waiting-opponent' | 'starting' | 'playing' | 'waiting-finish';

/** Which screen a skill-game match is on, from the server's view of it. */
export function roomPhase(m: MatchView): RoomPhase {
  const me = m.players.find((p) => p.userId === m.viewerId);
  switch (m.status) {
    case 'WAITING': return 'searching';
    case 'MATCHED': return me?.owesAction ? 'found' : 'waiting-opponent';
    case 'READY': return 'starting';
    default: return me?.submitted ? 'waiting-finish' : 'playing';
  }
}

/**
 * The match room for skill games. One screen per state, one obvious button:
 * searching -> (practice instead) -> opponent found -> I'm ready -> the game
 * starts by itself. It only draws; the lobby page does the talking to the server.
 */
@Component({
  selector: 'app-skill-room',
  imports: [MatIconModule, MatProgressSpinnerModule, MoneyPipe, Avatar, GameIcon, Countdown],
  template: `
    @let m = match();
    <header class="head">
      <app-game-icon [slug]="m.game.slug" [color]="m.game.accentColor" [size]="48" />
      <div class="grow">
        <h1>{{ m.game.name }}</h1>
        <p class="muted">Stake <span class="money">{{ m.stake | money }}</span> · Win <strong class="money accent">{{ m.prize | money }}</strong></p>
      </div>
    </header>

    @switch (phase()) {
      @case ('searching') {
        <section class="panel fade-in">
          <div class="radar" aria-hidden="true"><i></i><i></i><i></i><mat-icon>search</mat-icon></div>
          <h2>Looking for an opponent</h2>
          <p class="elapsed" role="timer">{{ elapsedText() }}</p>
          <p class="text-2">You will be matched with the next player who picks this game and stake.</p>
          @if (config.config()?.demoBotsEnabled) {
            <button class="btn btn-block btn-play" [class.btn-primary]="offerPractice()" [disabled]="!!busy()" (click)="practice.emit()">
              @if (busy() === 'bot') { <mat-spinner diameter="22" /> } @else { <mat-icon>smart_toy</mat-icon> }
              {{ offerPractice() ? 'No one yet? Play a practice match' : 'Play a practice match instead' }}
            </button>
          }
          <button class="btn btn-ghost btn-block" [disabled]="!!busy()" (click)="leave.emit()">Cancel</button>
          <p class="muted tiny">Your {{ m.stake | money }} is returned in full if nobody joins.</p>
        </section>
      }

      @case ('found') {
        <section class="panel fade-in">
          <div class="vs">
            <div class="who"><app-avatar [name]="me()?.username ?? ''" [color]="me()?.avatarColor ?? '#3B82F6'" [size]="64" /><strong>You</strong></div>
            <span class="vs-t">vs</span>
            <div class="who"><app-avatar [name]="opponent()?.username ?? '?'" [color]="opponent()?.avatarColor ?? '#64748B'" [size]="64" /><strong>{{ opponent()?.username }}</strong></div>
          </div>
          <h2>Opponent found</h2>
          <p class="text-2">{{ opponent()?.lockedIn ? opponent()?.username + ' is ready and waiting for you.' : 'Tap ready when you are.' }}</p>
          <button class="btn btn-primary btn-play btn-block" [disabled]="!!busy()" (click)="ready.emit()">
            @if (busy() === 'lock') { <mat-spinner diameter="22" /> } @else { I'm ready }
          </button>
          <p class="muted small">Ready within <app-countdown [deadline]="match().timers.myDeadline" [icon]="false" (expired)="expired.emit()" /></p>
          <p class="muted tiny">Ready holds your {{ m.stake | money }} entry. Leaving after both of you are ready costs {{ config.abandonmentFee() }}.</p>
          <button class="btn btn-ghost btn-block" [disabled]="!!busy()" (click)="leave.emit()">Leave (free until you are ready)</button>
        </section>
      }

      @case ('waiting-opponent') {
        <section class="panel fade-in">
          <div class="vs">
            <div class="who"><app-avatar [name]="me()?.username ?? ''" [color]="me()?.avatarColor ?? '#3B82F6'" [size]="64" /><strong>You</strong><span class="chip chip-win">Ready</span></div>
            <span class="vs-t">vs</span>
            <div class="who"><app-avatar [name]="opponent()?.username ?? '?'" [color]="opponent()?.avatarColor ?? '#64748B'" [size]="64" /><strong>{{ opponent()?.username }}</strong><span class="chip">Getting ready</span></div>
          </div>
          <h2>Waiting for {{ opponent()?.username }}</h2>
          <p class="muted small">They have <app-countdown [deadline]="opponent()?.deadline" [icon]="false" (expired)="expired.emit()" /> to get ready.</p>
          <button class="btn btn-ghost btn-block" [disabled]="!!busy()" (click)="leave.emit()">Leave (free)</button>
        </section>
      }

      @case ('starting') {
        <section class="panel fade-in">
          <div class="vs">
            <div class="who"><app-avatar [name]="me()?.username ?? ''" [color]="me()?.avatarColor ?? '#3B82F6'" [size]="64" /><strong>You</strong></div>
            <span class="vs-t">vs</span>
            <div class="who"><app-avatar [name]="opponent()?.username ?? '?'" [color]="opponent()?.avatarColor ?? '#64748B'" [size]="64" /><strong>{{ opponent()?.username }}</strong></div>
          </div>
          <h2>Both ready</h2>
          <mat-spinner diameter="28" />
          <p class="text-2">Starting now</p>
          <button class="btn btn-primary btn-play btn-block" (click)="play.emit()">Start now</button>
        </section>
      }

      @case ('playing') {
        <section class="panel fade-in">
          <h2>Your match is on</h2>
          <p class="muted small">Time left: <app-countdown [deadline]="match().timers.myDeadline" [icon]="false" [urgentUnder]="60" (expired)="expired.emit()" /></p>
          <button class="btn btn-primary btn-play btn-block" (click)="play.emit()">{{ me()?.started ? 'Back to the game' : 'Start game' }}</button>
        </section>
      }

      @case ('waiting-finish') {
        <section class="panel fade-in">
          <mat-spinner diameter="28" />
          <h2>Waiting for {{ opponent()?.username }} to finish</h2>
          <p class="muted small"><app-countdown [deadline]="opponent()?.deadline" [icon]="false" (expired)="expired.emit()" /> left. If they do not finish in time, you win.</p>
        </section>
      }
    }
  `,
  styles: [`
    :host { display: block; }
    .head { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
    .head h1 { font-size: 30px; }
    .grow { flex: 1; min-width: 0; }
    .panel { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 12px; padding: 24px 18px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
    .panel h2 { font-size: 28px; }
    .elapsed { font-family: var(--font-display); font-size: 40px; line-height: 1; font-variant-numeric: tabular-nums; color: var(--text-2); }
    .vs { display: flex; align-items: center; justify-content: center; gap: 18px; width: 100%; }
    .who { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; max-width: 40%; }
    .who strong { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .vs-t { font-family: var(--font-display); font-size: 26px; color: var(--muted); }
    .radar { position: relative; width: 92px; height: 92px; display: flex; align-items: center; justify-content: center; }
    .radar mat-icon { font-size: 38px; width: 38px; height: 38px; color: var(--accent); z-index: 1; }
    .radar i { position: absolute; inset: 24px; border-radius: 50%; border: 2px solid var(--accent); opacity: 0; animation: ring 2.4s infinite ease-out; }
    .radar i:nth-child(2) { animation-delay: .8s; } .radar i:nth-child(3) { animation-delay: 1.6s; }
    @keyframes ring { 0% { transform: scale(.8); opacity: .8; } 100% { transform: scale(2.4); opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .radar i { animation: none; opacity: .4; } }
  `],
})
export class SkillRoom {
  protected config = inject(ConfigStore);
  private clock = inject(ServerClock);

  readonly match = input.required<MatchView>();
  readonly busy = input<string | null>(null);
  readonly ready = output<void>();
  readonly practice = output<void>();
  readonly leave = output<void>();
  readonly play = output<void>();
  readonly expired = output<void>();

  protected phase = computed(() => roomPhase(this.match()));
  protected me = computed(() => this.match().players.find((p) => p.userId === this.match().viewerId) ?? null);
  protected opponent = computed(() => this.match().players.find((p) => p.userId !== this.match().viewerId) ?? null);

  private elapsedS = computed(() => Math.max(0, Math.floor((this.clock.now() - new Date(this.match().createdAt).getTime()) / 1000)));
  protected elapsedText = computed(() => `${Math.floor(this.elapsedS() / 60)}:${String(this.elapsedS() % 60).padStart(2, '0')}`);
  protected offerPractice = computed(() => this.elapsedS() >= OFFER_PRACTICE_AFTER_S);
}
