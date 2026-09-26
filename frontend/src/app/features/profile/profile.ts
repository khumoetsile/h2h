import { Component, inject, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { User, UserStats } from '../../core/models';
import { Toast } from '../../core/toast.service';
import { Avatar, LoadError, Spinner } from '../../shared/ui';
import { StatsPanel } from './stats-panel';

const COLORS = ['#3B82F6', '#22D3EE', '#A855F7', '#F97316', '#10B981', '#EF4444', '#EAB308', '#EC4899', '#14B8A6', '#6366F1'];

@Component({
  selector: 'app-profile',
  imports: [ReactiveFormsModule, RouterLink, DatePipe, MatFormFieldModule, MatInputModule, MatIconModule, MatProgressSpinnerModule, Avatar, LoadError, Spinner, StatsPanel],
  template: `
    <div class="page">
      @if (auth.user(); as u) {
        <section class="card head">
          <app-avatar [name]="u.username" [color]="u.avatarColor" [size]="76" />
          <div class="grow">
            <h1>{{ u.firstName }} {{ u.lastName }}</h1>
            <div class="muted">&#64;{{ u.username }} · Member since {{ u.createdAt | date: 'MMM y' }}</div>
            @if (u.bio) { <p class="text-2 bio">{{ u.bio }}</p> }
          </div>
          <div class="row">
            <button class="btn" (click)="editing.set(!editing())"><mat-icon>{{ editing() ? 'close' : 'edit' }}</mat-icon>{{ editing() ? 'Close' : 'Edit profile' }}</button>
            <button class="btn btn-ghost" (click)="auth.logout()"><mat-icon>logout</mat-icon>Sign out</button>
          </div>
        </section>

        @if (editing()) {
          <section class="edit-grid fade-in">
            <form class="card form" [formGroup]="form" (ngSubmit)="save()">
              <h3>Basic information</h3>
              <div class="form-row">
                <mat-form-field><mat-label>First name</mat-label><input matInput formControlName="firstName" /><mat-error>Letters only, required.</mat-error></mat-form-field>
                <mat-form-field><mat-label>Last name</mat-label><input matInput formControlName="lastName" /><mat-error>Letters only, required.</mat-error></mat-form-field>
              </div>
              <mat-form-field><mat-label>Phone</mat-label><input matInput formControlName="phone" /><mat-error>Enter a valid phone number.</mat-error></mat-form-field>
              <mat-form-field><mat-label>Bio</mat-label><input matInput formControlName="bio" maxlength="160" placeholder="Reaction Rush specialist" /><mat-hint align="end">{{ form.controls.bio.value.length }}/160</mat-hint></mat-form-field>
              <div class="colors">
                <span class="muted small">Avatar colour</span>
                @for (c of colors; track c) {
                  <button type="button" class="sw" [style.background]="c" [class.sel]="form.controls.avatarColor.value === c" (click)="form.controls.avatarColor.setValue(c)" [attr.aria-label]="c"></button>
                }
              </div>
              <p class="muted tiny">Username and email can't be changed in this prototype.</p>
              @if (saveError()) { <div class="form-error">{{ saveError() }}</div> }
              <button class="btn btn-primary" type="submit" [disabled]="saving()">@if (saving()) { <mat-spinner diameter="18" /> } Save changes</button>
            </form>
            <form class="card form" [formGroup]="pwForm" (ngSubmit)="changePassword()">
              <h3>Change password</h3>
              <mat-form-field><mat-label>Current password</mat-label><input matInput type="password" formControlName="currentPassword" autocomplete="current-password" /></mat-form-field>
              <mat-form-field><mat-label>New password</mat-label><input matInput type="password" formControlName="newPassword" autocomplete="new-password" /><mat-error>8+ chars with upper, lower and a number.</mat-error></mat-form-field>
              <mat-form-field><mat-label>Confirm new password</mat-label><input matInput type="password" formControlName="confirmPassword" autocomplete="new-password" /></mat-form-field>
              @if (pwError()) { <div class="form-error">{{ pwError() }}</div> }
              <button class="btn" type="submit" [disabled]="pwSaving()">Update password</button>
            </form>
          </section>
        }

        @if (!auth.isAdmin()) {
          @if (statsError()) { <app-load-error [message]="statsError()" (retry)="loadStats()" /> }
          @else if (!stats()) { <app-spinner /> }
          @else {
            <div class="section-title" style="margin-top:8px"><h2>Your statistics</h2><a routerLink="/matches">Match history</a></div>
            <app-stats-panel [stats]="stats()!" />
            <div class="section-title" style="margin-top:20px"><h2>Leaderboard</h2></div>
            <div class="card row-between"><span>All-time rank</span><strong>{{ rank() ? '#' + rank() : 'Unranked' }}</strong></div>
          }
        } @else {
          <div class="card"><p class="text-2">Administrator accounts don't take part in matches. Use the <a class="link" routerLink="/admin">admin panel</a> to manage the platform.</p></div>
        }
      }
    </div>
  `,
  styles: [`
    .head { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; margin-bottom: 20px; padding: 22px; .grow { flex: 1; min-width: 200px; } }
    .bio { margin-top: 6px; }
    .edit-grid { display: grid; gap: 16px; grid-template-columns: 1fr; margin-bottom: 20px; }
    @media (min-width: 900px) { .edit-grid { grid-template-columns: 1.3fr 1fr; align-items: start; } }
    .form h3 { margin-bottom: 12px; }
    .colors { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 6px 0; }
    .sw { width: 24px; height: 24px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
    .sw.sel { border-color: #fff; box-shadow: 0 0 0 2px var(--bg); }
  `],
})
export class ProfilePage implements OnInit {
  private api = inject(Api);
  protected auth = inject(AuthService);
  private toast = inject(Toast);
  private fb = inject(FormBuilder);
  protected colors = COLORS;
  protected editing = signal(false);
  protected stats = signal<UserStats | null>(null);
  protected rank = signal<number | null>(null);
  protected statsError = signal('');
  protected saving = signal(false);
  protected saveError = signal('');
  protected pwSaving = signal(false);
  protected pwError = signal('');

  protected form = this.fb.nonNullable.group({
    firstName: ['', [Validators.required, Validators.maxLength(60), Validators.pattern(/^[\p{L}][\p{L}' .-]*$/u)]],
    lastName: ['', [Validators.required, Validators.maxLength(60), Validators.pattern(/^[\p{L}][\p{L}' .-]*$/u)]],
    phone: ['', [Validators.required, Validators.pattern(/^\+?[0-9][0-9\s-]{6,18}[0-9]$/)]],
    bio: ['', Validators.maxLength(160)],
    avatarColor: ['#3B82F6'],
  });
  protected pwForm = this.fb.nonNullable.group({
    currentPassword: ['', Validators.required],
    newPassword: ['', [Validators.required, Validators.minLength(8), Validators.pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9]).*$/)]],
    confirmPassword: ['', Validators.required],
  });

  ngOnInit() {
    const u = this.auth.user();
    if (u) this.form.patchValue({ firstName: u.firstName, lastName: u.lastName, phone: u.phone, bio: u.bio ?? '', avatarColor: u.avatarColor });
    if (!this.auth.isAdmin()) this.loadStats();
  }

  async loadStats() {
    this.statsError.set('');
    try {
      const r = await this.api.get<{ stats: UserStats; leaderboard: { rank: number | null } }>('/me/stats');
      this.stats.set(r.stats);
      this.rank.set(r.leaderboard.rank);
    } catch { this.statsError.set('Could not load your statistics.'); }
  }

  async save() {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.saving.set(true);
    this.saveError.set('');
    try {
      const { user } = await this.api.patch<{ user: User }>('/me', this.form.getRawValue());
      this.auth.user.set(user);
      this.toast.success('Profile updated.');
      this.editing.set(false);
    } catch (err) { this.saveError.set(apiError(err).message); } finally { this.saving.set(false); }
  }

  async changePassword() {
    this.pwForm.markAllAsTouched();
    if (this.pwForm.invalid) return;
    const v = this.pwForm.getRawValue();
    if (v.newPassword !== v.confirmPassword) { this.pwError.set('Passwords do not match.'); return; }
    this.pwSaving.set(true);
    this.pwError.set('');
    try {
      await this.api.post('/me/password', v);
      this.toast.success('Password updated.');
      this.pwForm.reset();
    } catch (err) { this.pwError.set(apiError(err).message); } finally { this.pwSaving.set(false); }
  }
}
