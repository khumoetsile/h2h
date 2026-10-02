import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { apiError } from '../core/api-error';
import { AuthService } from '../core/auth.service';
import { Toast } from '../core/toast.service';

/**
 * Shown to guests (people who tapped Play with no sign-up). One line to start with; tapping it opens a
 * password and name, and that is the whole "register" step. It draws nothing for everyone else.
 */
@Component({
  selector: 'app-save-account',
  imports: [FormsModule, MatIconModule, MatProgressSpinnerModule],
  template: `
    @if (auth.user()?.isGuest) {
      <section class="save">
        @if (!open()) {
          <mat-icon>bookmark</mat-icon>
          <div class="grow">
            <strong>Save your account</strong>
            <p class="muted small">You're playing as {{ auth.user()?.username }}. Add a password so you can sign in on any phone and keep your balance.</p>
          </div>
          <button class="btn btn-primary btn-sm" (click)="open.set(true)">Save</button>
        } @else {
          <form class="form" (ngSubmit)="save()">
            <strong>Save your account</strong>
            <label>Your name
              <input class="field" name="u" [(ngModel)]="username" autocapitalize="none" autocomplete="username" maxlength="20" />
            </label>
            <label>Choose a password
              <input class="field" name="p" type="password" [(ngModel)]="password" autocomplete="new-password" placeholder="At least 6 characters" />
            </label>
            @if (error()) { <p class="form-error">{{ error() }}</p> }
            <button class="btn btn-primary btn-block" type="submit" [disabled]="busy()">
              @if (busy()) { <mat-spinner diameter="20" /> } @else { Save account }
            </button>
            <p class="muted tiny">Your balance is demo funds for now. No real money is involved yet.</p>
          </form>
        }
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .save { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); text-align: left; }
    .save > mat-icon { color: var(--accent); flex-shrink: 0; }
    .grow { flex: 1; min-width: 0; }
    .grow p { margin: 2px 0 0; line-height: 1.35; }
    .form { display: flex; flex-direction: column; gap: 10px; width: 100%; }
    label { display: flex; flex-direction: column; gap: 6px; color: var(--text-2); font-size: 15px; }
    .field { height: 48px; padding: 0 14px; font-size: 17px; border-radius: var(--radius); border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text); }
    .field:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  `],
})
export class SaveAccount {
  protected auth = inject(AuthService);
  private toast = inject(Toast);

  protected open = signal(false);
  protected busy = signal(false);
  protected error = signal('');
  protected username = this.auth.user()?.username ?? '';
  protected password = '';

  protected async save() {
    if (this.password.length < 6) { this.error.set('Choose a password with at least 6 characters.'); return; }
    this.busy.set(true);
    this.error.set('');
    try {
      const name = this.username.trim();
      await this.auth.claim(this.password, name && name !== this.auth.user()?.username ? name : undefined);
      this.toast.success('Account saved. You can sign in on any phone now.');
    } catch (err) {
      this.error.set(apiError(err).message);
    } finally {
      this.busy.set(false);
    }
  }
}
