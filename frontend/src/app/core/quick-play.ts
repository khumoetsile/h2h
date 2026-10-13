import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { Api } from './api.service';
import { AuthService } from './auth.service';
export const MAIN_GAME = 'penalty-shootout';

/**
 * Open the game setup before holding any demo funds. New players get a guest account first.
 */
@Injectable({ providedIn: 'root' })
export class QuickPlay {
  private api = inject(Api);
  private auth = inject(AuthService);
  private router = inject(Router);

  async playNow(slug = MAIN_GAME) {
    if (!this.auth.isLoggedIn()) await this.auth.guest();
    await this.router.navigate(['/games', slug]);
  }

  /** Review the entry before creating a friend's invitation. */
  async inviteFriend(slug = MAIN_GAME) {
    if (!this.auth.isLoggedIn()) await this.auth.guest();
    await this.router.navigate(['/games', slug],{queryParams:{mode:'invite'}});
  }

  /** A friend's invite link: same idea, but the match already exists. */
  async joinInvite(code: string) {
    if (!this.auth.isLoggedIn()) await this.auth.guest();
    await this.api.post(`/matches/${code}/join`);
    await this.router.navigate(['/match', code]);
  }
}
