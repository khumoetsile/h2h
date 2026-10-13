import { Component, inject } from '@angular/core';
import { AuthService } from '../core/auth.service';

/** Appears when a saved account is waiting for the service, including after a refresh while offline. */
@Component({
  selector: 'app-session-recovery-banner',
  template: `
    @if (auth.sessionUnavailable()) {
      <aside class="recovery-banner" role="status" aria-live="polite">
        <div class="copy"><strong>Reconnecting your account</strong><span>Your saved account is kept. We’ll retry automatically. Reconnect before starting another game.</span></div>
        <button type="button" [disabled]="auth.sessionRefreshing()" (click)="auth.retrySession()">{{ auth.sessionRefreshing() ? 'Checking account…' : 'Retry account' }}</button>
      </aside>
    }
  `,
  styles: [`
    :host { display: block; }
    .recovery-banner { position: relative; z-index: 60; display: flex; align-items: center; justify-content: center; gap: 22px; padding: 14px 20px; color: #f0e2b6; background: #343322; border-bottom: 1px solid #8b8153; }
    .copy { display: grid; gap: 3px; max-width: 720px; }.copy strong { font-size: 14px; }.copy span { color: #d9d2b8; font-size: 13px; line-height: 1.4; }
    button { min-height: 44px; flex-shrink: 0; padding: 10px 16px; border: 1px solid #cabb86; border-radius: 8px; color: #f0e2b6; background: #47432a; font-weight: 600; font-size: 14px; }
    button:disabled { opacity: .65; cursor: wait; }button:focus-visible { outline: 2px solid #fff2c8; outline-offset: 3px; }
    @media(max-width:560px) { .recovery-banner { gap: 12px; padding: 12px 16px; align-items: flex-start; }.copy span { font-size: 12px; }button { max-width: 124px; padding-inline: 10px; font-size: 12px; } }
  `],
})
export class SessionRecoveryBanner { protected auth = inject(AuthService); }
