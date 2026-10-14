import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ServerClock } from '../../core/server-clock';
import { apiError } from '../../core/api-error';
import {
  FootballForecast,
  CommunityPicks,
  FreeFootballPick,
} from '../../core/football-predictions';
@Component({
  selector: 'app-football-predictions',
  imports: [DatePipe, RouterLink],
  templateUrl: './football-predictions.html',
  styleUrl: './football-predictions.scss',
})
export class FootballPredictions {
  readonly fixtureId = input.required<number>();
  private api = inject(Api);
  protected auth = inject(AuthService);
  private clock = inject(ServerClock);
  private destroy = inject(DestroyRef);
  private version = 0;
  protected data = signal<FootballForecast | null>(null);
  protected loading = signal(false);
  protected error = signal('');
  protected saveError = signal('');
  protected selected = signal<FreeFootballPick | null>(null);
  protected saving = signal(false);
  protected saved = signal(false);
  protected closed = computed(() => {
    const d = this.data();
    return !d?.open || this.clock.remainingMs(d.fixture.kickoffAt) <= 0;
  });
  protected choices: FreeFootballPick[] = ['HOME', 'DRAW', 'AWAY'];
  constructor() {
    effect(() => {
      this.fixtureId();
      this.auth.user()?.id;
      this.data.set(null);
      this.selected.set(null);
      this.saving.set(false);
      this.saved.set(false);
      this.saveError.set('');
      void this.load();
    });
    const timer = setInterval(() => {
      if (this.data()?.open && !document.hidden && !this.saving()) void this.load(false);
    }, 30000);
    this.destroy.onDestroy(() => {
      ++this.version;
      clearInterval(timer);
    });
  }
  protected label(p: FreeFootballPick) {
    const f = this.data()?.fixture;
    return p === 'DRAW'
      ? 'Draw'
      : p === 'HOME'
        ? f?.homeTeam || 'Home team'
        : f?.awayTeam || 'Away team';
  }
  async load(clear = true) {
    const v = ++this.version,
      id = this.fixtureId();
    if (clear) this.loading.set(true);
    this.error.set('');
    try {
      const d = await this.api.get<FootballForecast>(`/football/fixtures/${id}/predictions`);
      if (v !== this.version) return;
      this.data.set(d);
      if (clear || !this.selected()) this.selected.set(d.community.mine?.pick ?? null);
    } catch (err) {
      if (v === this.version) this.error.set(apiError(err).message);
    } finally {
      if (v === this.version) this.loading.set(false);
    }
  }
  protected choose(p: FreeFootballPick) {
    if (this.closed() || this.saving()) return;
    this.selected.set(p);
    this.saved.set(false);
    this.saveError.set('');
  }
  protected async save() {
    const pick = this.selected(),
      d = this.data();
    if (!pick || !d || this.closed() || this.saving()) return;
    const v = ++this.version;
    this.loading.set(false);
    this.saving.set(true);
    this.saveError.set('');
    try {
      const result = await this.api.put<{ community: CommunityPicks }>(
        `/football/fixtures/${d.fixture.id}/prediction`,
        { pick },
      );
      if (v !== this.version) return;
      this.data.set({ ...d, community: result.community });
      this.saved.set(true);
    } catch (err) {
      if (v === this.version) {
        this.saveError.set(apiError(err).message);
        if (apiError(err).code === 'PREDICTIONS_CLOSED') this.data.set({ ...d, open: false });
      }
    } finally {
      if (v === this.version) this.saving.set(false);
    }
  }
}
