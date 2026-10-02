import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { Api } from './api.service';
import { AuthService } from './auth.service';
import { Game, MatchView } from './models';

const DEFAULT_STAKE = 10;
export const MAIN_GAME = 'penalty-shootout';

/**
 * The one-tap path into a match: make a guest account if the person has none, pick the usual entry for the game,
 * look for an opponent and go to the match room. The room brings in a practice opponent if nobody is free.
 */
@Injectable({ providedIn: 'root' })
export class QuickPlay {
  private api = inject(Api);
  private auth = inject(AuthService);
  private router = inject(Router);

  async playNow(slug = MAIN_GAME) {
    if (!this.auth.isLoggedIn()) await this.auth.guest();
    const { game } = await this.api.get<{ game: Game }>(`/games/${slug}`);
    const stakes = game.stakes ?? [];
    const balance = this.auth.wallet()?.available ?? 0;
    const stake = stakes.find((s) => s.stake === DEFAULT_STAKE && s.stake <= balance) ?? stakes.find((s) => s.stake <= balance) ?? stakes[0];
    if (!stake) throw new Error('This game is not available right now.');
    const r = await this.api.post<{ match: MatchView }>('/matches/find', { gameId: game.id, stake: stake.stake });
    await this.router.navigate(['/match', r.match.code]);
  }

  /** A friend's invite link: same idea, but the match already exists. */
  async joinInvite(code: string) {
    if (!this.auth.isLoggedIn()) await this.auth.guest();
    await this.api.post(`/matches/${code}/join`);
    await this.router.navigate(['/match', code]);
  }
}
