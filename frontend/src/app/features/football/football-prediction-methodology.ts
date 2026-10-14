import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { PredictionMethodology } from '../../core/football-predictions';
@Component({
  selector: 'app-football-prediction-methodology',
  imports: [RouterLink, DatePipe],
  template: `<div class="page methodology">
    <a routerLink="/football" class="back">← Football</a>
    <h1>How our estimates work</h1>
    <p>Past results help estimate what may happen. They cannot tell us what will happen.</p>
    @if (error()) {
      <p role="alert">{{ error() }}</p>
      <button class="btn" (click)="load()">Try again</button>
    } @else if (data(); as d) {
      <section class="card">
        <h2>Goals, strengths and home advantage</h2>
        <p>
          We compare each team’s scoring and defending with its league, account for the opponents it
          faced, and give recent games more weight. Teams with smaller samples are pulled towards
          the league average.
        </p>
        <p>Previous meetings are already part of these team records. They are not counted twice.</p>
        <details>
          <summary>Method and data cutoff</summary>
          <p>{{ d.method }}</p>
          <p>{{ d.cutoff }}</p>
          <p>{{ d.version }}</p>
          <a [href]="d.reference" target="_blank" rel="noopener noreferrer"
            >Background research ↗</a
          >
        </details>
      </section>
      <section class="card">
        <h2>Tested on later matches</h2>
        <p>
          Each test uses only earlier match dates. We compare the model with a simple league-average
          forecast.
        </p>
        @for (r of d.reports; track r.competition_code) {
          <article class="validation">
            <div>
              <strong>{{ r.competition_code }}</strong
              ><span>{{
                r.evaluation.validated ? 'Validation passed' : 'Numerical estimates withheld'
              }}</span>
            </div>
            <p>
              {{ r.evaluation.primary.model.count }} tested matches · Data cutoff
              {{ r.data_cutoff | date: 'd MMM yyyy' : 'UTC' }}
            </p>
            <details>
              <summary>See test results</summary>
              <div class="metric-table">
                <span>Metric (lower is better)</span><span>Model</span><span>Baseline</span
                ><span>Log loss</span
                ><strong>{{ r.evaluation.primary.model.logLoss ?? '—' }}</strong
                ><strong>{{ r.evaluation.primary.baseline.logLoss ?? '—' }}</strong
                ><span>Brier score</span
                ><strong>{{ r.evaluation.primary.model.brier ?? '—' }}</strong
                ><strong>{{ r.evaluation.primary.baseline.brier ?? '—' }}</strong
                ><span>Calibration error</span
                ><strong>{{ r.evaluation.primary.model.ece ?? '—' }}</strong
                ><strong>{{ r.evaluation.primary.baseline.ece ?? '—' }}</strong>
              </div>
              <p>
                {{ r.evaluation.skipped }} fixtures lacked enough comparable data.
                {{ r.evaluation.from }} to {{ r.evaluation.to }}.
              </p>
            </details>
          </article>
        } @empty {
          <p>League validation results are not available yet.</p>
        }
      </section>
      <section class="card">
        <h2>Know the limits</h2>
        <p>
          Injuries, lineups and other changes may matter. Some competitions and newly promoted teams
          lack enough data for a useful estimate.
        </p>
        <details>
          <summary>Data and validation details</summary>
          <p>{{ d.validation }}</p>
          <p>{{ d.limitations }}</p>
          <ul>
            @for (s of d.sources; track s) {
              <li>{{ s }}</li>
            }
          </ul>
        </details>
        <p>Community picks are opinions. Model estimates are not guarantees or betting advice.</p>
      </section>
    } @else {
      <div class="skeleton" role="status" aria-label="Loading model information"></div>
    }
  </div>`,
  styles: [
    `
      .methodology {
        max-width: 850px;
        display: grid;
        gap: 18px;
      }
      .back {
        min-height: 44px;
        display: flex;
        align-items: center;
        color: var(--text-2);
      }
      h1 {
        font-size: clamp(28px, 4vw, 40px);
      }
      .card {
        padding: 22px;
      }
      h2 {
        font-size: 20px;
        margin-bottom: 12px;
      }
      p {
        font-size: 15px;
        line-height: 1.6;
        color: var(--text-2);
        margin-bottom: 12px;
      }
      summary {
        min-height: 44px;
        cursor: pointer;
        padding: 12px 0;
      }
      details {
        font-size: 14px;
      }
      .validation {
        border-top: 1px solid var(--border);
        padding-top: 16px;
        margin-top: 16px;
      }
      .validation > div {
        display: flex;
        justify-content: space-between;
        gap: 12px;
      }
      .validation > div span {
        font-size: 13px;
        color: var(--text-2);
      }
      .metric-table {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        gap: 10px;
        font-size: 13px;
      }
      .metric-table strong {
        text-align: right;
      }
      .skeleton {
        height: 150px;
      }
      ul {
        padding-left: 20px;
        color: var(--text-2);
        line-height: 1.8;
      }
      @media (max-width: 400px) {
        .card {
          padding: 16px;
        }
        .metric-table {
          font-size: 12px;
          gap: 8px;
        }
      }
    `,
  ],
})
export class FootballPredictionMethodologyPage {
  private api = inject(Api);
  protected data = signal<PredictionMethodology | null>(null);
  protected error = signal('');
  constructor() {
    void this.load();
  }
  async load() {
    this.error.set('');
    try {
      this.data.set(await this.api.get<PredictionMethodology>('/football/prediction-methodology'));
    } catch (err) {
      this.error.set(apiError(err).message);
    }
  }
}
