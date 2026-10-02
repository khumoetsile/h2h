import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { apiError } from '../../core/api-error';
import { ConfigStore } from '../../core/config.store';
import { formatMoney } from '../../core/format';
import { QuickPlay } from '../../core/quick-play';

/**
 * What a stranger sees first. One promise, one button. Tapping Play creates a guest account behind the scenes
 * and puts them in a penalty shootout; nobody fills in a form before they have had a go.
 */
@Component({
  selector: 'app-landing',
  imports: [RouterLink, MatProgressSpinnerModule],
  template: `
    <main class="land">
      <div class="brand">Head2Head</div>

      <svg class="art" viewBox="0 0 360 200" aria-hidden="true">
        <rect width="360" height="200" fill="#1d3a2a"/>
        <g fill="#244733"><rect y="0" width="360" height="25"/><rect y="50" width="360" height="25"/><rect y="100" width="360" height="25"/><rect y="150" width="360" height="25"/></g>
        <rect x="70" y="40" width="220" height="90" fill="none" stroke="#fff" stroke-width="5"/>
        <g stroke="#fff" stroke-opacity=".3" stroke-width="1"><path d="M70 62H290M70 84H290M70 106H290M105 40V130M140 40V130M175 40V130M210 40V130M245 40V130"/></g>
        <path d="M0 150H360" stroke="#fff" stroke-opacity=".6" stroke-width="2"/>
        <circle cx="258" cy="70" r="11" fill="#fff" stroke="#14100c" stroke-width="1.5"/>
        <path d="M258 64l5 3.5-2 6h-6l-2-6z" fill="#14100c"/>
        <g transform="translate(150 128)"><rect x="-13" y="-46" width="26" height="30" rx="7" fill="#f5701f"/><circle cx="0" cy="-54" r="9" fill="#e8c9a6"/><rect x="-18" y="-44" width="6" height="20" rx="3" fill="#f5701f" transform="rotate(-50 -15 -44)"/><rect x="12" y="-44" width="6" height="20" rx="3" fill="#f5701f" transform="rotate(50 15 -44)"/></g>
      </svg>

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
    .art { width: 100%; border-radius: var(--radius); display: block; }
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
