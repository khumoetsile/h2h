import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { AbstractControl, FormBuilder, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AuthService } from '../../core/auth.service';
import { apiError } from '../../core/api-error';
import { BRAND } from '../../core/brand';
import { ConfigStore } from '../../core/config.store';
import { Toast } from '../../core/toast.service';
import { formatMoney } from '../../core/format';
import { DemoBadge } from '../../shared/ui';

const NAME = /^[\p{L}][\p{L}' .-]*$/u;

function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const pw = group.get('password')?.value;
  const confirm = group.get('confirmPassword');
  if (confirm && confirm.value && pw !== confirm.value) {
    confirm.setErrors({ ...(confirm.errors || {}), mismatch: true });
  } else if (confirm?.hasError('mismatch')) {
    const { mismatch: _m, ...rest } = confirm.errors || {};
    confirm.setErrors(Object.keys(rest).length ? rest : null);
  }
  return null;
}

@Component({
  selector: 'app-register',
  imports: [ReactiveFormsModule, RouterLink, MatFormFieldModule, MatInputModule, MatCheckboxModule, MatIconModule, MatProgressSpinnerModule, DemoBadge],
  styleUrl: './auth-layout.scss',
  template: `
    <aside class="brand-side">
      <div class="logo">
        <svg viewBox="0 0 32 32" width="30" height="30"><path d="M6 26 L13 6 L18 6 L11 26 Z" fill="var(--accent)"/><path d="M15 26 L22 6 L27 6 L20 26 Z" fill="var(--text)"/></svg>
        {{ brand.name }}
      </div>
      <div>
        <h1>Make an account and start playing.</h1>
        <p class="lead">You start with {{ bonusLabel() }} in <strong>demo funds</strong> so you can try everything. No real money is involved.</p>
      </div>
      <span></span>
    </aside>

    <section class="form-side">
      <div class="form-card fade-in">
        <div class="mobile-logo">
          <svg viewBox="0 0 32 32" width="26" height="26"><path d="M6 26 L13 6 L18 6 L11 26 Z" fill="var(--accent)"/><path d="M15 26 L22 6 L27 6 L20 26 Z" fill="var(--text)"/></svg>
          {{ brand.name }} <app-demo-badge />
        </div>
        <h2>Create account</h2>
        <p class="sub">It takes less than a minute.</p>
        @if (error()) { <div class="form-error" style="margin-bottom:14px"><mat-icon>error</mat-icon>{{ error() }}</div> }

        <form class="form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <div class="form-row">
            <mat-form-field>
              <mat-label>First name</mat-label>
              <input matInput formControlName="firstName" autocomplete="given-name" />
              <mat-error>{{ msg('firstName') }}</mat-error>
            </mat-form-field>
            <mat-form-field>
              <mat-label>Last name</mat-label>
              <input matInput formControlName="lastName" autocomplete="family-name" />
              <mat-error>{{ msg('lastName') }}</mat-error>
            </mat-form-field>
          </div>
          <mat-form-field>
            <mat-label>Username</mat-label>
            <span matTextPrefix class="muted">&#64;&nbsp;</span>
            <input matInput formControlName="username" autocomplete="username" />
            <mat-hint>3-20 letters, numbers or underscores</mat-hint>
            <mat-error>{{ msg('username') }}</mat-error>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Email</mat-label>
            <input matInput type="email" formControlName="email" autocomplete="email" />
            <mat-error>{{ msg('email') }}</mat-error>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Phone number</mat-label>
            <input matInput type="tel" formControlName="phone" autocomplete="tel" placeholder="+267 71 234 567" />
            <mat-error>{{ msg('phone') }}</mat-error>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Password</mat-label>
            <input matInput type="password" formControlName="password" autocomplete="new-password" />
            <mat-error>{{ msg('password') }}</mat-error>
          </mat-form-field>
          <div class="pw-rules">
            <span [class.ok]="pw().length >= 8">✓ 8+ characters</span>
            <span [class.ok]="/[A-Z]/.test(pw())">✓ Uppercase</span>
            <span [class.ok]="/[a-z]/.test(pw())">✓ Lowercase</span>
            <span [class.ok]="/[0-9]/.test(pw())">✓ Number</span>
          </div>
          <mat-form-field>
            <mat-label>Confirm password</mat-label>
            <input matInput type="password" formControlName="confirmPassword" autocomplete="new-password" />
            <mat-error>{{ msg('confirmPassword') }}</mat-error>
          </mat-form-field>
          <div class="remember"><mat-checkbox formControlName="remember">Keep me signed in</mat-checkbox></div>
          <button class="btn btn-primary btn-lg btn-block" type="submit" [disabled]="loading()">
            @if (loading()) { <mat-spinner diameter="20" /> } @else { Create account }
          </button>
          <p class="muted tiny" style="margin-top:12px;text-align:center">DEMO prototype: deposits, stakes and winnings use simulated funds only.</p>
        </form>
        <p class="foot">Already have an account? <a class="link" routerLink="/login">Sign in</a></p>
      </div>
    </section>
  `,
})
export class RegisterPage {
  private fb = inject(FormBuilder);
  private auth = inject(AuthService);
  private router = inject(Router);
  private toast = inject(Toast);
  private configStore = inject(ConfigStore);
  protected brand = BRAND;

