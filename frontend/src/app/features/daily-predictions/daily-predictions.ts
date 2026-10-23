import { DailyExperience } from '../../core/daily-experience';
import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { apiError } from '../../core/api-error';
import {
  DailyChallenge,
  DailyHistory,
  DailyLeaderboard,
  DailyOverview,
  DailyPick,
  dailyLabel,
} from '../../core/daily-predictions';
@Component({
  selector: 'app-daily-predictions',
  imports: [DatePipe, FormsModule, RouterLink],
  templateUrl: './daily-predictions.html',
  styleUrl: './daily-predictions.scss',
})
export class DailyPredictionsPage implements OnInit {
  private api = inject(Api);
  private dailyExperience = inject(DailyExperience);
  protected auth = inject(AuthService);
  private destroy = inject(DestroyRef);
  data = signal<DailyOverview | null>(null);
  loading = signal(true);
  saving = signal<number | null>(null);
  error = signal('');
  feedback = signal('');
  history = signal<DailyHistory | null>(null);
  board = signal<DailyLeaderboard | null>(null);
  historyError = signal('');
  boardError = signal('');
  historyLoading = signal(false);
  boardLoading = signal(false);
  filter = 'all';
  period = 'weekly';
  historyPage = 1;
  boardPage = 1;
  selections = signal<Record<number, DailyPick>>({});
  label = dailyLabel;
  picks: DailyPick[] = ['WIN', 'DRAW', 'LOSS'];
  now = signal(Date.now());
  private offset = 0;
  private sequence = 0;
  private historySequence = 0;
  private boardSequence = 0;
  ngOnInit() {
    void this.load();
    void this.loadBoard();
    if (this.auth.isLoggedIn()) void this.loadHistory();
    const timer = setInterval(() => this.now.set(Date.now() + this.offset), 1000);
    this.destroy.onDestroy(() => {
      clearInterval(timer);
      ++this.sequence;
      ++this.historySequence;
      ++this.boardSequence;
    });
  }
  async refresh() {
    await Promise.all([
      this.load(),
      this.loadBoard(this.boardPage),
      ...(this.auth.isLoggedIn() ? [this.loadHistory(this.historyPage)] : []),
    ]);
  }
  async load() {
    const seq = ++this.sequence;
    this.loading.set(true);
    this.error.set('');
    try {
      const d = await this.api.get<DailyOverview>('/daily-predictions');
      if (seq !== this.sequence) return;
      this.offset = Date.parse(d.serverNow) - Date.now();
      this.now.set(Date.now() + this.offset);
      this.dailyExperience.remember(d);
      this.data.set(d);
      this.selections.set(
        Object.fromEntries(d.challenges.filter((c) => c.pick).map((c) => [c.id, c.pick!])),
      );
    } catch (e) {
      if (seq === this.sequence) this.error.set(apiError(e).message);
    } finally {
      if (seq === this.sequence) this.loading.set(false);
    }
  }
  open(c: DailyChallenge) {
    return c.canSubmit && Date.parse(c.cutoffAt || c.kickoffAt) > this.now();
  }
  select(id: number, pick: DailyPick) {
    this.selections.update((s) => ({ ...s, [id]: pick }));
    this.feedback.set('');
  }
  status(c: DailyChallenge) {
    if (c.actual_result === 'VOID')
      return c.reason || 'Challenge voided. Your streak is protected.';
    if (c.actual_result)
      return c.pick
        ? c.pick === c.actual_result
          ? 'Correct · 1 point'
          : 'Incorrect · 0 points'
        : 'Missed challenge';
    if (c.fixtureStatus === 'POSTPONED') return 'Match postponed · your streak is protected';
    if (c.fixtureStatus === 'LIVE') return 'Match in progress · prediction locked';
    if (!this.open(c)) return 'Prediction locked · awaiting verified result';
    return c.pick
      ? 'Prediction submitted · you can change it before kickoff'
      : 'Open for predictions';
  }
  async submit(c: DailyChallenge) {
    const pick = this.selections()[c.id];
    if (!pick || this.saving()) return;
    this.saving.set(c.id);
    this.error.set('');
    try {
      await this.api.put(`/daily-predictions/${c.id}/prediction`, { pick });
      this.feedback.set(`Prediction submitted: ${c.referenceTeam} ${this.label(pick)}`);
      await this.load();
      await this.loadHistory();
    } catch (e) {
      const message = apiError(e).message;
      await this.load();
      this.error.set(message);
    } finally {
      this.saving.set(null);
    }
  }
  async loadHistory(page = 1) {
    const seq = ++this.historySequence;
    this.historyLoading.set(true);
    this.historyError.set('');
    try {
      const d = await this.api.get<DailyHistory>('/daily-predictions/history', {
        filter: this.filter,
        page,
      });
      if (seq === this.historySequence) {
        this.history.set(d);
        this.historyPage = page;
      }
    } catch (e) {
      if (seq === this.historySequence) this.historyError.set(apiError(e).message);
    } finally {
      if (seq === this.historySequence) this.historyLoading.set(false);
    }
  }
  async loadBoard(page = 1) {
    const seq = ++this.boardSequence;
    this.boardLoading.set(true);
    this.boardError.set('');
    try {
      const d = await this.api.get<DailyLeaderboard>('/daily-predictions/leaderboard', {
        period: this.period,
        page,
      });
      if (seq === this.boardSequence) {
        this.board.set(d);
        this.boardPage = page;
      }
    } catch (e) {
      if (seq === this.boardSequence) this.boardError.set(apiError(e).message);
    } finally {
      if (seq === this.boardSequence) this.boardLoading.set(false);
    }
  }
  impact(row: { challengeDate: string; actualResult: string | null }) {
    if (row.actualResult === 'VOID') return 'Streak protected';
    const s = this.data()?.stats.history.find((h) => h.date === row.challengeDate);
    return !s || s.pending
      ? 'Streak awaiting verification'
      : `Winning streak after day: ${s.winningStreak}`;
  }
  async reminders(enabled: boolean) {
    try {
      await this.api.put('/daily-predictions/preferences', { reminders: enabled });
      this.data.update((d) => (d ? { ...d, reminders: enabled } : d));
    } catch (e) {
      this.error.set(apiError(e).message);
    }
  }
}
