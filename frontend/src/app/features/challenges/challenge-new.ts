import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { ConfigStore } from '../../core/config.store';
import { Challenge, Game, PlayerSearchResult } from '../../core/models';
import { Toast } from '../../core/toast.service';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar, EmptyState, GameIcon, Spinner } from '../../shared/ui';

type Step = 'player' | 'game' | 'stake' | 'review';
const ORDER: Step[] = ['player', 'game', 'stake', 'review'];

/**
 * Challenge someone directly, one decision per screen:
 * Choose player → Choose game → Choose stake → Review → Send.
 * Arriving with a game/stake/opponent already decided (from a game page, a
 * player's profile, etc.) skips straight past those steps.
 */
@Component({
  selector: 'app-challenge-new',
  imports: [FormsModule, RouterLink, MatIconModule, MatProgressSpinnerModule, MoneyPipe, Avatar, EmptyState, GameIcon, Spinner],
  templateUrl: './challenge-new.html',
  styleUrl: './challenge-new.scss',
})
export class ChallengeNewPage {
  private api = inject(Api);
  private auth = inject(AuthService);
  private toast = inject(Toast);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  protected configStore = inject(ConfigStore);
  private destroyRef = inject(DestroyRef);

  protected step = signal<Step>('player');
  protected opponent = signal<PlayerSearchResult | null>(null);
  protected games = signal<Game[] | null>(null);
  protected game = signal<Game | null>(null);
  protected stake = signal<number | null>(null);
  protected message = '';

  protected query = '';
  protected results = signal<PlayerSearchResult[]>([]);
  protected searching = signal(false);
  protected sending = signal(false);
  protected formError = signal('');
  private search$ = new Subject<string>();

  protected available = computed(() => this.auth.wallet()?.available ?? 0);
  protected stakes = computed(() => this.configStore.config()?.stakeBreakdown ?? []);
  protected stepIndex = computed(() => ORDER.indexOf(this.step()));
  protected potentialPrize = computed(() => this.stakes().find((s) => s.stake === this.stake())?.prize ?? null);

  constructor() {
    this.loadGames();
    const qp = this.route.snapshot.queryParamMap;
    const gameId = qp.get('gameId') ? Number(qp.get('gameId')) : null;
    const stake = qp.get('stake') ? Number(qp.get('stake')) : null;
    const opponentName = qp.get('opponent');

    this.search$.pipe(debounceTime(250), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef)).subscribe((q) => this.doSearch(q));

    (async () => {
      if (opponentName) {
        try {
          const r = await this.api.get<{ users: PlayerSearchResult[] }>('/users/search', { q: opponentName });
          const exact = r.users.find((u) => u.username.toLowerCase() === opponentName.toLowerCase());
          if (exact) this.opponent.set(exact);
        } catch { /* they can still search manually */ }
      }
      if (gameId) {
        const games = this.games() ?? (await this.api.get<{ games: Game[] }>('/games')).games;
        this.games.set(games);
        const g = games.find((x) => x.id === gameId);
        if (g) this.game.set(g);
      }
      if (stake && this.stakes().some((s) => s.stake === stake)) this.stake.set(stake);
      this.advanceToFirstUnanswered();
    })();
  }

  private advanceToFirstUnanswered() {
    if (!this.opponent()) return this.step.set('player');
    if (!this.game()) return this.step.set('game');
    if (!this.stake()) return this.step.set('stake');
    this.step.set('review');
  }

  async loadGames() {
    try {
      const games = await this.api.get<{ games: Game[] }>('/games');
      this.games.set(games.games);
    } catch { /* game step shows its own retry via empty state */ }
  }

  // ---- Step 1: player --------------------------------------------------
  onQuery(q: string) {
    if (this.opponent() && q === `@${this.opponent()!.username}`) return;
    this.opponent.set(null);
    this.search$.next(q.trim());
  }

  private async doSearch(q: string) {
    if (!q) { this.results.set([]); return; }
    this.searching.set(true);
    try {
      this.results.set((await this.api.get<{ users: PlayerSearchResult[] }>('/users/search', { q })).users);
    } catch { this.results.set([]); }
    this.searching.set(false);
  }

  pick(u: PlayerSearchResult) {
    this.opponent.set(u);
    this.query = `@${u.username}`;
    this.results.set([]);
    this.goTo('game');
  }

  // ---- Step 2: game ------------------------------------------------------
  pickGame(g: Game) {
    this.game.set(g);
    this.goTo('stake');
  }

  // ---- Step 3: stake -------------------------------------------------------
  pickStake(s: number) {
    this.stake.set(s);
    this.goTo('review');
  }

  // ---- Navigation ----------------------------------------------------------
  goTo(s: Step) { this.formError.set(''); this.step.set(s); }

  back() {
    const i = this.stepIndex();
    if (i <= 0) { this.router.navigateByUrl('/challenges'); return; }
    this.step.set(ORDER[i - 1]);
  }

  // ---- Step 4: send -------------------------------------------------------
  async send() {
    const opp = this.opponent();
    const g = this.game();
    const s = this.stake();
    if (!opp || !g || !s) return;
    this.sending.set(true);
    this.formError.set('');
    try {
      const { challenge } = await this.api.post<{ challenge: Challenge }>('/challenges', {
        opponent: opp.username, gameId: g.id, stake: s, message: this.message || null,
      });
      this.toast.success(`Challenge sent to ${challenge.opponent.username}!`);
      await this.router.navigate(['/challenges']);
    } catch (err) {
      this.formError.set(apiError(err).message);
    } finally {
      this.sending.set(false);
    }
  }
}
