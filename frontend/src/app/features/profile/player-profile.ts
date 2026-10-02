import { Component, inject, input, OnInit, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { Rivalry, UserStats } from '../../core/models';
import { RematchService } from '../../core/rematch.service';
import { Avatar, LoadError, Spinner } from '../../shared/ui';
import { StatsPanel } from './stats-panel';

interface PublicUser { id: number; username: string; displayName: string; avatarColor: string; bio: string | null; isBot: boolean; memberSince: string; online: boolean; }

/**
 * A player's identity card: who they are, how they've done, and your own
 * record against them. The point is that PvP feels like challenging a
 * person, so "Challenge <name>" is the primary action.
 */
@Component({
  selector: 'app-player-profile',
  imports: [RouterLink, DatePipe, DecimalPipe, MatIconModule, Avatar, LoadError, Spinner, StatsPanel],
  template: `
    <div class="page page-narrow">
      @if (error()) { <app-load-error [message]="error()" (retry)="load()" /> }
      @else if (!user()) { <app-spinner /> }
      @else {
        @let u = user()!;
        @let s = stats()!;
        <section class="card head">
          <app-avatar [name]="u.username" [color]="u.avatarColor" [size]="68" />
          <div class="grow">
            <h1>{{ u.username }} @if (u.isBot) { <span class="chip">Practice bot</span> }</h1>
            <div class="muted small">{{ u.displayName }} · Member since {{ u.memberSince | date: 'MMM y' }} @if (u.online) { · <span class="win">online</span> }</div>
            @if (u.bio) { <p class="text-2 bio">{{ u.bio }}</p> }
          </div>
        </section>

        <section class="card score-card">
          <div class="score"><span class="muted tiny">H2H SCORE</span><strong>{{ s.h2hScore | number }}</strong></div>
          <div class="record">
            <div><strong>{{ s.played }}</strong><span class="muted tiny">Challenges</span></div>
            <div><strong class="win">{{ s.wins }}</strong><span class="muted tiny">Wins</span></div>
            <div><strong>{{ s.draws }}</strong><span class="muted tiny">Draws</span></div>
            <div><strong class="loss">{{ s.losses }}</strong><span class="muted tiny">Losses</span></div>
          </div>
          @if (s.currentWinStreak > 1) { <p class="streak">{{ s.currentWinStreak }} wins in a row</p> }
        </section>

        @if (canChallenge()) {
          <div class="cta">
            <button class="btn btn-primary btn-lg btn-block" (click)="challengeFootball()"><mat-icon>sports_soccer</mat-icon>Challenge {{ u.username }}</button>
            <a class="btn btn-block" routerLink="/challenges/new" [queryParams]="{ opponent: u.username }"><mat-icon>sports_esports</mat-icon>Challenge to a game</a>
          </div>
        }

        @if (rivalry(); as r) {
          @if (r.played > 0) {
            <section class="card rivalry" [class.hot]="r.isRivalry">
              <span class="muted tiny eyebrow">{{ r.isRivalry ? 'Rivalry' : 'Head to head' }}</span>
              <h2>{{ me() }} vs {{ u.username }}</h2>
              <p class="muted small">{{ r.played }} challenge{{ r.played === 1 ? '' : 's' }}</p>
              <div class="rv-bar">
                <div><strong class="win">{{ r.myWins }}</strong><span class="muted tiny">{{ me() }}</span></div>
                <div><strong>{{ r.draws }}</strong><span class="muted tiny">Draws</span></div>
                <div><strong class="loss">{{ r.theirWins }}</strong><span class="muted tiny">{{ u.username }}</span></div>
              </div>
              @if (canChallenge()) { <button class="btn btn-primary btn-block" (click)="challengeFootball()"><mat-icon>replay</mat-icon>Challenge again</button> }
            </section>
          }
        }

        <app-stats-panel [stats]="s" />
      }
    </div>
  `,
  styles: [`
    .head { display: flex; gap: 16px; align-items: center; margin-bottom: 14px; padding: 18px; .grow { flex: 1; min-width: 0; } h1 { font-size: 24px; overflow-wrap: anywhere; } .bio { margin-top: 6px; } }
    .score-card { padding: 18px; margin-bottom: 14px; display: flex; flex-direction: column; gap: 14px; }
    .score { display: flex; flex-direction: column; gap: 2px; strong { font-family: var(--font-display); font-size: 36px; color: var(--accent); line-height: 1; } }
    .record { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px;
      div { display: flex; flex-direction: column; gap: 2px; background: var(--bg-elev); border-radius: var(--radius-sm); padding: 10px 6px; text-align: center; }
      strong { font-family: var(--font-display); font-size: 20px; } span { font-size: 11px; overflow: hidden; text-overflow: ellipsis; } }
    .streak { font-weight: 700; color: var(--demo); }
    .cta { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
    .rivalry { padding: 18px; margin-bottom: 14px; display: flex; flex-direction: column; gap: 8px; text-align: center; align-items: stretch;
      &.hot { border-color: var(--demo); } .eyebrow { font-weight: 800; } h2 { overflow-wrap: anywhere; } }
    .rv-bar { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 6px 0;
      div { display: flex; flex-direction: column; gap: 2px; min-width: 0; } strong { font-family: var(--font-display); font-size: 26px; }
      span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } }
  `],
})
export class PlayerProfilePage implements OnInit {
  readonly username = input.required<string>();
  private api = inject(Api);
  private router = inject(Router);
  private rematch = inject(RematchService);
  protected auth = inject(AuthService);
  protected user = signal<PublicUser | null>(null);
  protected stats = signal<UserStats | null>(null);
  protected rivalry = signal<Rivalry | null>(null);
  protected error = signal('');

  protected me = () => this.auth.user()?.username ?? 'You';
  protected canChallenge = () => {
    const u = this.user();
    return !!u && !this.auth.isAdmin() && u.id !== this.auth.user()?.id && !u.isBot;
  };

  ngOnInit() { this.load(); }

  async load() {
    this.error.set('');
    try {
      const r = await this.api.get<{ user: PublicUser; stats: UserStats; rivalry: Rivalry | null }>(`/users/${encodeURIComponent(this.username())}`);
      this.stats.set(r.stats);
      this.rivalry.set(r.rivalry);
      this.user.set(r.user);
    } catch (err) { this.error.set(apiError(err).message); }
  }

  /** Football is the headline PvP mode: pick a fixture, they get a direct challenge. */
  challengeFootball() {
    const u = this.user();
    if (!u) return;
    this.rematch.setPending({ username: u.username, avatarColor: u.avatarColor });
    this.router.navigate(['/football']);
  }
}
