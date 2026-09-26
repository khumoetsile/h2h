import { Component, DestroyRef, computed, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { ConfigStore } from '../../core/config.store';
import { FootballChallengeType, FootballFixture, MatchView, Pick as FootballPickValue, PlayerSearchResult } from '../../core/models';
import { Toast } from '../../core/toast.service';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar, LoadError, Spinner } from '../../shared/ui';

/**
 * Fixture detail + challenge builder: pick a question, pick a side, pick an
 * entry amount, then either find any opponent who picked the other side or
 * challenge one specific player. One scrollable page, one decision at a time
 * — nothing here decides the football result; that always comes from the
 * backend once the real match finishes.
 */
@Component({
  selector: 'app-football-fixture',
  imports: [FormsModule, RouterLink, MatIconModule, MatProgressSpinnerModule, MoneyPipe, Avatar, LoadError, Spinner],
  templateUrl: './football-fixture.html',
  styleUrl: './football-fixture.scss',
})
export class FootballFixturePage implements OnInit {
  readonly fixtureId = input.required<string>();
  private api = inject(Api);
  private auth = inject(AuthService);
  private router = inject(Router);
  private toast = inject(Toast);
  protected configStore = inject(ConfigStore);
  private destroyRef = inject(DestroyRef);

  protected fixture = signal<FootballFixture | null>(null);
  protected error = signal('');

  protected type = signal<FootballChallengeType | null>(null);
  protected pick = signal<FootballPickValue | null>(null);
  protected stake = signal<number | null>(null);
  protected mode = signal<'find' | 'direct' | null>(null);

  protected opponent = signal<PlayerSearchResult | null>(null);
  protected query = '';
  protected results = signal<PlayerSearchResult[]>([]);
  protected searching = signal(false);
  private search$ = new Subject<string>();

  protected message = '';
  protected busy = signal(false);
  protected formError = signal('');

  protected available = computed(() => this.auth.wallet()?.available ?? 0);
  protected closed = computed(() => {
    const f = this.fixture();
    return !!f && (f.status !== 'SCHEDULED' || new Date(f.kickoffAt) <= new Date());
  });

  protected pickLabel = computed(() => {
    const t = this.type();
    const f = this.fixture();
    const p = this.pick();
    if (!t || !f || !p) return '';
    if (t.pickType === 'TEAM') return p === 'HOME' ? f.homeTeam.name : f.awayTeam.name;
    return p === 'YES' ? 'Yes' : 'No';
  });

  protected potentialPrize = computed(() => {
    const s = this.stake();
    if (!s) return null;
    return this.configStore.config()?.stakeBreakdown.find((b) => b.stake === s)?.prize ?? null;
  });

  ngOnInit() {
    this.search$.pipe(debounceTime(250), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef)).subscribe((q) => this.doSearch(q));
    this.load();
  }

  async load() {
    this.error.set('');
    try {
      const { fixture } = await this.api.get<{ fixture: FootballFixture }>(`/football/fixtures/${this.fixtureId()}`);
      this.fixture.set(fixture);
      if (!this.stake()) {
        const stakes = fixture.stakes ?? [];
        this.stake.set(stakes.find((s) => s === 20 && s <= this.available()) ?? [...stakes].reverse().find((s) => s <= this.available()) ?? stakes[0] ?? null);
      }
      this.auth.refreshMe().catch(() => {});
    } catch (err) {
      this.error.set(apiError(err).message);
    }
  }

  chooseType(t: FootballChallengeType) {
    this.type.set(t);
    this.pick.set(null);
    this.mode.set(null);
  }

  choosePick(p: FootballPickValue) {
    this.pick.set(p);
  }

  chooseMode(m: 'find' | 'direct') {
    this.mode.set(m);
    this.formError.set('');
  }

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

  pickOpponent(u: PlayerSearchResult) {
    this.opponent.set(u);
    this.query = `@${u.username}`;
    this.results.set([]);
  }

  get readyToConfirm() {
    if (!this.type() || !this.pick() || !this.stake()) return false;
    if (this.mode() === 'direct') return !!this.opponent();
    return this.mode() === 'find';
  }

  async confirm() {
    const f = this.fixture();
    const t = this.type();
    const p = this.pick();
    const s = this.stake();
    if (!f || !t || !p || !s) return;
    this.busy.set(true);
    this.formError.set('');
    try {
      if (this.mode() === 'find') {
        const r = await this.api.post<{ matched: boolean; alreadyQueued: boolean; match: MatchView }>('/football/find', {
          fixtureId: f.id, challengeTypeSlug: t.slug, pick: p, stake: s,
        });
        if (r.matched) this.toast.success('Opponent found!');
        else if (r.alreadyQueued) this.toast.info("You're already waiting for an opponent on this pick.");
        await this.router.navigate(['/match', r.match.code]);
      } else {
        const opp = this.opponent();
        if (!opp) return;
        const { challenge } = await this.api.post<{ challenge: { opponent: { username: string } } }>('/football/challenges', {
          opponent: opp.username, fixtureId: f.id, challengeTypeSlug: t.slug, pick: p, stake: s, message: this.message || null,
        });
        this.toast.success(`Challenge sent to ${challenge.opponent.username}!`);
        await this.router.navigate(['/challenges']);
      }
    } catch (err) {
      this.formError.set(apiError(err).message);
    } finally {
      this.busy.set(false);
    }
  }

  kickoffLabel(iso: string) {
    const d = new Date(iso);
    const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return `${day}, ${time}`;
  }
}
