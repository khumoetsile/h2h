import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { ConfigStore } from '../../core/config.store';

@Component({
  selector: 'app-recovery',
  imports: [ReactiveFormsModule, RouterLink, MatFormFieldModule, MatInputModule],
  template: ` <main class="page page-narrow recovery">
    <a class="link" routerLink="/login">Back to sign in</a>
    <section class="card stack">
      <h1>{{ resetting ? 'Choose a new password' : 'Forgot your password?' }}</h1>
      @if (complete()) {
        <p role="status">
          {{
            resetting
              ? 'Your password has been changed. Sign in with your new password. All previous sessions have been signed out.'
              : message()
          }}
        </p>
        @if (resetting) {
          <a class="btn btn-primary" routerLink="/login">Sign in</a>
        } @else {
          <p class="muted">
            The link lasts 30 minutes. If it does not arrive, check spam or use the support option
            below.
          </p>
        }
      } @else if (resetting && !validToken) {
        <p role="alert">This recovery link is incomplete. Request a new link to continue.</p>
        <a class="btn btn-primary" routerLink="/forgot-password">Request a new link</a>
      } @else if (!resetting && !available()) {
        <p role="status">Email recovery is not available yet.</p>
        <p class="text-2">
          Your password cannot be recovered from this device. The site administrator can help you
          reset it after verifying your account.
        </p>
        <a class="btn" routerLink="/help">Get help</a>
      } @else {
        <p class="text-2">
          {{
            resetting
              ? 'Use at least 8 characters with uppercase, lowercase and a number.'
              : 'Enter the email address you used for your account. We will send you a private recovery link.'
          }}
        </p>
        @if (error()) {
          <p class="form-error" role="alert">{{ error() }}</p>
        }
        <form class="form stack" [formGroup]="form" (ngSubmit)="submit()" novalidate>
          @if (!resetting) {
            <mat-form-field
              ><mat-label>Email address</mat-label
              ><input matInput type="email" formControlName="email" autocomplete="email" />
              <mat-error>Enter a valid email address.</mat-error></mat-form-field
            >
          } @else {
            <mat-form-field
              ><mat-label>New password</mat-label
              ><input
                matInput
                type="password"
                formControlName="password"
                autocomplete="new-password"
              />
              <mat-error
                >Use 8–72 characters, uppercase, lowercase and a number.</mat-error
              ></mat-form-field
            >
            <mat-form-field
              ><mat-label>Confirm new password</mat-label
              ><input
                matInput
                type="password"
                formControlName="confirmPassword"
                autocomplete="new-password"
              />
              <mat-error>Confirm the same password.</mat-error></mat-form-field
            >
          }
          <button class="btn btn-primary btn-block" [disabled]="busy()" type="submit">
            {{ busy() ? 'Please wait…' : resetting ? 'Save new password' : 'Send recovery link' }}
          </button>
        </form>
        @if (resetting) {
          <a class="link" routerLink="/forgot-password">Request another link</a>
        }
      }
      @if (supportEmail()) {
        <a class="link" [href]="'mailto:' + supportEmail()">Contact support</a>
      }
      <p class="muted small">
        Guest accounts without an email cannot receive a recovery link. Save your account from your
        profile before changing devices.
      </p>
    </section>
  </main>`,
  styles: [
    `
      .recovery {
        padding-top: 48px;
        max-width: 540px;
      }
      .recovery > .link {
        display: inline-block;
        padding: 12px 0;
        margin-bottom: 12px;
      }
    `,
  ],
})
export class RecoveryPage {
  private api = inject(Api);
  private route = inject(ActivatedRoute);
  private config = inject(ConfigStore);
  private fb = inject(FormBuilder);
  protected resetting = this.route.snapshot.routeConfig?.path === 'reset-password';
  private token = this.route.snapshot.queryParamMap.get('token') ?? '';
  protected validToken = /^[a-f0-9]{64}$/.test(this.token);
  protected available = computed(() => !!this.config.config()?.recovery?.available);
  protected supportEmail = computed(() => this.config.config()?.recovery?.supportEmail ?? '');
  protected form = this.fb.nonNullable.group({
    email: ['', this.resetting ? [] : [Validators.required, Validators.email]],
    password: [
      '',
      this.resetting
        ? [
            Validators.required,
            Validators.minLength(8),
            Validators.maxLength(72),
            Validators.pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9]).*$/),
          ]
        : [],
    ],
    confirmPassword: ['', this.resetting ? [Validators.required] : []],
  });
  protected busy = signal(false);
  protected error = signal('');
  protected complete = signal(false);
  protected message = signal('');
  async submit() {
    if (this.busy()) return;
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const data = this.form.getRawValue();
    if (this.resetting && data.password !== data.confirmPassword) {
      this.form.controls.confirmPassword.setErrors({ mismatch: true });
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      if (this.resetting)
        await this.api.post('/auth/reset-password', {
          token: this.token,
          password: data.password,
          confirmPassword: data.confirmPassword,
        });
      else {
        const r = await this.api.post<{ message: string }>('/auth/forgot-password', {
          email: data.email,
        });
        this.message.set(r.message);
      }
      this.complete.set(true);
      this.form.reset();
    } catch (e) {
      this.error.set(apiError(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}
