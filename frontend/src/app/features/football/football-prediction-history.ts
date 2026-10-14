import { Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { apiError } from '../../core/api-error';
import {
  FreePredictionHistory,
  FreePredictionRankings,
  FreeFootballPick,
} from '../../core/football-predictions';
@Component({
  selector: 'app-football-prediction-history',
  imports: [DatePipe, RouterLink],
  template: `
    <div class="page picks-page">
      <a routerLink="/football" class="back-link">← Football</a>
      <header>
        <span class="eyebrow">NO STAKES. JUST FOOTBALL.</span>
        <h1>Your football picks</h1>
        <p>See what you picked and how you did.</p>
      </header>
      <div class="view-tabs" role="group" aria-label="Prediction views">
        <button
          [class.active]="view() === 'mine'"
          [attr.aria-pressed]="view() === 'mine'"
          (click)="view.set('mine')"
        >
          My picks</button
        ><button
          [class.active]="view() === 'rankings'"
          [attr.aria-pressed]="view() === 'rankings'"
          (click)="view.set('rankings')"
        >
          Rankings
        </button>
      </div>
      @if (error()) {
        <p role="alert">{{ error() }}</p>
        <button class="btn btn-ghost" (click)="load()">Try again</button>
      } @else if (view() === 'mine') {
        @if (!auth.isLoggedIn()) {
          <section class="card empty">
            <h2>Keep track of your predictions.</h2>
            <p>Sign in to save free picks and see your accuracy.</p>
            <a
              class="btn btn-primary"
              routerLink="/login"
              [queryParams]="{ next: '/football/predictions' }"
              >Sign in</a
            >
          </section>
        } @else if (history(); as h) {
          <div class="accuracy">
            <div>
              <strong>{{ h.summary.accuracy == null ? '—' : h.summary.accuracy + '%' }}</strong
              ><span>Accuracy</span>
            </div>
            <div>
              <strong>{{ h.summary.correct }}</strong
              ><span>Correct picks</span>
            </div>
            <div>
              <strong>{{ h.summary.settled }}</strong
              ><span>Verified results</span>
            </div>
          </div>
          <p class="muted small">
            Pending, postponed and unverified matches do not lower your accuracy.
          </p>
          <div class="history-list">
            @for (p of h.predictions; track p.id) {
              <article class="card history-row">
                <div class="row-heading">
                  <a [routerLink]="['/football', p.fixtureId]"
                    >{{ p.homeTeam }} <span class="muted">vs</span> {{ p.awayTeam }}</a
                  ><span
                    class="result-tag"
                    [class.correct]="p.correct === true"
                    [class.incorrect]="p.correct === false"
                    >{{
                      p.correct === true
                        ? 'Correct'
                        : p.correct === false
                          ? 'Incorrect'
                          : p.actualResult === 'VOID'
                            ? 'Not counted'
                            : p.status === 'POSTPONED'
                              ? 'Postponed'
                              : 'Pending'
                    }}</span
                  >
                </div>
                <div class="row-detail">
                  <span
                    >Your pick <strong>{{ label(p.pick, p) }}</strong></span
                  ><span
                    >Result
                    <strong>{{
                      p.actualResult && p.actualResult !== 'VOID' ? label(p.actualResult, p) : '—'
                    }}</strong></span
                  >
                </div>
                <small
                  >Saved {{ p.updatedAt | date: 'd MMM yyyy, HH:mm' }} · Match
                  {{ p.kickoffAt | date: 'd MMM, HH:mm' }}</small
                >
              </article>
            } @empty {
              <section class="card empty">
                <h2>Your first pick starts here.</h2>
                <p>Open an upcoming match and choose a winner or draw. It’s free.</p>
                <a class="btn btn-primary" routerLink="/football">Find a match →</a>
              </section>
            }
          </div>
          @if (h.hasMore) {
            <button class="btn btn-ghost more" [disabled]="loading()" (click)="more()">
              {{ loading() ? 'Loading…' : 'Show more picks' }}
            </button>
          }
        } @else {
          <div
            class="skeleton history-skeleton"
            role="status"
            aria-label="Loading your picks"
          ></div>
        }
      } @else {
        @if (rankings(); as r) {
          <section class="card ranking-note">
            <strong>Accuracy earns your place.</strong>
            <p>
              At least {{ r.minimum }} verified results are needed. Rankings account for sample size
              and have no link to your wallet.
            </p>
          </section>
          <div class="history-list">
            @for (u of r.rankings; track u.username) {
              <article class="card ranking-row">
                <strong class="rank">{{ u.rank }}</strong>
                <div>
                  <strong>{{ u.username }}</strong
                  ><span>{{ u.correct }} correct / {{ u.settled }} verified results</span>
                </div>
                <strong>{{ u.accuracy }}%</strong>
              </article>
            } @empty {
              <section class="card empty">
                <h2>The rankings are warming up.</h2>
                <p>Players appear after {{ r.minimum }} verified predictions.</p>
                <a class="btn btn-primary" routerLink="/football">Make a free pick →</a>
              </section>
            }
          </div>
        } @else {
          <div class="skeleton history-skeleton" role="status" aria-label="Loading rankings"></div>
        }
      }
    </div>
  `,
  styleUrl: './football-prediction-history.scss',
})
export class FootballPredictionHistoryPage {
  protected auth = inject(AuthService);
  private api = inject(Api);
  private route = inject(ActivatedRoute);
  private destroy = inject(DestroyRef);
  private version = 0;
  protected view = signal<'mine' | 'rankings'>(
    this.route.snapshot.queryParamMap.get('view') === 'rankings' ? 'rankings' : 'mine',
  );
  protected history = signal<FreePredictionHistory | null>(null);
  protected rankings = signal<FreePredictionRankings | null>(null);
  protected loading = signal(false);
  protected error = signal('');
  constructor() {
    effect(() => {
      this.auth.user()?.id;
      this.history.set(null);
      void this.load();
    });
    this.destroy.onDestroy(() => ++this.version);
  }
  async load() {
    const v = ++this.version;
    this.loading.set(true);
    this.error.set('');
    try {
      const [rankings, history] = await Promise.all([
        this.api.get<FreePredictionRankings>('/football/predictions/rankings'),
        this.auth.isLoggedIn()
          ? this.api.get<FreePredictionHistory>('/football/predictions/mine')
          : Promise.resolve(null),
      ]);
      if (v === this.version) {
        this.rankings.set(rankings);
        this.history.set(history);
      }
    } catch (err) {
      if (v === this.version) this.error.set(apiError(err).message);
    } finally {
      if (v === this.version) this.loading.set(false);
    }
  }
  protected label(p: FreeFootballPick, row: { homeTeam: string; awayTeam: string }) {
    return p === 'HOME' ? row.homeTeam : p === 'AWAY' ? row.awayTeam : 'Draw';
  }
  protected async more() {
    if (this.loading() || !this.history()) return;
    const v = this.version,
      h = this.history()!;
    this.loading.set(true);
    try {
      const next = await this.api.get<FreePredictionHistory>('/football/predictions/mine', {
        page: h.page + 1,
      });
      if (v === this.version)
        this.history.set({ ...next, predictions: [...h.predictions, ...next.predictions] });
    } catch (err) {
      if (v === this.version) this.error.set(apiError(err).message);
    } finally {
      if (v === this.version) this.loading.set(false);
    }
  }
}
