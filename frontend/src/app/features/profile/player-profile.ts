import { Component, inject, input, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { UserStats } from '../../core/models';
import { Avatar, LoadError, Spinner } from '../../shared/ui';
import { StatsPanel } from './stats-panel';

interface PublicUser { id: number; username: string; displayName: string; avatarColor: string; bio: string | null; isBot: boolean; memberSince: string; online: boolean; }

@Component({
  selector: 'app-player-profile',
  imports: [RouterLink, DatePipe, MatIconModule, Avatar, LoadError, Spinner, StatsPanel],
  template: `
    <div class="page">
      @if (error()) { <app-load-error [message]="error()" (retry)="load()" /> }
      @else if (!user()) { <app-spinner /> }
      @else {
        @let u = user()!;
        <section class="card head">
          <app-avatar [name]="u.username" [color]="u.avatarColor" [size]="72" />
          <div class="grow">
            <h1>&#64;{{ u.username }} @if (u.isBot) { <span class="chip">Demo bot</span> }</h1>
            <div class="muted">{{ u.displayName }} · Member since {{ u.memberSince | date: 'MMM y' }} @if (u.online) { · <span class="win">online</span> }</div>
            @if (u.bio) { <p class="text-2" style="margin-top:6px">{{ u.bio }}</p> }
          </div>
          @if (!auth.isAdmin() && u.id !== auth.user()?.id && !u.isBot) {
            <a class="btn btn-primary" routerLink="/challenges" [queryParams]="{ opponent: u.username }"><mat-icon>swords</mat-icon>Challenge</a>
          }
        </section>
        <app-stats-panel [stats]="stats()!" />
      }
    </div>
  `,
  styles: [`.head { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; margin-bottom: 20px; padding: 22px; .grow { flex: 1; min-width: 200px; } }`],
})
export class PlayerProfilePage implements OnInit {
  readonly username = input.required<string>();
  private api = inject(Api);
  protected auth = inject(AuthService);
  protected user = signal<PublicUser | null>(null);
  protected stats = signal<UserStats | null>(null);
  protected error = signal('');

  ngOnInit() { this.load(); }

  async load() {
    this.error.set('');
    try {
      const r = await this.api.get<{ user: PublicUser; stats: UserStats }>(`/users/${encodeURIComponent(this.username())}`);
      this.stats.set(r.stats);
      this.user.set(r.user);
    } catch (err) { this.error.set(apiError(err).message); }
  }
}
