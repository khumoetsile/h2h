import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, Subject } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { ArenaDetailPage } from './arena-detail';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { RealtimeService } from '../../core/realtime.service';
import { ServerClock } from '../../core/server-clock';
import { ArenaDetail, ArenaLeaderboard } from '../../core/fantasy-arena';
const base: ArenaDetail = {
  arena: {
    id: 1,
    name: 'Test Arena',
    description: null,
    status: 'OPEN',
    entryFee: 20,
    feePercent: 10,
    prizePercentages: [50, 30, 20],
    deadline: '2030-01-01T15:00:00Z',
    lockedAt: null,
    completedAt: null,
    participants: 0,
    fixtureCount: 2,
    grossPool: 0,
    platformFee: 0,
    prizePool: 0,
    prizes: [0, 0, 0],
    cancellationReason: null,
    mine: false,
    isDemo: true,
  },
  fixtures: [1, 2].map((id) => ({
    id,
    fixtureId: id,
    homeTeamId: 1,
    awayTeamId: 2,
    referenceTeamId: id === 1 ? 1 : 2,
    homeTeam: 'Liverpool',
    awayTeam: 'Chelsea',
    referenceTeam: id === 1 ? 'Liverpool' : 'Chelsea',
    competition: 'Premier League',
    kickoffAt: '2030-01-01T15:00:00Z',
    originalKickoffAt: '2030-01-01T15:00:00Z',
    status: 'SCHEDULED',
    result: null,
    reason: null,
    homeScore: null,
    awayScore: null,
  })),
  myEntry: null,
  settlement: null,
  serverNow: '2026-10-14T00:00:00Z',
  rules: {
    minimumPlayers: 3,
    pointsPerCorrect: 1,
    ties: 'Ties share prize positions.',
    voids: 'Voids excluded.',
    reschedules: 'Never reopen.',
    visibility: 'Private before lock.',
    demoOnly: true,
  },
};
const board: ArenaLeaderboard = {
  rows: [],
  myRank: null,
  hasMore: false,
  page: 1,
  provisional: true,
};
async function setup(guest = false) {
  let detail = structuredClone(base);
  const user = signal<any>(guest ? null : { id: 1, role: 'PLAYER' }),
    remaining = signal(100000),
    post = vi.fn(),
    put = vi.fn(),
    get = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(url.endsWith('/leaderboard') ? board : detail),
      );
  TestBed.configureTestingModule({
    imports: [ArenaDetailPage],
    providers: [
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: {
          paramMap: new BehaviorSubject(convertToParamMap({ id: '1' })),
          snapshot: { data: {} },
        },
      },
      { provide: Api, useValue: { get, post, put } },
      {
        provide: AuthService,
        useValue: {
          user,
          isLoggedIn: () => !!user(),
          isAdmin: () => user()?.role === 'ADMIN',
          wallet: signal({ available: 200 }),
          refreshMe: vi.fn().mockResolvedValue({}),
        },
      },
      { provide: RealtimeService, useValue: { arena$: new Subject() } },
      { provide: ServerClock, useValue: { remainingMs: () => remaining() } },
    ],
  });
  const f = TestBed.createComponent(ArenaDetailPage);
  f.detectChanges();
  await f.componentInstance.load(true);
  await f.whenStable();
  f.detectChanges();
  return { f, user, remaining, post, put, get, setDetail: (d: ArenaDetail) => (detail = d) };
}
function picks(f: any) {
  return f.nativeElement.querySelectorAll('.pick-grid button');
}
function confirm(f: any) {
  return f.nativeElement.querySelector('.join-box button');
}
describe('Fantasy Arena slip', () => {
  it('pool updates retain unsaved choices without requesting another slip', async () => {
    const { f, get } = await setup();
    picks(f)[0].click();
    f.detectChanges();
    const calls = get.mock.calls.length;
    TestBed.inject(RealtimeService).arena$.next({
      arenaId: 1,
      arena: { ...base.arena, participants: 3, grossPool: 60, prizePool: 54 },
    });
    f.detectChanges();
    expect(picks(f)[0].getAttribute('aria-pressed')).toBe('true');
    expect(get.mock.calls.length).toBe(calls);
    expect(f.nativeElement.textContent).toContain('3 players');
  });
  it('refreshing a leaderboard preserves the page currently being read', async () => {
    const { f, get } = await setup();
    (f.componentInstance as any).board.set({ ...board, page: 3 });
    await f.componentInstance.load();
    expect(get).toHaveBeenLastCalledWith('/arenas/1/leaderboard', { page: 3 });
  });
  it('refreshing the same account keeps the current slip and does not restart loading', async () => {
    const { f, user, get } = await setup();
    picks(f)[0].click();
    f.detectChanges();
    const calls = get.mock.calls.length;
    user.set({ id: 1, role: 'PLAYER', firstName: 'Updated' });
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expect(picks(f)[0].getAttribute('aria-pressed')).toBe('true');
    expect(get.mock.calls.length).toBe(calls);
  });
  it('shows exactly Win/Draw/Loss for the designated team and requires all choices', async () => {
    const { f, post } = await setup();
    expect(picks(f), f.nativeElement.textContent).toHaveLength(6);
    expect(f.nativeElement.textContent).toContain('Predict Chelsea');
    expect([...picks(f)].slice(0, 3).map((b: any) => b.textContent.trim())).toEqual([
      'Win',
      'Draw',
      'Loss',
    ]);
    expect(confirm(f).disabled).toBe(true);
    picks(f)[0].click();
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('1 of 2');
    expect(confirm(f).disabled).toBe(true);
    picks(f)[4].click();
    f.detectChanges();
    expect(confirm(f).disabled).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
  it('guests browse the slip and get a sign-in action without a deduction', async () => {
    const { f, post } = await setup(true);
    expect(f.nativeElement.querySelector('.join-box a').textContent).toContain('Sign in');
    expect(post).not.toHaveBeenCalled();
    expect(f.nativeElement.textContent).toContain('No confirmed entries yet');
  });
  it('one confirmation sends the complete standard slip; duplicate clicks cannot send twice', async () => {
    const { f, post, setDetail } = await setup();
    let finish!: () => void;
    post.mockImplementation((_url: string, body: any) => {
      setDetail({
        ...base,
        myEntry: {
          id: 1,
          points: 0,
          rank: null,
          payout: 0,
          joinedAt: '2026-10-14T00:00:00Z',
          predictions: body.predictions,
        },
      });
      return new Promise<void>((r) => (finish = r));
    });
    picks(f)[0].click();
    picks(f)[4].click();
    f.detectChanges();
    const pending = (f.componentInstance as any).confirm();
    f.detectChanges();
    confirm(f).click();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/arenas/1/entry', {
      predictions: [
        { arenaFixtureId: 1, pick: 'WIN' },
        { arenaFixtureId: 2, pick: 'DRAW' },
      ],
    });
    finish();
    await pending;
    await f.whenStable();
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('Save changed predictions');
    expect(confirm(f).disabled).toBe(true);
  });
  it('the server deadline disables all changes even before a background status refresh', async () => {
    const { f, remaining } = await setup();
    remaining.set(0);
    f.detectChanges();
    expect([...picks(f)].every((b: any) => b.disabled)).toBe(true);
    expect(f.nativeElement.querySelector('.join-box')).toBeNull();
  });
  it('failed confirmation shows actionable feedback, without pretending an entry was saved', async () => {
    const { f, post } = await setup();
    post.mockRejectedValue(
      new HttpErrorResponse({
        status: 400,
        error: { error: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient demo balance.' } },
      }),
    );
    picks(f)[0].click();
    picks(f)[3].click();
    f.detectChanges();
    await (f.componentInstance as any).confirm();
    await f.whenStable();
    f.detectChanges();
    expect(f.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'Insufficient demo balance',
    );
    expect(confirm(f).disabled).toBe(false);
  });
  it('a new identity cannot retain another player’s draft choices', async () => {
    const { f, user } = await setup();
    picks(f)[0].click();
    f.detectChanges();
    user.set(null);
    f.detectChanges();
    await f.componentInstance.load(true);
    await f.whenStable();
    f.detectChanges();
    expect(f.nativeElement.querySelector('.pick-grid [aria-pressed="true"]')).toBeNull();
    expect(f.nativeElement.querySelector('.join-box a').textContent).toContain('Sign in');
  });
});
