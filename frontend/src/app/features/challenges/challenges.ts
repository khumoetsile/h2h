import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { ConfigStore } from '../../core/config.store';
import { Challenge, Game, PlayerSearchResult } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { Toast } from '../../core/toast.service';
import { AgoPipe, MoneyPipe } from '../../shared/pipes';
import { Avatar, DemoBadge, EmptyState, GameIcon, LoadError, SkeletonList } from '../../shared/ui';

type Tab = 'incoming' | 'outgoing' | 'history';

@Component({
  selector: 'app-challenges',
  imports: [FormsModule, RouterLink, MatIconModule, MatFormFieldModule, MatInputModule, MatAutocompleteModule, MatProgressSpinnerModule,
    MoneyPipe, AgoPipe, Avatar, DemoBadge, EmptyState, GameIcon, LoadError, SkeletonList],
  templateUrl: './challenges.html',
  styleUrl: './challenges.scss',
})
export class ChallengesPage implements OnInit {
  private api = inject(Api);
  private auth = inject(AuthService);
  private toast = inject(Toast);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private realtime = inject(RealtimeService);
  protected configStore = inject(ConfigStore);
  private destroyRef = inject(DestroyRef);

  protected challenges = signal<Challenge[] | null>(null);
  protected error = signal('');
  protected tab = signal<Tab>('incoming');
  protected busy = signal<number | null>(null);

  // New challenge form
  protected games = signal<Game[]>([]);
  protected query = '';
  protected results = signal<PlayerSearchResult[]>([]);
  protected searching = signal(false);
  protected selected = signal<PlayerSearchResult | null>(null);
  protected gameId = signal<number | null>(null);
  protected stake = signal<number | null>(null);
  protected message = '';
  protected sending = signal(false);
  protected formError = signal('');
  private search$ = new Subject<string>();

  protected stakes = computed(() => this.configStore.config()?.stakeBreakdown ?? []);
  protected selectedStake = computed(() => this.stakes().find((s) => s.stake === this.stake()) ?? null);
  protected available = computed(() => this.auth.wallet()?.available ?? 0);
  protected incoming = computed(() => (this.challenges() ?? []).filter((c) => c.direction === 'INCOMING' && c.status === 'PENDING'));
  protected outgoing = computed(() => (this.challenges() ?? []).filter((c) => c.direction === 'OUTGOING' && c.status === 'PENDING'));
  protected history = computed(() => (this.challenges() ?? []).filter((c) => c.status !== 'PENDING'));
  protected visible = computed(() => ({ incoming: this.incoming(), outgoing: this.outgoing(), history: this.history() })[this.tab()]);

  ngOnInit() {
    this.load();
    this.loadGames();
    const qp = this.route.snapshot.queryParamMap;
    if (qp.get('game')) this.gameId.set(Number(qp.get('game')));
    if (qp.get('stake')) this.stake.set(Number(qp.get('stake')));
    if (qp.get('opponent')) {
      this.query = qp.get('opponent')!;
      this.api.get<{ users: PlayerSearchResult[] }>('/users/search', { q: this.query }).then((r) => {
        const exact = r.users.find((u) => u.username.toLowerCase() === this.query.toLowerCase());
        if (exact) this.pick(exact);
      }).catch(() => {});
    }
    if (!this.stake()) this.stake.set(10);

    this.search$.pipe(debounceTime(250), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef)).subscribe((q) => this.doSearch(q));
    this.realtime.challenge$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load(true));
  }

  async load(silent = false) {
    if (!silent) this.error.set('');
    try {
      const { challenges } = await this.api.get<{ challenges: Challenge[] }>('/challenges', { status: 'all' });
      this.challenges.set(challenges);
      if (!silent && this.incoming().length === 0 && this.outgoing().length > 0) this.tab.set('outgoing');
    } catch {
      if (!silent) this.error.set('Could not load challenges.');
    }
  }

  async loadGames() {
    try {
      const { games } = await this.api.get<{ games: Game[] }>('/games');
      this.games.set(games);
      if (!this.gameId() && games.length) this.gameId.set(games[0].id);
    } catch { /* form shows no games */ }
  }

  onQuery(q: string) {
    if (this.selected() && q === `@${this.selected()!.username}`) return;
    this.selected.set(null);
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

  pickByName(username: string) {
    const u = this.results().find((r) => r.username === username);
    if (u) this.pick(u);
  }

  pick(u: PlayerSearchResult) {
    this.selected.set(u);
    this.query = `@${u.username}`;
    this.results.set([]);
  }

  async send() {
    this.formError.set('');
    const opp = this.selected()?.username ?? this.query.replace(/^@/, '').trim();
    if (!opp) { this.formError.set('Search for a player to challenge.'); return; }
    if (!this.gameId()) { this.formError.set('Choose a game.'); return; }
    if (!this.stake()) { this.formError.set('Choose a stake.'); return; }
    this.sending.set(true);
    try {
      const { challenge } = await this.api.post<{ challenge: Challenge }>('/challenges', {
        opponent: opp, gameId: this.gameId(), stake: this.stake(), message: this.message || null,
      });
      this.toast.success(`Challenge sent to @${challenge.opponent.username}. Stakes lock only when they accept.`);
      this.selected.set(null);
      this.query = '';
      this.message = '';
      this.tab.set('outgoing');
      await this.load(true);
    } catch (err) {
      this.formError.set(apiError(err).message);
    } finally {
      this.sending.set(false);
    }
  }

  async accept(c: Challenge) {
    this.busy.set(c.id);
    try {
      const { match } = await this.api.post<{ match: { code: string } }>(`/challenges/${c.id}/accept`);
      this.toast.success('Challenge accepted — both stakes are locked. Get ready!');
      await this.router.navigate(['/match', match.code]);
    } catch (err) {
      this.toast.error(err);
      await this.load(true);
    } finally { this.busy.set(null); }
  }

  async decline(c: Challenge) {
    this.busy.set(c.id);
    try {
      await this.api.post(`/challenges/${c.id}/decline`);
      this.toast.info(`Declined @${c.challenger.username}'s challenge.`);
      await this.load(true);
    } catch (err) { this.toast.error(err); await this.load(true); } finally { this.busy.set(null); }
  }

  async cancel(c: Challenge) {
    this.busy.set(c.id);
    try {
      await this.api.post(`/challenges/${c.id}/cancel`);
      this.toast.info('Challenge cancelled.');
      await this.load(true);
    } catch (err) { this.toast.error(err); await this.load(true); } finally { this.busy.set(null); }
  }

  expiresIn(c: Challenge) {
    const ms = new Date(c.expiresAt).getTime() - Date.now();
    if (ms <= 0) return 'expired';
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${Math.round(m / 60)}h left` : `${m}m left`;
  }
}
