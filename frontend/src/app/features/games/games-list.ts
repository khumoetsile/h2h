import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { Game } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { durationLabel } from '../../core/format';
import { MoneyPipe } from '../../shared/pipes';
import { DemoBadge, EmptyState, GameIcon, LoadError } from '../../shared/ui';

@Component({
  selector: 'app-games',
  imports: [RouterLink, MatIconModule, MoneyPipe, DemoBadge, EmptyState, GameIcon, LoadError],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Games</h1>
          <p class="sub">Every game is 1v1 and skill-based. Both players get the identical challenge.</p>
        </div>
        <app-demo-badge label="Stakes use demo funds" size="lg" />
      </div>

      @if (error()) {
        <app-load-error [message]="error()" (retry)="load()" />
      } @else if (!games()) {
        <div class="games-grid">
          @for (i of [1,2,3,4,5]; track i) {
            <div class="card game-card"><div class="skeleton" style="height:48px;width:48px"></div><div class="skeleton" style="height:18px;width:50%;margin-top:18px"></div><div class="skeleton" style="height:12px;width:90%;margin-top:10px"></div><div class="skeleton" style="height:12px;width:70%;margin-top:6px"></div></div>
          }
        </div>
      } @else if (games()!.length === 0) {
        <app-empty icon="sports_esports" title="No games available" text="All games are temporarily disabled. Please check back soon." />
      } @else {
        <div class="games-grid">
          @for (g of games(); track g.id) {
            <a class="card game-card card-interactive fade-in" [routerLink]="['/games', g.slug]" [style.--gc]="g.accentColor">
              <div class="gc-top">
                <app-game-icon [slug]="g.slug" [color]="g.accentColor" [size]="48" />
                <div class="gc-tags">
                  <span class="chip">1v1</span>
                  @if ((g.waiting ?? 0) > 0) { <span class="chip chip-win"><span class="live-dot"></span>{{ g.waiting }} waiting</span> }
                  @else { <span class="chip">0 waiting</span> }
                </div>
              </div>
              <h2>{{ g.name }}</h2>
              <p class="text-2 small desc">{{ g.description }}</p>
              <div class="gc-stats">
                <div><span class="muted tiny">ENTRY</span><strong class="money">from {{ g.minEntry | money }}</strong></div>
                <div><span class="muted tiny">PRIZE</span><strong class="money accent">up to {{ g.maxPrize | money }}</strong></div>
                <div><span class="muted tiny">DURATION</span><strong>{{ duration(g.estimatedDurationSeconds) }}</strong></div>
              </div>
              <div class="gc-foot">
                <span class="btn btn-primary btn-block">Play {{ g.name }}</span>
              </div>
            </a>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .games-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
    .game-card { display: flex; flex-direction: column; gap: 10px; position: relative; overflow: hidden; padding: 20px; }
    .game-card::before { content: ''; position: absolute; left: 0; top: 0; right: 0; height: 2px; background: var(--gc); opacity: .7; }
    .gc-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px; }
    .gc-tags { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .desc { min-height: 60px; }
    .gc-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 12px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); margin-top: 4px;
      div { display: flex; flex-direction: column; gap: 2px; } strong { font-size: 14px; } }
    .gc-foot { margin-top: 6px; }
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
  protected duration = durationLabel;

  ngOnInit() {
    this.load();
    this.realtime.queue$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      this.games.update((gs) => gs?.map((g) => ({ ...g, waiting: q[g.id]?.total ?? 0 })) ?? gs);
    });
    this.realtime.config$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load());
  }

  async load() {
    this.error.set('');
    try {
      this.games.set((await this.api.get<{ games: Game[] }>('/games')).games);
    } catch {
      this.error.set('Could not load the game catalogue.');
    }
  }
}
