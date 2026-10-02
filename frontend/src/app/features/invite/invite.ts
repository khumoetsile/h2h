import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { ConfigStore } from '../../core/config.store';
import { formatMoney } from '../../core/format';
import { Avatar, GameIcon, Spinner } from '../../shared/ui';

interface Invite {
  code: string;
  state: 'OPEN' | 'TAKEN' | 'EXPIRED';
  stake: number;
  prize: number;
  game: { slug: string; name: string; accentColor: string; tagline: string };
  from: { username: string; avatarColor: string };
}

/**
 * The page behind a shared challenge link. Built for someone who has never seen the app: who challenged
 * them, to what, and one button. New players only choose a name and a password.
 */
@Component({
  selector: 'app-invite',
  imports: [FormsModule, RouterLink, MatProgressSpinnerModule, Avatar, GameIcon, Spinner],
  template: `
    <main class="wrap">
      <div class="brand">Head2Head</div>
      @if (loading()) {
        <app-spinner />
      } @else if (!invite()) {
        <section class="card box">
          <h1>Link not found</h1>
          <p class="text-2">This challenge link is not valid. Ask your friend to send a new one.</p>
          <a class="btn btn-primary btn-block btn-play" routerLink="/">Open Head2Head</a>
        </section>
      } @else {
        @let i = invite()!;
        <section class="card box">
          <app-avatar [name]="i.from.username" [color]="i.from.avatarColor" [size]="72" />
          <p class="who"><strong>{{ i.from.username }}</strong> challenged you</p>
          <div class="game"><app-game-icon [slug]="i.game.slug" [color]="i.game.accentColor" [size]="40" /><h1>{{ i.game.name }}</h1></div>
          <p class="text-2">{{ i.game.tagline }}</p>

          @if (i.state !== 'OPEN') {
            <p class="form-error">{{ i.state === 'TAKEN' ? 'Someone has already joined this challenge.' : 'This challenge has expired.' }}</p>
            <a class="btn btn-primary btn-block btn-play" routerLink="/">Play something else</a>
          } @else if (mine()) {
            <p class="text-2">This is your own challenge. Send the link to a friend.</p>
            <a class="btn btn-primary btn-block btn-play" [routerLink]="['/match', i.code]">Back to my match</a>
          } @else if (auth.isLoggedIn()) {
            <button class="btn btn-primary btn-block btn-play" [disabled]="busy()" (click)="accept()">
              @if (busy()) { <mat-spinner diameter="22" /> } @else { Play {{ i.from.username }} }
            </button>
            @if (error()) { <p class="form-error">{{ error() }}</p> }
            <p class="muted small">Stake {{ money(i.stake) }}, winner takes {{ money(i.prize) }}. Demo funds, no real money.</p>
          } @else {
            <form class="form" (ngSubmit)="join()">
              <label>Pick a name
                <input class="field" name="u" [(ngModel)]="username" autocomplete="username" autocapitalize="none" maxlength="20" placeholder="e.g. keeper_king" required />
              </label>
              <label>Pick a password
                <input class="field" name="p" type="password" [(ngModel)]="password" autocomplete="new-password" placeholder="At least 6 characters" required />
              </label>
              @if (error()) { <p class="form-error">{{ error() }}</p> }
              <button class="btn btn-primary btn-block btn-play" type="submit" [disabled]="busy()">
                @if (busy()) { <mat-spinner diameter="22" /> } @else { Play {{ i.from.username }} }
              </button>
            </form>
            <p class="muted small">You get {{ bonus() }} demo funds free. No real money. Stake {{ money(i.stake) }}.</p>
            <a class="link small" [routerLink]="['/login']" [queryParams]="{ next: '/join/' + i.code }">I already have an account</a>
          }
        </section>
      }
    </main>
  `,
  styles: [`
    .wrap { min-height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; padding: 24px 16px; background: var(--bg); }
    .brand { font-family: var(--font-display); font-size: 28px; font-weight: 700; letter-spacing: .02em; color: var(--accent); }
    .box { width: 100%; max-width: 420px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 12px; padding: 24px 18px; }
    .who { font-size: 20px; }
    .game { display: flex; align-items: center; gap: 10px; }
    .game h1 { font-size: 34px; }
    .form { display: flex; flex-direction: column; gap: 12px; width: 100%; text-align: left; }
    label { display: flex; flex-direction: column; gap: 6px; color: var(--text-2); font-size: 15px; }
    .field { height: 52px; padding: 0 14px; font-size: 18px; border-radius: var(--radius); border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text); }
    .field:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
    .link { padding: 8px; }
  `],
})
export class InvitePage implements OnInit {
  readonly code = input.required<string>();
  protected auth = inject(AuthService);
  private api = inject(Api);
  private router = inject(Router);
  private config = inject(ConfigStore);

  protected invite = signal<Invite | null>(null);
  protected loading = signal(true);
  protected busy = signal(false);
  protected error = signal('');
  protected username = '';
  protected password = '';
  protected money = formatMoney;
  protected bonus = computed(() => formatMoney(this.config.config()?.signupBonus ?? 250));
  protected mine = computed(() => this.auth.user()?.username === this.invite()?.from.username);

  async ngOnInit() {
    try {
      this.invite.set((await this.api.get<{ invite: Invite }>(`/invites/${this.code()}`)).invite);
    } catch { this.invite.set(null); }
    this.loading.set(false);
  }

  protected async join() {
    const name = this.username.trim();
    if (name.length < 3) { this.error.set('Pick a name with at least 3 letters or numbers.'); return; }
    if (this.password.length < 6) { this.error.set('Pick a password with at least 6 characters.'); return; }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.quickSignup(name, this.password);
    } catch (e) {
      this.error.set(apiError(e).message);
      this.busy.set(false);
      return;
    }
    await this.accept();
  }

  protected async accept() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.post(`/matches/${this.code()}/join`);
      await this.router.navigate(['/match', this.code()]);
    } catch (e) {
      this.error.set(apiError(e).message);
      this.busy.set(false);
    }
  }
}
