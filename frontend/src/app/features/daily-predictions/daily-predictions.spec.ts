import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { DailyPredictionsPage } from './daily-predictions';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
const overview = () => ({
  today: '2026-10-21',
  timezone: 'Africa/Gaborone',
  serverNow: '2026-10-21T10:00:00Z',
  challenges: [
    {
      id: 1,
      challengeDate: '2026-10-21',
      homeTeam: 'Test Club',
      awayTeam: 'Other Club',
      referenceTeam: 'Test Club',
      kickoffAt: '2026-10-21T18:00:00Z',
      status: 'OPEN',
      fixtureStatus: 'SCHEDULED',
      actual_result: null,
      pick: null,
      canSubmit: true,
      providerUnavailable: false,
    },
  ],
  stats: {
    winningStreak: 3,
    bestWinningStreak: 5,
    participationStreak: 7,
    bestParticipationStreak: 7,
    correct: 3,
    incorrect: 1,
    eligible: 4,
    accuracy: 75,
    last7Accuracy: 75,
    last30Accuracy: 75,
    history: [],
  },
  achievements: [],
  reminders: false,
  weeklyRank: 2,
});
async function setup(loggedIn = true, data: any = overview()) {
  const user = signal<any>(loggedIn ? { id: 1 } : null),
    get = vi
      .fn()
      .mockImplementation(async (path: string) =>
        path.endsWith('/history')
          ? { predictions: [], page: 1, hasMore: false }
          : path.endsWith('/leaderboard')
            ? { rankings: [], mine: null, hasMore: false, tiePolicy: 'Shared ranks' }
            : structuredClone(data),
      );
  const put = vi.fn().mockResolvedValue({ saved: true });
  TestBed.configureTestingModule({
    imports: [DailyPredictionsPage],
    providers: [
      provideRouter([]),
      { provide: Api, useValue: { get, put } },
      { provide: AuthService, useValue: { user, isLoggedIn: () => !!user() } },
    ],
  });
  const f = TestBed.createComponent(DailyPredictionsPage);
  f.detectChanges();
  await f.whenStable();
  f.detectChanges();
  return { f, get, put };
}
describe('Daily Predictions', () => {
  it('offers exactly Win Draw Loss and shows distinct real streaks', async () => {
    const { f } = await setup();
    expect(
      [...f.nativeElement.querySelectorAll('.choices button')].map((b: any) =>
        b.textContent.trim(),
      ),
    ).toEqual(['Win', 'Draw', 'Loss']);
    const text = f.nativeElement.textContent;
    expect(text).toContain('Winning Streak');
    expect(text).toContain('Participation Streak');
    expect(text).toContain('75%');
    expect(f.nativeElement.querySelector('.community')).toBeNull();
  });
  it('submits a choice and shows backend confirmation and community summary', async () => {
    const { f, get, put } = await setup();
    const d: any = overview();
    d.challenges[0].pick = 'WIN';
    d.challenges[0].community = {
      total: 1,
      selections: [
        { pick: 'WIN', count: 1, percentage: 100 },
        { pick: 'DRAW', count: 0, percentage: 0 },
        { pick: 'LOSS', count: 0, percentage: 0 },
      ],
    };
    get.mockImplementation(async (path: string) =>
      path.endsWith('/history') ? { predictions: [], hasMore: false } : d,
    );
    f.nativeElement.querySelector('.choices button').click();
    f.detectChanges();
    f.nativeElement.querySelector('.submit').click();
    await f.whenStable();
    f.detectChanges();
    expect(put).toHaveBeenCalledWith('/daily-predictions/1/prediction', { pick: 'WIN' });
    expect(f.nativeElement.textContent).toContain('Prediction submitted: Test Club Win');
    expect(f.nativeElement.querySelector('.community').textContent).toContain('1 participants');
  });
  it('guests see sign in and cannot submit; private history is not fetched', async () => {
    const { f, get } = await setup(false);
    expect(f.nativeElement.textContent).toContain('Sign in to predict');
    expect(f.nativeElement.querySelector('.submit')).toBeNull();
    expect(get.mock.calls.some((c) => c[0].endsWith('/history'))).toBe(false);
  });
  it('locks choices against server time and reports pending verification', async () => {
    const d = overview();
    d.challenges[0].kickoffAt = '2026-10-21T09:00:00Z';
    const { f } = await setup(true, d);
    expect(f.nativeElement.querySelector('.choices')).toBeNull();
    expect(f.nativeElement.textContent).toContain('Prediction locked · awaiting verified result');
  });
  it('filters private history and changes ranking calendar period', async () => {
    const { f, get } = await setup();
    f.componentInstance.filter = 'correct';
    await f.componentInstance.loadHistory();
    expect(get).toHaveBeenCalledWith('/daily-predictions/history', { filter: 'correct', page: 1 });
    f.componentInstance.period = 'monthly';
    await f.componentInstance.loadBoard();
    expect(get).toHaveBeenCalledWith('/daily-predictions/leaderboard', {
      period: 'monthly',
      page: 1,
    });
  });
  it('shows empty challenge, zero-sample accuracy and void protection honestly', async () => {
    const d: any = overview();
    d.challenges = [];
    d.stats.accuracy = null;
    const { f } = await setup(true, d);
    expect(f.nativeElement.textContent).toContain('No challenge available yet');
    expect(f.nativeElement.querySelector('.metrics').textContent).not.toContain('null%');
  });
  it('preserves submission errors after refreshing state', async () => {
    const { f, put } = await setup();
    put.mockRejectedValue(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'PREDICTIONS_LOCKED', message: 'Predictions are locked.' } },
      }),
    );
    f.componentInstance.select(1, 'WIN');
    await f.componentInstance.submit(f.componentInstance.data()!.challenges[0]);
    f.detectChanges();
    expect(f.nativeElement.querySelector('[role=alert]').textContent).toContain(
      'Predictions are locked.',
    );
  });
  it('offers retry after loading fails and never invents statistics', async () => {
    const { f, get } = await setup();
    get.mockRejectedValue(new HttpErrorResponse({ status: 503 }));
    await f.componentInstance.load();
    f.detectChanges();
    expect(f.nativeElement.querySelector('[role=alert]')).not.toBeNull();
    expect(f.nativeElement.querySelector('.daily-head button').disabled).toBe(false);
  });
  it('shows unavailable provider and void states', async () => {
    const d: any = overview();
    d.challenges[0].providerUnavailable = true;
    let result = await setup(true, d);
    expect(result.f.nativeElement.textContent).toContain('Provider temporarily unavailable');
    result.f.destroy();
    TestBed.resetTestingModule();
    d.challenges[0].actual_result = 'VOID';
    d.challenges[0].status = 'VOID';
    d.challenges[0].canSubmit = false;
    result = await setup(true, d);
    expect(result.f.nativeElement.textContent).toContain(
      'Challenge voided. Your streak is protected.',
    );
    expect(result.f.nativeElement.querySelector('.choices')).toBeNull();
  });
});
