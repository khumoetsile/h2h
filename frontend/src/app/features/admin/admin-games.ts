import { Component, inject, OnInit, signal } from '@angular/core';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { Api } from '../../core/api.service';
import { Game } from '../../core/models';
import { Toast } from '../../core/toast.service';
import { durationLabel } from '../../core/format';
import { GameIcon, LoadError, SkeletonList } from '../../shared/ui';

@Component({
  selector: 'app-admin-games',
  imports: [MatSlideToggleModule, GameIcon, LoadError, SkeletonList],
  template: `
    <div class="page page-narrow">
      <div class="page-head"><div><h1>Games</h1><p class="sub">Disabled games disappear from the catalogue and can't be matched or challenged. Matches already in progress are unaffected.</p></div></div>
      <div class="card card-flush">
        @if (error()) { <app-load-error [message]="error()" (retry)="load()" /> }
        @else if (!games()) { <app-skeleton-list [rows]="5" /> }
        @else {
          <div class="list">
            @for (g of games(); track g.id) {
              <div class="list-item">
                <app-game-icon [slug]="g.slug" [color]="g.accentColor" [size]="40" />
                <div class="grow"><strong>{{ g.name }}</strong><div class="muted small">{{ g.tagline }} · 1v1 · {{ dur(g.estimatedDurationSeconds) }}</div></div>
                <span class="chip" [class.chip-win]="g.isEnabled" [class.chip-loss]="!g.isEnabled">{{ g.isEnabled ? 'Enabled' : 'Disabled' }}</span>
                <mat-slide-toggle [checked]="g.isEnabled" [disabled]="busy() === g.id" (change)="toggle(g, $event.checked)" [attr.aria-label]="'Toggle ' + g.name" />
              </div>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: [`.grow { flex: 1; min-width: 0; }`],
})
export class AdminGamesPage implements OnInit {
  private api = inject(Api);
  private toast = inject(Toast);
  protected games = signal<Game[] | null>(null);
  protected error = signal('');
  protected busy = signal<number | null>(null);
  protected dur = durationLabel;

  ngOnInit() { this.load(); }

  async load() {
    this.error.set('');
    try { this.games.set((await this.api.get<{ games: Game[] }>('/admin/games')).games); } catch { this.error.set('Could not load games.'); }
  }

  async toggle(g: Game, enabled: boolean) {
    this.busy.set(g.id);
    try {
      const { game } = await this.api.patch<{ game: Game }>(`/admin/games/${g.id}`, { isEnabled: enabled });
      this.games.update((l) => l!.map((x) => (x.id === g.id ? game : x)));
      this.toast.success(`${g.name} ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (err) { this.toast.error(err); await this.load(); } finally { this.busy.set(null); }
  }
}