  protected form = this.fb.nonNullable.group({
    firstName: ['', [Validators.required, Validators.maxLength(60), Validators.pattern(NAME)]],
    lastName: ['', [Validators.required, Validators.maxLength(60), Validators.pattern(NAME)]],
    username: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(20), Validators.pattern(/^[A-Za-z0-9_]+$/)]],
    email: ['', [Validators.required, Validators.email, Validators.maxLength(190)]],
    phone: ['', [Validators.required, Validators.pattern(/^\+?[0-9][0-9\s-]{6,18}[0-9]$/)]],
    password: ['', [Validators.required, Validators.minLength(8), Validators.maxLength(72), Validators.pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9]).*$/)]],
    confirmPassword: ['', Validators.required],
    remember: [true],
  }, { validators: passwordsMatch });

  protected loading = signal(false);
  protected error = signal('');
  private serverErrors = signal<Record<string, string>>({});
  private pwValue = toSignal(this.form.controls.password.valueChanges, { initialValue: '' });
  protected pw = computed(() => this.pwValue() || '');
  protected bonusLabel = computed(() => formatMoney(this.configStore.config()?.signupBonus ?? 250));

  msg(field: keyof typeof this.form.controls): string {
    const c = this.form.controls[field];
    const server = this.serverErrors()[field];
    if (c.hasError('server') && server) return server;
    if (c.hasError('required')) return 'This field is required.';
    if (c.hasError('mismatch')) return 'Passwords do not match.';
    if (c.hasError('email')) return 'Enter a valid email address.';
    if (c.hasError('minlength')) return `Must be at least ${c.getError('minlength').requiredLength} characters.`;
    if (c.hasError('maxlength')) return `Must be at most ${c.getError('maxlength').requiredLength} characters.`;
    if (c.hasError('pattern')) {
      return ({
        username: 'Only letters, numbers and underscores.',
        phone: 'Enter a valid phone number, e.g. +267 71 234 567.',
        password: 'Needs upper- and lowercase letters and a number.',
      } as Record<string, string>)[field] || 'Only letters, spaces, apostrophes and hyphens.';
    }
    return '';
  }

  async submit() {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.loading.set(true);
    this.error.set('');
    try {
      await this.auth.register(this.form.getRawValue());
      this.toast.success(`Welcome to ${this.brand.name}! Your demo wallet is ready.`);
      await this.router.navigateByUrl('/dashboard');
    } catch (err) {
      const e = apiError(err);
      this.error.set(e.message);
      this.serverErrors.set(e.fields);
      for (const [field] of Object.entries(e.fields)) {
        const c = this.form.get(field);
        if (c) { c.setErrors({ ...(c.errors || {}), server: true }); c.markAsTouched(); }
      }
    } finally {
      this.loading.set(false);
    }
  }

  constructor() {
    this.configStore.ensure();
  }
}
