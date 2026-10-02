import { Component, inject, isDevMode, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AuthService } from '../../core/auth.service';
import { apiError } from '../../core/api-error';
import { BRAND } from '../../core/brand';
import { DemoBadge } from '../../shared/ui';

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule, RouterLink, MatFormFieldModule, MatInputModule, MatCheckboxModule, MatIconModule, MatProgressSpinnerModule, DemoBadge],
  styleUrl: './auth-layout.scss',
  template: `
    <aside class="brand-side">
      <div class="logo">
        <svg viewBox="0 0 32 32" width="30" height="30"><path d="M6 26 L13 6 L18 6 L11 26 Z" fill="var(--accent)"/><path d="M15 26 L22 6 L27 6 L20 26 Z" fill="var(--text)"/></svg>
        {{ brand.name }}
      </div>
      <div>
        <h1>Play someone who's actually there.</h1>
        <p class="lead">Quick skill games and football fixtures, one opponent at a time. You both put up the same stake, you both get the same game, and the winner takes the pool minus a small fee.</p>
        <p class="lead">This is a demo. Every balance is simulated and no real money moves.</p>
      </div>
      <span></span>
    </aside>

    <section class="form-side">
      <div class="form-card fade-in">
        <div class="mobile-logo">
          <svg viewBox="0 0 32 32" width="26" height="26"><path d="M6 26 L13 6 L18 6 L11 26 Z" fill="var(--accent)"/><path d="M15 26 L22 6 L27 6 L20 26 Z" fill="var(--text)"/></svg>
          {{ brand.name }} <app-demo-badge />
        </div>
        <h2>Welcome back</h2>
        <p class="sub">Sign in to your {{ brand.name }} account.</p>

        @if (notice()) { <div class="form-error" style="margin-bottom:14px"><mat-icon>info</mat-icon>{{ notice() }}</div> }
        @if (error()) { <div class="form-error" style="margin-bottom:14px"><mat-icon>error</mat-icon>{{ error() }}</div> }

        <form class="form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <mat-form-field>
            <mat-label>Email or username</mat-label>
            <input matInput formControlName="identifier" autocomplete="username" />
            @if (form.controls.identifier.touched && form.controls.identifier.invalid) { <mat-error>Enter your email or username.</mat-error> }
          </mat-form-field>
          <mat-form-field>
            <mat-label>Password</mat-label>
            <input matInput [type]="showPw() ? 'text' : 'password'" formControlName="password" autocomplete="current-password" />
            <button type="button" matSuffix class="btn btn-ghost btn-sm" (click)="showPw.set(!showPw())" [attr.aria-label]="showPw() ? 'Hide password' : 'Show password'">
              <mat-icon>{{ showPw() ? 'visibility_off' : 'visibility' }}</mat-icon>
            </button>
            @if (form.controls.password.touched && form.controls.password.invalid) { <mat-error>Enter your password.</mat-error> }
          </mat-form-field>
          <div class="remember">
            <mat-checkbox formControlName="remember">Keep me signed in</mat-checkbox>
          </div>
          <button class="btn btn-primary btn-lg btn-block" type="submit" [disabled]="loading()">
            @if (loading()) { <mat-spinner diameter="20" /> } @else { Sign in }
          </button>
        </form>
        <p class="foot">New here? <a class="link" routerLink="/register">Create an account</a></p>

        @if (dev) {
          <div class="dev-creds">
            <div class="row-between"><strong>Development logins</strong><app-demo-badge label="Demo data" /></div>
            <div class="row-between"><span>Player</span><button class="btn btn-ghost btn-sm" type="button" (click)="fill('player@example.com', 'Player123!')"><code>player&#64;example.com</code></button></div>
            <div class="row-between"><span>Opponent</span><button class="btn btn-ghost btn-sm" type="button" (click)="fill('kabelo@example.com', 'Player123!')"><code>kabelo&#64;example.com</code></button></div>
            <div class="row-between"><span>Admin</span><button class="btn btn-ghost btn-sm" type="button" (click)="fill('admin@example.com', 'Admin123!')"><code>admin&#64;example.com</code></button></div>
          </div>
        }
      </div>
    </section>
  `,
})
export class LoginPage {
  private fb = inject(FormBuilder);
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  protected brand = BRAND;
  /** Seeded demo logins are only offered in local development builds. */
  protected dev = isDevMode();

  protected form = this.fb.nonNullable.group({
    identifier: ['', Validators.required],
    password: ['', Validators.required],
    remember: [true],
  });
  protected loading = signal(false);
  protected error = signal('');
  protected showPw = signal(false);
  protected notice = signal(
    ({ expired: 'Your session expired. Please sign in again.', disabled: 'Your account has been disabled.' } as Record<string, string>)[
      this.route.snapshot.queryParamMap.get('reason') || ''
    ] || '',
  );

  fill(identifier: string, password: string) {
    this.form.patchValue({ identifier, password });
  }

  async submit() {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.loading.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      const { identifier, password, remember } = this.form.getRawValue();
      await this.auth.login(identifier, password, remember);
      const next = this.route.snapshot.queryParamMap.get('next');
      await this.router.navigateByUrl(next && !this.auth.isAdmin() ? next : this.auth.homeUrl());
    } catch (err) {
      this.error.set(apiError(err).message);
    } finally {
      this.loading.set(false);
    }
  }
}
