import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { RealtimeService } from '../../core/realtime.service';
import { ServerClock } from '../../core/server-clock';
import {
  ArenaDetail,
  ArenaLeaderboard,
  ArenaPick,
  ArenaPrediction,
  ArenaRanking,
} from '../../core/fantasy-arena';
import { apiError } from '../../core/api-error';
import { MoneyPipe } from '../../shared/pipes';
import { Countdown } from '../../shared/countdown';
@Component({
  selector: 'app-arena-detail',
  imports: [RouterLink, DatePipe, JsonPipe, FormsModule, MoneyPipe, Countdown],
  templateUrl: './arena-detail.html',
  styleUrl: './arena.scss',
})
export class ArenaDetailPage {
  protected auth = inject(AuthService);
  private api = inject(Api);
  private route = inject(ActivatedRoute);
  private realtime = inject(RealtimeService);
  private clock = inject(ServerClock);
  private destroy = inject(DestroyRef);
  private version = 0;
  private id = 0;
  private identity = computed(() => this.auth.user()?.id ?? null);
  protected adminMode = this.route.snapshot.data['arenaAdmin'] === true;
  private base = this.adminMode ? '/admin/arenas' : '/arenas';
  protected data = signal<ArenaDetail | null>(null);
  protected board = signal<ArenaLeaderboard | null>(null);
  protected picks = signal<Record<number, ArenaPick>>({});
  protected loading = signal(false);
  protected busy = signal(false);
  protected error = signal('');
  protected actionError = signal('');
  protected saved = signal(false);
  protected selectedSlip = signal<{ username: string; picks: Record<number, ArenaPick> } | null>(
    null,
  );
  protected cancelReason = '';
  protected choices: Array<{ value: ArenaPick; label: string }> = [
    { value: 'WIN', label: 'Win' },
    { value: 'DRAW', label: 'Draw' },
    { value: 'LOSS', label: 'Loss' },
  ];
  protected closed = computed(() => {
    const d = this.data();
    return !d || d.arena.status !== 'OPEN' || this.clock.remainingMs(d.arena.deadline) <= 0;
  });
  protected complete = computed(() => {
    const d = this.data();
    return !!d && d.fixtures.every((f) => !!this.picks()[f.id]);
  });
  protected progress = computed(
    () => this.data()?.fixtures.filter((f) => !!this.picks()[f.id]).length || 0,
  );
  protected insufficient = computed(
    () =>
      !this.data()?.myEntry &&
      (this.auth.wallet()?.available ?? 0) < (this.data()?.arena.entryFee ?? 0),
  );
  protected dirty = computed(() => {
    const d = this.data();
    return (
      !!d?.myEntry && d.myEntry.predictions.some((p) => this.picks()[p.arenaFixtureId] !== p.pick)
    );
  });
  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroy)).subscribe((p) => {
      this.id = Number(p.get('id'));
      this.reset();
    });
    effect(() => {
      this.identity();
      this.reset();
    });
    this.realtime.arena$.pipe(takeUntilDestroyed(this.destroy)).subscribe((e) => {
      const current = this.data();
      if (
        e.arenaId === this.id &&
        e.arena &&
        current?.arena.status === 'OPEN' &&
        e.arena.status === 'OPEN' &&
        e.arena.participants >= current.arena.participants
      ) {
        this.data.set({ ...current, arena: { ...e.arena, mine: current.arena.mine } });
        return;
      }
      if (e.arenaId === this.id && !this.busy() && !document.hidden) void this.load();
    });
    const t = setInterval(() => {
      if (!document.hidden && !this.busy() && !this.loading()) void this.load();
    }, 15000);
    this.destroy.onDestroy(() => {
      ++this.version;
      clearInterval(t);
    });
  }
  private reset() {
    ++this.version;
    this.data.set(null);
    this.picks.set({});
    this.board.set(null);
    this.selectedSlip.set(null);
    this.busy.set(false);
    if (this.id) void this.load(true);
  }
  async load(reset = false) {
    const v = ++this.version;
    this.loading.set(true);
    this.error.set('');
    try {
      const d = await this.api.get<ArenaDetail>(`${this.base}/${this.id}`),
        b = await this.api.get<ArenaLeaderboard>(`${this.base}/${this.id}/leaderboard`, {
          page: reset ? 1 : this.board()?.page || 1,
        });
      if (v !== this.version) return;
      const previousStatus = this.data()?.arena.status;
      this.data.set(d);
      this.board.set(b);
      if (reset || !Object.keys(this.picks()).length)
        this.picks.set(
          Object.fromEntries((d.myEntry?.predictions || []).map((p) => [p.arenaFixtureId, p.pick])),
        );
      if (this.auth.isLoggedIn() && (reset || previousStatus !== d.arena.status))
        void this.auth.refreshMe().catch(() => {});
    } catch (e) {
      if (v === this.version) this.error.set(apiError(e).message);
    } finally {
      if (v === this.version) this.loading.set(false);
    }
  }
  protected choose(id: number, p: ArenaPick) {
    if (
      this.closed() ||
      this.busy() ||
      this.adminMode ||
      !this.auth.isLoggedIn() ||
      this.auth.isAdmin()
    )
      return;
    this.picks.update((v) => ({ ...v, [id]: p }));
    this.saved.set(false);
    this.actionError.set('');
  }
  protected async confirm() {
    const d = this.data();
    if (!d || !this.complete() || this.closed() || this.busy()) return;
    const v = ++this.version;
    this.busy.set(true);
    this.actionError.set('');
    const predictions: ArenaPrediction[] = d.fixtures.map((f) => ({
      arenaFixtureId: f.id,
      pick: this.picks()[f.id],
    }));
    try {
      if (d.myEntry) await this.api.put(`/arenas/${this.id}/entry`, { predictions });
      else await this.api.post(`/arenas/${this.id}/entry`, { predictions });
      if (v !== this.version) return;
      this.saved.set(true);
      await this.load(true);
    } catch (e) {
      if (v === this.version) {
        this.actionError.set(apiError(e).message);
        if (apiError(e).code === 'ARENA_CLOSED') await this.load(true);
      }
    } finally {
      if (v === this.version || !this.loading()) this.busy.set(false);
    }
  }
  protected async more(delta = 1) {
    const b = this.board();
    if (!b || this.loading()) return;
    const v = this.version;
    this.loading.set(true);
    try {
      const next = await this.api.get<ArenaLeaderboard>(`${this.base}/${this.id}/leaderboard`, {
        page: b.page + delta,
      });
      if (v === this.version) this.board.set(next);
    } catch (e) {
      this.actionError.set(apiError(e).message);
    } finally {
      if (v === this.version) this.loading.set(false);
    }
  }
  protected async reveal(row: ArenaRanking) {
    const v = this.version;
    this.actionError.set('');
    try {
      const r = await this.api.get<{ predictions: ArenaPrediction[] }>(
        `${this.base}/${this.id}/entries/${row.entryId}`,
      );
      if (v !== this.version) return;
      this.selectedSlip.set({
        username: row.username,
        picks: Object.fromEntries(r.predictions.map((p) => [p.arenaFixtureId, p.pick])),
      });
    } catch (e) {
      this.actionError.set(apiError(e).message);
    }
  }
  protected async adminAction(action: 'publish' | 'cancel') {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set('');
    try {
      await this.api.post(
        `/admin/arenas/${this.id}/${action}`,
        action === 'cancel' ? { reason: this.cancelReason } : {},
      );
      await this.load(true);
    } catch (e) {
      this.actionError.set(apiError(e).message);
    } finally {
      this.busy.set(false);
    }
  }
  protected pickLabel(p: ArenaPick | 'VOID' | null | undefined) {
    return p === 'WIN'
      ? 'Win'
      : p === 'DRAW'
        ? 'Draw'
        : p === 'LOSS'
          ? 'Loss'
          : p === 'VOID'
            ? 'Void'
            : 'Pending';
  }
}
