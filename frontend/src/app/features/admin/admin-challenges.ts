import { Component, inject, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api.service';
import { Challenge } from '../../core/models';
import { MoneyPipe } from '../../shared/pipes';
import { EmptyState, GameIcon, LoadError, SkeletonList } from '../../shared/ui';

@Component({
  selector: 'app-admin-challenges',
  imports: [DatePipe, RouterLink, MoneyPipe, EmptyState, GameIcon, LoadError, SkeletonList],
  template: `
    <div class="page">
      <div class="page-head"><div><h1>Challenges</h1><p class="sub">Direct player-to-player challenges (demo stakes)</p></div></div>
      <div class="filters">
        <div class="segmented">
          @for (s of statuses; track s) { <button [class.active]="status() === s" (click)="setStatus(s)">{{ s || 'All' }}</button> }
        </div>
      </div>
      <div class="card card-flush">
        @if (error()) { <app-load-error [message]="error()" (retry)="load()" /> }
        @else if (!items()) { <app-skeleton-list [rows]="6" /> }
        @else if (items()!.length === 0) { <app-empty icon="swords" title="No active challenges" text="No challenges match this filter." /> }
        @else {
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Challenger</th><th>Opponent</th><th>Game</th><th class="right">Stake</th><th>Status</th><th>Created</th><th>Expires</th><th>Match</th></tr></thead>
            <tbody>
              @for (c of items(); track c.id) {
                <tr>
                  <td>&#64;{{ c.challenger.username }}</td>
                  <td>&#64;{{ c.opponent.username }}</td>
                  <td><div class="row"><app-game-icon [slug]="c.game.slug" [color]="c.game.accentColor" [size]="24" />{{ c.game.name }}</div></td>
                  <td class="right money">{{ c.stake | money }}</td>
                  <td><span class="chip" [class.chip-win]="c.status === 'ACCEPTED'" [class.chip-loss]="c.status === 'DECLINED'" [class.chip-accent]="c.status === 'PENDING'">{{ c.status }}</span></td>
                  <td class="muted">{{ c.createdAt | date: 'd MMM, HH:mm' }}</td>
                  <td class="muted">{{ c.expiresAt | date: 'd MMM, HH:mm' }}</td>
                  <td>@if (c.matchCode) { <a class="link small" [routerLink]="['/matches', c.matchCode]">{{ c.matchCode }}</a> } @else { — }</td>
                </tr>
              }
            </tbody>
          </table></div>
        }
      </div>
    </div>
  `,
  styleUrl: './admin-common.scss',
})
export class AdminChallengesPage implements OnInit {
  private api = inject(Api);
  protected statuses = ['', 'PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'];
  protected status = signal('');
  protected items = signal<Challenge[] | null>(null);
  protected error = signal('');

  ngOnInit() { this.load(); }
  setStatus(s: string) { this.status.set(s); this.items.set(null); this.load(); }

  async load() {
    this.error.set('');
    try { this.items.set((await this.api.get<{ challenges: Challenge[] }>('/admin/challenges', { status: this.status() })).challenges); }
    catch { this.error.set('Could not load challenges.'); }
  }
}
