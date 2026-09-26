import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { Game } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { MoneyPipe } from '../../shared/pipes';
import { EmptyState, GameIcon, LoadError } from '../../shared/ui';

/**
 * "Play" tab. Each game is one simple visual card: name, one plain-language
 * line, an icon, and a single Play action — no fee breakdowns, no queue
 * mechanics, no "1v1"/technical labels. Choosing a stake happens on the next
 * screen, one decision at a time.
 */
@Component({
  selector: 'app-games',
  imports: [RouterLink, MatIconModule, MoneyPipe, EmptyState, GameIcon, LoadError],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Play</h1>
          <p class="sub">Pick a game to challenge someone.</p>
        </div>
      </div>

      @if (error()) {
        <app-load-error [message]="error()" (retry)="load()" />
      } @else if (!games()) {
        <div class="games-grid">
          @for (i of [1,2,3,4,5]; track i) {
            <div class="card game-card"><div class="skeleton" style="height:48px;width:48px;border-radius:12px"></div><div class="skeleton" style="height:18px;width:50%;margin-top:18px"></div><div class="skeleton" style="height:12px;width:90%;margin-top:10px"></div></div>
          }
        </div>
      } @else if (games()!.length === 0) {
        <app-empty icon="sports_esports" title="No games available right now" text="Please check back soon." />
      } @else {
        <div class="games-grid">
          @for (g of games(); track g.id) {
            <a class="card game-card card-interactive fade-in" [routerLink]="['/games', g.slug]" [style.--gc]="g.accentColor">
              <div class="gc-top">
                <app-game-icon [slug]="g.slug" [color]="g.accentColor" [size]="52" />
                @if ((g.waiting ?? 0) > 0) { <span class="chip chip-win"><span class="live-dot"></span>{{ g.waiting }} playing now</span> }
              </div>
              <h2>{{ g.name }}</h2>
              <p class="text-2 desc">{{ g.tagline }}</p>
              <div class="gc-foot">
                <span class="from-price muted small">Entry from <strong class="money text-2">{{ g.minEntry | money }}</strong></span>
                <span class="btn btn-primary">Play<mat-icon>chevron_right</mat-icon></span>
              </div>
            </a>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .games-grid { display: grid; gap: 14px; grid-template-columns: 1fr; }
    @media (min-width: 560px) { .games-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 960px) { .games-grid { grid-template-columns: repeat(3, 1fr); } }
    .game-card { display: flex; flex-direction: column; gap: 8px; position: relative; overflow: hidden; padding: 20px; }
    .game-card::before { content: ''; position: absolute; left: 0; top: 0; right: 0; height: 3px; background: var(--gc); opacity: .8; }
    .gc-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 4px; }
    .desc { font-size: 15px; line-height: 1.4; min-height: 42px; }
    .gc-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; padding-top: 14px; border-top: 1px solid var(--border); }
    .from-price strong { font-size: 14px; }
    .live-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: blink 1.4s infinite; }
    @keyframes blink { 50% { opacity: .3; } }
  `],
})
export class GamesPage implements OnInit {
  private api = inject(Api);
  private realtime = inject(RealtimeService);
  private destroyRef = inject(DestroyRef);
  protected games = signal<Game[] | null>(null);
  protected error = signal('');

  ngOnInit() {
    this.load();
    this.realtime.queue$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      this.games.update((gs) => gs?.map((g) => ({ ...g, waiting: q[g.id]?.total ?? 0 })) ?? gs);
    });
    this.realtime.config$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load());
    this.realtime.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load());
  }

  async load() {
    this.error.set('');
    try {
      this.games.set((await this.api.get<{ games: Game[] }>('/games')).games);
    } catch {
      this.error.set("We couldn't load the games list. Please try again.");
    }
  }
}
