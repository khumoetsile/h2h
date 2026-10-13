import { Injectable, inject } from '@angular/core';
import { Api } from './api.service';
import { Game } from './models';
import { isLiveGame } from './featured';

/** Cache the public catalogue, never wallet or match state. */
@Injectable({providedIn:'root'})
export class GameCatalogue {
  private api = inject(Api);
  private cached: Game[] | null = null;
  private expiresAt = 0;
  private pending: Promise<Game[]> | null = null;
  load() {
    if (this.cached && this.expiresAt > Date.now()) return Promise.resolve(this.cached);
    if (this.pending) return this.pending;
    this.pending = this.api.get<{games:Game[]}>('/game-catalogue').then(({games}) => {
      this.cached = games; this.expiresAt = Date.now() + 30000; return games;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}

/** Preserve rotation during background refreshes. Chess is supplied separately and always stays present. */
export function discoveryGames(games: Game[], previous: string[] = [], random = Math.random): Game[] {
  const pool = games.filter(g => isLiveGame(g.slug) && g.isEnabled !== false);
  const kept = previous.map(slug => pool.find(g => g.slug === slug)).filter((g):g is Game => !!g);
  if (kept.length === Math.min(2,pool.length)) return kept;
  const shuffled = [...pool];
  for (let i=shuffled.length-1;i>0;i--) { const j=Math.floor(random()*(i+1)); [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]]; }
  return shuffled.slice(0,2);
}
