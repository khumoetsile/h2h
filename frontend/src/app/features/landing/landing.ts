import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { apiError } from '../../core/api-error';
import { ConfigStore } from '../../core/config.store';
import { formatMoney } from '../../core/format';
import { QuickPlay } from '../../core/quick-play';
import { PitchArt } from '../../shared/pitch-art';

/**
 * What a stranger sees first. One promise, one button. Tapping Play creates a guest account behind the scenes
 * and puts them in a penalty shootout; nobody fills in a form before they have had a go.
 */
@Component({
  selector: 'app-landing',
  imports: [RouterLink, MatProgressSpinnerModule, PitchArt],
  template: `
    <main class="land">
      <div class="brand">Head2Head</div>

      <app-pitch-art class="art" />

      <h1>Penalty shootouts against real people.</h1>
      <p class="lead">Take turns shooting and saving. A match takes about two minutes.</p>

      <div class="cta">
        <button class="btn btn-primary btn-play btn-block" [disabled]="busy()" (click)="play()">
          @if (busy()) { <mat-spinner diameter="24" /> } @else { Play now }
        </button>
        @if (error()) { <p class="form-error">{{ error() }}</p> }
        <p class="muted small">No sign-up. You start with {{ bonus() }} in demo funds.</p>
        <a class="link" routerLink="/login">I already have an account</a>
      </div>
    </main>
  `,
  styles: [`
    .land { min-height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px 20px calc(24px + env(safe-area-inset-bottom)); text-align: center; max-width: 480px; margin: 0 auto; }
    .brand { font-family: var(--font-display); font-size: 28px; font-weight: 700; color: var(--accent); letter-spacing: .02em; }
    .art { width: 100%; border-radius: var(--radius); overflow: hidden; }
    h1 { font-size: 36px; line-height: 1.05; }
    .lead { color: var(--text-2); font-size: 18px; line-height: 1.4; }
    .cta { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 10px; margin-top: 6px; }
    .link { padding: 10px; color: var(--text-2); text-decoration: underline; }
  `],
})
export class LandingPage {
  private quick = inject(QuickPlay);
  private config = inject(ConfigStore);

  protected busy = signal(false);
  protected error = signal('');
  protected bonus = computed(() => formatMoney(this.config.config()?.signupBonus ?? 250));

  protected async play() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.quick.playNow();
    } catch (err) {
      this.error.set(apiError(err).message);
      this.busy.set(false);
    }
  }
}
