import { DailyExperience } from '../../core/daily-experience';
import { Component, inject, OnInit, signal, input, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api.service';
import { DailyOverview } from '../../core/daily-predictions';
@Component({
  selector: 'app-daily-preview',
  imports: [RouterLink],
  template: `<section class="card preview" [class.compact]="compact()">
    <div>
      <h2>Daily Predictions</h2>
      @if (data(); as d) {
        <p>{{ status(d) }}</p>
        @if(!compact()) { <p>
          <strong>{{ d.stats.winningStreak }}</strong> winning streak ·
          <strong>{{ d.stats.participationStreak }}</strong> participation streak · Accuracy
          {{ d.stats.accuracy === null ? '—' : d.stats.accuracy + '%' }}
        </p> }
        @if (profile()) {
          <div class="awards">
            @for (a of d.achievements; track a.code) {
              <span [title]="a.description">{{ a.title }}</span>
            } @empty {
              <span>Your first prediction earns your first achievement.</span>
            }
          </div>
        }
      } @else {
        <p>
          {{
            failed() || unavailable()
              ? 'Daily Predictions is temporarily unavailable.'
              : 'Loading your prediction activity…'
          }}
        </p>
      }
    </div>
    <a class="btn btn-primary" [routerLink]="data()?.challenges?.length || profile() ? '/daily-predictions' : '/football'">{{
      profile() ? 'History & achievements' : !data()?.challenges?.length ? 'Explore football' : actionLabel()
    }}</a>
  </section>`,
  styles: [
    `
      .compact { padding:12px 16px !important; }
      .preview {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: center;
        flex-wrap: wrap;
        padding: 20px;
        margin: 16px 0;
      }
      .preview > div {
        min-width: 0;
        flex: 1 1 250px;
      }
      h2 {
        font-size: 23px;
      }
      p {
        color: var(--text-2);
        font-size: 14px;
        margin-top: 8px;
        line-height: 1.5;
      }
      strong {
        color: var(--accent);
      }
      .awards {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }
      .awards span {
        font-size: 12px;
        border: 1px solid var(--border-strong);
        padding: 8px;
        border-radius: 8px;
      }
    `,
  ],
})
export class DailyPreview implements OnInit {
  profile = input(false);
  readonly compact = input(false);
  readonly overview = input<DailyOverview | null | undefined>(undefined);
  readonly unavailable = input(false);
  private loaded = signal<DailyOverview | null>(null);
  data = computed<DailyOverview | null>(() => { const value = this.overview(); return value === undefined ? this.loaded() : value; });
  failed = signal(false);
  private daily = inject(DailyExperience);
  status(d: DailyOverview) {
    const c = d.challenges.find(c => c.canSubmit && !c.pick) ?? d.challenges.find(c => c.fixtureStatus === 'LIVE') ?? d.challenges[0];
    if (!c) return 'No challenge available yet';
    if (c.actual_result === 'VOID') return 'Today’s challenge was voided · streak protected';
    if (c.actual_result)
      return c.pick
        ? c.pick === c.actual_result
          ? 'Your prediction was correct'
          : 'Your prediction was incorrect'
        : 'Today’s challenge is resolved';
    if (c.fixtureStatus === 'LIVE') return 'Match in progress · prediction locked';
    if (!c.canSubmit) return 'Awaiting verified result';
    return c.pick ? 'Prediction submitted' : 'Today’s challenge is open';
  }
  actionLabel() { return this.data()?.challenges.some(c => c.canSubmit && !c.pick) ? 'Make a free prediction' : 'Results & progress'; }
  async ngOnInit() {
    if (this.overview() !== undefined) return;
    try {
      const d = await this.daily.load();
      if (!Array.isArray(d.challenges) || !d.stats)
        throw new Error('Invalid daily predictions response');
      this.loaded.set(d);
    } catch {
      this.failed.set(true);
    }
  }
}
