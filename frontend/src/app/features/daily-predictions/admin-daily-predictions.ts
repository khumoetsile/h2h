import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
interface Fixture {
  id: number;
  homeTeamId: number;
  awayTeamId: number;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: string;
}
interface Challenge {
  id: number;
  challengeDate: string;
  slot: number;
  homeTeam: string;
  awayTeam: string;
  referenceTeam: string;
  status: string;
  participants: number;
  reason: string | null;
  revision: number;
}
@Component({
  selector: 'app-admin-daily-predictions',
  imports: [FormsModule, DatePipe],
  template: `<div class="page">
    <h1>Manage Daily Predictions</h1>
    <p class="muted">
      Select real provider fixtures. Fixture and reference team are immutable after the first
      prediction.
    </p>
    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    @if (message()) {
      <p role="status">{{ message() }}</p>
    }
    <form class="card form" (ngSubmit)="publish()">
      <h2>{{ editing ? 'Override challenge #' + editing : 'Publish challenge' }}</h2>
      <label
        >Fixture<select [ngModel]="fixtureId" (ngModelChange)="choose($event)" name="fixture">
          <option [ngValue]="0">Select upcoming fixture</option>
          @for (f of fixtures(); track f.id) {
            <option [ngValue]="f.id">
              {{ f.homeTeam }} vs {{ f.awayTeam }} · {{ f.kickoffAt | date: 'short' }}
            </option>
          }
        </select></label
      ><label
        >Reference team<select [(ngModel)]="referenceTeamId" name="reference">
          @if (selected(); as f) {
            <option [ngValue]="f.homeTeamId">{{ f.homeTeam }}</option>
            <option [ngValue]="f.awayTeamId">{{ f.awayTeam }}</option>
          }
        </select></label
      ><label
        >Daily slot<input
          type="number"
          min="1"
          [max]="slots"
          name="slot"
          [(ngModel)]="slot" /></label
      ><button class="btn btn-primary" [disabled]="busy() || !fixtureId">
        {{ busy() ? 'Saving…' : 'Publish' }}
      </button>
      @if (editing) {
        <button type="button" class="btn" (click)="editing = null">Cancel override</button>
      }
    </form>
    <section class="card form">
      <h2>Recent challenges</h2>
      @for (c of challenges(); track c.id) {
        <article>
          <h3>#{{ c.id }} · {{ c.challengeDate }} · slot {{ c.slot }}</h3>
          <p>{{ c.homeTeam }} vs {{ c.awayTeam }} · Predict {{ c.referenceTeam }}</p>
          <p>{{ c.status }} · {{ c.participants }} participants · revision {{ c.revision }}</p>
          @if (c.reason) {
            <p>{{ c.reason }}</p>
          }
          @if (!c.participants && c.status === 'OPEN') {
            <button class="btn" (click)="editing = c.id; slot = c.slot">Override</button>
          }
          <label
            >Correction reason<input
              [(ngModel)]="reasons[c.id]"
              [name]="'reason' + c.id"
              minlength="10"
              placeholder="Explain the verified official correction" /></label
          ><button
            class="btn"
            [disabled]="busy() || !reasons[c.id] || reasons[c.id].length < 10"
            (click)="reconcile(c.id)"
          >
            Reconcile cached official result</button
          ><button
            class="btn"
            [disabled]="busy() || !reasons[c.id] || reasons[c.id].length < 10"
            (click)="voidChallenge(c.id)"
          >
            Permanently void with this reason
          </button>
        </article>
      } @empty {
        <p>No challenges published.</p>
      }
    </section>
  </div>`,
  styles: [
    `
      .form {
        display: grid;
        gap: 16px;
        padding: 20px;
        margin-top: 20px;
      }
      .form label {
        display: grid;
        gap: 8px;
      }
      .form select,
      .form input {
        width: 100%;
        min-width: 0;
        min-height: 48px;
        padding: 10px;
        background: var(--surface-2);
        color: var(--text);
        border: 1px solid var(--border-strong);
        border-radius: 8px;
        font: inherit;
      }
      article {
        display: grid;
        gap: 12px;
        min-width: 0;
        border-top: 1px solid var(--border);
        padding-top: 20px;
      }
      h3,
      p {
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class AdminDailyPredictionsPage implements OnInit {
  private api = inject(Api);
  fixtures = signal<Fixture[]>([]);
  challenges = signal<Challenge[]>([]);
  error = signal('');
  message = signal('');
  busy = signal(false);
  fixtureId = 0;
  referenceTeamId = 0;
  slot = 1;
  slots = 1;
  editing: number | null = null;
  reasons: Record<number, string> = {};
  ngOnInit() {
    void this.load();
  }
  selected() {
    return this.fixtures().find((f) => f.id === this.fixtureId);
  }
  choose(id: number) {
    this.fixtureId = id;
    this.referenceTeamId = this.selected()?.homeTeamId || 0;
  }
  async load() {
    try {
      const [f, c] = await Promise.all([
        this.api.get<{ fixtures: Fixture[] }>('/daily-predictions/admin/fixtures'),
        this.api.get<{ challenges: Challenge[]; slots: number }>(
          '/daily-predictions/admin/challenges',
        ),
      ]);
      this.fixtures.set(f.fixtures);
      this.challenges.set(c.challenges);
      this.slots = c.slots;
    } catch (e) {
      this.error.set(apiError(e).message);
    }
  }
  async publish() {
    this.busy.set(true);
    this.error.set('');
    try {
      const body = {
        fixtureId: this.fixtureId,
        referenceTeamId: this.referenceTeamId,
        slot: this.slot,
      };
      if (this.editing)
        await this.api.put('/daily-predictions/admin/challenges/' + this.editing, body);
      else await this.api.post('/daily-predictions/admin/challenges', body);
      this.editing = null;
      this.message.set('Challenge published.');
      await this.load();
    } catch (e) {
      this.error.set(apiError(e).message);
    } finally {
      this.busy.set(false);
    }
  }
  async voidChallenge(id: number) {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.post(`/daily-predictions/admin/challenges/${id}/void`, {
        reason: this.reasons[id],
      });
      this.message.set(
        'Challenge voided. Streaks, accuracy, points and achievements recalculated.',
      );
      await this.load();
    } catch (e) {
      this.error.set(apiError(e).message);
    } finally {
      this.busy.set(false);
    }
  }
  async reconcile(id: number) {
    this.busy.set(true);
    this.error.set('');
    try {
      const r = await this.api.post<{ changed: boolean; awaitingVerification?: boolean }>(
        `/daily-predictions/admin/challenges/${id}/reconcile`,
        { reason: this.reasons[id] },
      );
      this.message.set(
        r.changed
          ? 'Result reconciled. Statistics and awards rebuilt.'
          : r.awaitingVerification
            ? 'No verified final result available. No changes made.'
            : 'No official result change detected.',
      );
      await this.load();
    } catch (e) {
      this.error.set(apiError(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}
