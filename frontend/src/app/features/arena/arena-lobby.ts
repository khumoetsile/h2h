import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { RealtimeService } from '../../core/realtime.service';
import { Arena } from '../../core/fantasy-arena';
import { apiError } from '../../core/api-error';
import { MoneyPipe } from '../../shared/pipes';
import { Countdown } from '../../shared/countdown';
@Component({
  selector: 'app-arena-lobby',
  imports: [RouterLink, DatePipe, MoneyPipe, Countdown],
  template: ` <div class="page arena-page">
    <header class="arena-hero">
      <span class="eyebrow">ONE SLIP. EVERYONE PLAYS.</span>
      <h1>Fantasy Arena</h1>
      <p>Big teams. One shared slip. New competitions selected automatically.</p>
      <span class="status">Demo money only</span>
      @if (auth.isAdmin()) {
        <a class="btn btn-ghost" routerLink="/admin/arenas">Manage arenas →</a>
      }
    </header>
    <nav class="tabs" aria-label="Arena views">
      @for (s of sections; track s.key) {
        <button
          [class.active]="section() === s.key"
          [attr.aria-pressed]="section() === s.key"
          (click)="change(s.key)"
        >
          {{ s.label }}
        </button>
      }
    </nav>
    @if (error()) {
      <div class="error" role="alert">
        {{ error() }} <button class="btn btn-ghost" (click)="load(true)">Try again</button>
      </div>
    }
    @if (section() === 'mine' && !auth.isLoggedIn()) {
      <section class="arena-panel empty">
        <h2>Your competitions live here.</h2>
        <a class="btn btn-primary" routerLink="/login" [queryParams]="{ next: '/arena' }"
          >Sign in to see your arenas</a
        >
      </section>
    } @else if (loading() && !arenas()) {
      <div class="arena-grid" role="status" aria-label="Loading arenas">
        <div class="skeleton"></div>
        <div class="skeleton"></div>
      </div>
    } @else if (arenas(); as list) {
      <div class="arena-grid">
        @for (a of list; track a.id) {
          <article class="arena-card">
            <div class="card-head">
              <h2>{{ a.name }}</h2>
              <span class="status">{{
                a.status === 'OPEN'
                  ? 'Open'
                  : a.status === 'COMPLETED'
                    ? 'Finished'
                    : a.status === 'CANCELLED'
                      ? 'Cancelled'
                      : 'Live'
              }}</span>
            </div>
            <p>
              {{ a.fixtureCount }} matches · {{ a.participants }}
              {{ a.participants === 1 ? 'player' : 'players' }}
            </p>
            <div class="pool">{{ a.prizePool | money }}</div>
            <span class="subtle"
              >{{ a.status === 'OPEN' ? 'Growing prize pool' : 'Final prize pool' }} · Demo
              BWP</span
            >
            <div class="prizes">
              @for (p of a.prizes; track $index) {
                <div>
                  <span>{{ $index === 0 ? '1st' : $index === 1 ? '2nd' : '3rd' }}</span
                  ><strong>{{ p | money }}</strong>
                </div>
              }
            </div>
            <p class="subtle">
              {{
                a.status === 'OPEN'
                  ? 'Projected payouts. More players, bigger pool.'
                  : 'Tied players share the affected prize positions.'
              }}
            </p>
            <div class="card-head">
              <strong>{{ a.entryFee | money }} demo entry</strong>
              @if (a.status === 'OPEN') {
                <span
                  >Closes in <app-countdown [deadline]="a.deadline" (expired)="load(true)"
                /></span>
              } @else {
                <span>{{ a.deadline | date: 'd MMM, HH:mm' }}</span>
              }
            </div>
            <a class="btn btn-primary" [routerLink]="['/arena', a.id]"
              >{{
                a.mine
                  ? 'View my arena'
                  : a.status === 'OPEN'
                    ? 'Choose my predictions'
                    : 'View arena'
              }}
              →</a
            >
          </article>
        } @empty {
          <section class="arena-panel empty">
            <h2>
              {{
                section() === 'mine'
                  ? 'You haven’t entered an arena yet.'
                  : 'No ' +
                    (section() === 'open' ? 'open' : section() === 'live' ? 'live' : 'finished') +
                    ' arenas yet.'
              }}
            </h2>
            <p>
              {{
                section() === 'open'
                  ? 'We automatically select upcoming matches featuring major clubs. Check back when the next fixtures are available.'
                  : 'Browse open arenas to find your next competition.'
              }}
            </p>
            @if (section() !== 'open') {
              <button class="btn btn-primary" (click)="change('open')">See open arenas</button>
            }
          </section>
        }
      </div>
      @if (hasMore()) {
        <button class="more" [disabled]="loading()" (click)="more()">Load more arenas</button>
      }
    }
    <details class="arena-panel rules">
      <summary>How it works</summary>
      <p>
        Everyone gets the same matches and predicts the named team’s result. One correct pick = one
        point. Entry fees grow the demo prize pool.
      </p>
      <p>
        At least three players are needed. Entries and changes close at the first kickoff. If fewer
        than three join, everyone gets a full refund.
      </p>
      <p>
        Tied players share the prizes for the places they occupy. No odds or real-money payments.
      </p>
    </details>
  </div>`,
  styleUrl: './arena.scss',
})
export class ArenaLobbyPage {
  protected auth = inject(AuthService);
  private api = inject(Api);
  private realtime = inject(RealtimeService);
  private destroy = inject(DestroyRef);
  private version = 0;
  private page = 1;
  private identity = computed(() => this.auth.user()?.id ?? null);
  protected arenas = signal<Arena[] | null>(null);
  protected section = signal('open');
  protected loading = signal(false);
  protected error = signal('');
  protected hasMore = signal(false);
  protected sections = [
    { key: 'open', label: 'Open' },
    { key: 'live', label: 'Live' },
    { key: 'completed', label: 'Finished' },
    { key: 'mine', label: 'My arenas' },
  ];
  constructor() {
    effect(() => {
      this.identity();
      this.arenas.set(null);
      this.page = 1;
      void this.load(true);
    });
    this.realtime.arena$.pipe(takeUntilDestroyed(this.destroy)).subscribe((e) => {
      if (e.arena && this.arenas()?.some((a) => a.id === e.arenaId)) {
        this.arenas.update((list) =>
          list!.map((a) =>
            a.id === e.arenaId && a.status === 'OPEN' && e.arena!.participants >= a.participants
              ? { ...e.arena!, mine: a.mine }
              : a,
          ),
        );
        return;
      }
      if (!document.hidden && !this.loading()) void this.load(true);
    });
    const t = setInterval(() => {
      if (!document.hidden && !this.loading() && this.page === 1) void this.load(true);
    }, 20000);
    this.destroy.onDestroy(() => {
      ++this.version;
      clearInterval(t);
    });
  }
  protected change(s: string) {
    this.section.set(s);
    this.arenas.set(null);
    this.page = 1;
    void this.load(true);
  }
  async load(reset = false) {
    const v = ++this.version;
    if (reset) this.page = 1;
    this.loading.set(true);
    this.error.set('');
    try {
      const r = await this.api.get<{ arenas: Arena[]; hasMore: boolean }>('/arenas', {
        section: this.section(),
        page: this.page,
      });
      if (v === this.version) {
        this.arenas.set(reset ? r.arenas : [...(this.arenas() || []), ...r.arenas]);
        this.hasMore.set(r.hasMore);
      }
    } catch (e) {
      if (v === this.version) this.error.set(apiError(e).message);
    } finally {
      if (v === this.version) this.loading.set(false);
    }
  }
  protected more() {
    this.page++;
    void this.load();
  }
}
