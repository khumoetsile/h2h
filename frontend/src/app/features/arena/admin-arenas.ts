import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api } from '../../core/api.service';
import { Arena, ArenaDetail, ArenaFixtureOption } from '../../core/fantasy-arena';
import { apiError } from '../../core/api-error';
import { MoneyPipe } from '../../shared/pipes';
@Component({
  selector: 'app-admin-arenas',
  imports: [FormsModule, DatePipe, RouterLink, MoneyPipe],
  template: `<div class="page arena-page">
    <header class="arena-hero">
      <span class="eyebrow">PLATFORM COMPETITIONS</span>
      <h1>Fantasy Arena</h1>
      <p>Create a shared slip using real upcoming matches. Published rules cannot be edited.</p>
      <a class="btn btn-ghost" routerLink="/arena">Public lobby →</a>
    </header>
    @if (error()) {
      <div class="error" role="alert">{{ error() }}</div>
    }
    <details class="arena-panel" [open]="editing() || showForm()">
      <summary>Create or edit an arena</summary>
      <form class="admin-form" (ngSubmit)="save()">
        <label
          >Arena name<input
            name="arenaName"
            [(ngModel)]="name"
            required
            minlength="3"
            maxlength="100" /></label
        ><label
          >Description (optional)<textarea
            name="arenaDescription"
            [(ngModel)]="description"
            maxlength="500"
            rows="2"
          ></textarea>
        </label>
        <div class="field-grid">
          <label
            >Entry fee · demo BWP<input
              name="arenaEntryFee"
              type="number"
              min="0.01"
              step="0.01"
              [(ngModel)]="entryFee"
              required /></label
          ><label
            >Platform fee · %<input
              name="arenaFee"
              type="number"
              min="0"
              max="100"
              step="0.01"
              [(ngModel)]="feePercent"
              required
          /></label>
          <div>
            <span class="subtle">Minimum players</span>
            <p><strong>3</strong> · fewer means a full refund.</p>
          </div>
        </div>
        <div class="field-grid">
          <label
            >First place · %<input
              name="arenaFirst"
              type="number"
              min="0"
              max="100"
              step="0.01"
              [(ngModel)]="first"
              required /></label
          ><label
            >Second place · %<input
              name="arenaSecond"
              type="number"
              min="0"
              max="100"
              step="0.01"
              [(ngModel)]="second"
              required /></label
          ><label
            >Third place · %<input
              name="arenaThird"
              type="number"
              min="0"
              max="100"
              step="0.01"
              [(ngModel)]="third"
              required
          /></label>
        </div>
        <p class="subtle">Total must be 100%. Ties share the affected prize positions.</p>
        <div class="card-head">
          <h2>Shared fixtures · {{ selected().length }} selected</h2>
          <button
            class="btn btn-ghost"
            type="button"
            [disabled]="fixtures().length < 5"
            (click)="nextFive()"
          >
            Use next 5 matches
          </button>
        </div>
        <p class="subtle">
          Start with five or choose another number. Everyone predicts the same reference team.
        </p>
        @for (f of selected(); track f.id) {
          <div class="ordered-fixture">
            <strong>{{ $index + 1 }}. {{ f.homeTeam }} vs {{ f.awayTeam }}</strong
            ><label
              >Reference team<select
                [name]="'arenaReference' + f.id"
                [ngModel]="f.referenceTeamId || f.homeTeamId"
                (ngModelChange)="reference(f.id, $event)"
              >
                <option [ngValue]="f.homeTeamId">{{ f.homeTeam }}</option>
                <option [ngValue]="f.awayTeamId">{{ f.awayTeam }}</option>
              </select></label
            >
            <div class="actions">
              <button
                type="button"
                [disabled]="$index === 0"
                (click)="move($index, -1)"
                [attr.aria-label]="'Move ' + f.homeTeam + ' match earlier'"
              >
                ↑</button
              ><button
                type="button"
                [disabled]="$index === selected().length - 1"
                (click)="move($index, 1)"
                [attr.aria-label]="'Move ' + f.homeTeam + ' match later'"
              >
                ↓</button
              ><button
                type="button"
                (click)="toggle(f)"
                [attr.aria-label]="'Remove ' + f.homeTeam + ' match'"
              >
                Remove
              </button>
            </div>
          </div>
        }
        <label
          >Search real upcoming matches<input
            name="arenaFixtureSearch"
            type="search"
            [(ngModel)]="search"
            (ngModelChange)="scheduleSearch()"
            placeholder="Team or competition"
        /></label>
        @if (fixtureLoading()) {
          <p role="status">Finding upcoming matches…</p>
        }
        @for (f of fixtures(); track f.id) {
          <div class="fixture-choice">
            <label
              ><input type="checkbox" [checked]="has(f.id)" (change)="toggle(f)" /><strong
                >{{ f.homeTeam }} vs {{ f.awayTeam }}</strong
              ></label
            ><span class="subtle"
              >{{ f.competition }} · {{ f.kickoffAt | date: 'EEE d MMM, HH:mm' }}</span
            >
          </div>
        } @empty {
          @if (!fixtureLoading()) {
            <p>
              No matching upcoming real fixtures. Check the football provider or try another search.
            </p>
          }
        }
        <div class="actions">
          <button
            type="submit"
            class="btn btn-primary"
            [disabled]="busy() || !selected().length || name.trim().length < 3 || total() !== 10000"
          >
            {{ busy() ? 'Saving…' : editing() ? 'Save draft' : 'Create draft' }}
          </button>
          @if (editing()) {
            <button type="button" class="btn btn-ghost" (click)="reset()">New arena instead</button>
          }
        </div>
      </form>
    </details>
    <h2>All arenas</h2>
    <div class="arena-grid">
      @for (a of arenas(); track a.id) {
        <article class="arena-card">
          <div class="card-head">
            <h2>{{ a.name }}</h2>
            <span class="status">{{ a.status }}</span>
          </div>
          <p>{{ a.fixtureCount }} fixtures · {{ a.participants }} confirmed players</p>
          <strong>{{ a.entryFee | money }} demo entry · {{ a.prizePool | money }} pool</strong
          ><a class="btn btn-primary" [routerLink]="['/admin/arenas', a.id]"
            >Review {{ a.status === 'DRAFT' ? '& publish' : 'arena' }} →</a
          >
        </article>
      } @empty {
        <section class="arena-panel empty">
          <h2>Create your first arena.</h2>
          <p>Choose real fixtures, then review and publish.</p>
        </section>
      }
    </div>
    @if (hasMore()) {
      <button class="more" [disabled]="busy()" (click)="more()">More arenas</button>
    }
  </div>`,
  styleUrl: './arena.scss',
})
export class AdminArenasPage {
  private api = inject(Api);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private searchVersion = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private page = 1;
  protected arenas = signal<Arena[]>([]);
  protected fixtures = signal<ArenaFixtureOption[]>([]);
  protected selected = signal<ArenaFixtureOption[]>([]);
  protected editing = signal<number | null>(null);
  protected showForm = signal(false);
  protected fixtureLoading = signal(false);
  protected busy = signal(false);
  protected error = signal('');
  protected hasMore = signal(false);
  protected name = '';
  protected description = '';
  protected entryFee = 20;
  protected feePercent = 10;
  protected first = 50;
  protected second = 30;
  protected third = 20;
  protected search = '';
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      ++this.searchVersion;
      if (this.timer) clearTimeout(this.timer);
    });
    void this.load();
    void this.searchFixtures();
    const edit = Number(this.route.snapshot.queryParamMap.get('edit'));
    if (edit) void this.edit(edit);
  }
  protected total() {
    return (
      Math.round(this.first * 100) + Math.round(this.second * 100) + Math.round(this.third * 100)
    );
  }
  async load(more = false) {
    try {
      const r = await this.api.get<{ arenas: Arena[]; hasMore: boolean }>('/admin/arenas', {
        page: this.page,
      });
      this.arenas.set(more ? [...this.arenas(), ...r.arenas] : r.arenas);
      this.hasMore.set(r.hasMore);
    } catch (e) {
      this.error.set(apiError(e).message);
    }
  }
  protected async more() {
    this.page++;
    await this.load(true);
  }
  protected scheduleSearch() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.searchFixtures(), 250);
  }
  protected async searchFixtures() {
    const v = ++this.searchVersion;
    this.fixtureLoading.set(true);
    try {
      const r = await this.api.get<{ fixtures: ArenaFixtureOption[] }>('/admin/arenas/fixtures', {
        q: this.search,
      });
      if (v === this.searchVersion) this.fixtures.set(r.fixtures);
    } catch (e) {
      if (v === this.searchVersion) this.error.set(apiError(e).message);
    } finally {
      if (v === this.searchVersion) this.fixtureLoading.set(false);
    }
  }
  protected has(id: number) {
    return this.selected().some((f) => f.id === id);
  }
  protected toggle(f: ArenaFixtureOption) {
    this.selected.update((s) =>
      this.has(f.id)
        ? s.filter((e) => e.id !== f.id)
        : [...s, { ...f, referenceTeamId: f.referenceTeamId || f.homeTeamId }],
    );
  }
  protected nextFive() {
    this.selected.set(
      this.fixtures()
        .slice(0, 5)
        .map((f) => ({ ...f, referenceTeamId: f.homeTeamId })),
    );
  }
  protected reference(id: number, team: number) {
    this.selected.update((s) =>
      s.map((f) => (f.id === id ? { ...f, referenceTeamId: Number(team) } : f)),
    );
  }
  protected move(index: number, delta: number) {
    this.selected.update((s) => {
      const r = s.slice();
      [r[index], r[index + delta]] = [r[index + delta], r[index]];
      return r;
    });
  }
  protected reset() {
    this.editing.set(null);
    this.name = '';
    this.description = '';
    this.entryFee = 20;
    this.feePercent = 10;
    this.first = 50;
    this.second = 30;
    this.third = 20;
    this.selected.set([]);
    this.showForm.set(true);
  }
  protected async edit(id: number) {
    try {
      const d = await this.api.get<ArenaDetail>(`/admin/arenas/${id}`);
      if (d.arena.status !== 'DRAFT') {
        this.error.set('Only drafts can be edited.');
        return;
      }
      this.editing.set(id);
      this.name = d.arena.name;
      this.description = d.arena.description || '';
      this.entryFee = d.arena.entryFee;
      this.feePercent = d.arena.feePercent;
      [this.first, this.second, this.third] = d.arena.prizePercentages;
      this.selected.set(
        d.fixtures.map((f) => ({
          id: f.fixtureId,
          homeTeamId: f.homeTeamId,
          awayTeamId: f.awayTeamId,
          homeTeam: f.homeTeam,
          awayTeam: f.awayTeam,
          competition: f.competition,
          kickoffAt: f.kickoffAt,
          referenceTeamId: f.referenceTeamId,
        })),
      );
    } catch (e) {
      this.error.set(apiError(e).message);
    }
  }
  protected async save() {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const body = {
      name: this.name,
      description: this.description,
      entryFee: this.entryFee,
      feePercent: this.feePercent,
      prizePercentages: [this.first, this.second, this.third],
      fixtures: this.selected().map((f) => ({
        fixtureId: f.id,
        referenceTeamId: f.referenceTeamId,
      })),
    };
    try {
      const r = this.editing()
        ? await this.api.patch<{ id: number }>(`/admin/arenas/${this.editing()}`, body)
        : await this.api.post<{ id: number }>('/admin/arenas', body);
      await this.router.navigate(['/admin/arenas', r.id]);
    } catch (e) {
      this.error.set(apiError(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}
