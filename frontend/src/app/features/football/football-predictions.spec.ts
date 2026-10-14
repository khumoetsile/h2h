import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { FootballPredictions } from './football-predictions';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ServerClock } from '../../core/server-clock';
import { FootballForecast } from '../../core/football-predictions';
const forecast: FootballForecast = {
  fixture: {
    id: 14,
    homeTeam: 'Brentford',
    awayTeam: 'Liverpool',
    kickoffAt: '2030-01-01T15:00:00Z',
    status: 'SCHEDULED',
  },
  open: true,
  serverNow: '2026-10-14T00:00:00Z',
  model: {
    status: 'UNAVAILABLE',
    version: 'test-only',
    methodologyUrl: '/football/predictions/methodology',
    reason: 'Not enough verified data.',
  },
  community: {
    counts: { HOME: 0, DRAW: 0, AWAY: 0 },
    total: 0,
    percentages: { HOME: null, DRAW: null, AWAY: null },
    mine: null,
    notice: 'Opinions only.',
  },
};
async function setup(loggedIn = true) {
  const user = signal<any>(loggedIn ? { id: 1 } : null),
    get = vi.fn().mockResolvedValue(structuredClone(forecast)),
    put = vi.fn();
  TestBed.configureTestingModule({
    imports: [FootballPredictions],
    providers: [
      provideRouter([]),
      { provide: Api, useValue: { get, put } },
      { provide: AuthService, useValue: { user, isLoggedIn: () => !!user() } },
      { provide: ServerClock, useValue: { remainingMs: () => 100000 } },
    ],
  });
  const f = TestBed.createComponent(FootballPredictions);
  f.componentRef.setInput('fixtureId', 14);
  f.detectChanges();
  await f.whenStable();
  f.detectChanges();
  return { f, user, get, put };
}
describe('free football predictions', () => {
  it('guests see real zero counts and sign-in without fabricated model probabilities', async () => {
    const { f, put } = await setup(false);
    expect(f.nativeElement.textContent).toContain('No community picks yet');
    expect(f.nativeElement.textContent).toContain('No reliable estimate yet');
    expect(f.nativeElement.querySelector('.forecast-grid')).toBeNull();
    expect(f.nativeElement.querySelector('.save-pick').textContent).toContain('Sign in');
    expect(put).not.toHaveBeenCalled();
  });
  it('saves one free pick and permits a changed choice, showing returned counts', async () => {
    const { f, put } = await setup();
    const community = {
      ...forecast.community,
      counts: { HOME: 1, DRAW: 0, AWAY: 0 },
      total: 1,
      percentages: { HOME: 100, DRAW: 0, AWAY: 0 },
      mine: { pick: 'HOME', submittedAt: '2026-10-14T00:00:00Z' },
    };
    put.mockResolvedValue({ community });
    f.nativeElement.querySelectorAll('.pick-options button')[0].click();
    f.detectChanges();
    f.nativeElement.querySelector('button.save-pick').click();
    await f.whenStable();
    f.detectChanges();
    expect(put).toHaveBeenCalledWith('/football/fixtures/14/prediction', { pick: 'HOME' });
    expect(f.nativeElement.textContent).toContain('Saved. You can change it until kickoff.');
    expect(f.nativeElement.querySelector('button.save-pick').disabled).toBe(true);
    expect(f.nativeElement.textContent).toContain('100%');
    f.nativeElement.querySelectorAll('.pick-options button')[2].click();
    f.detectChanges();
    expect(f.nativeElement.querySelector('button.save-pick').disabled).toBe(false);
    expect(f.nativeElement.querySelector('button.save-pick').textContent).toContain(
      'Save changed pick',
    );
  });
  it('server rejection locks the controls at kickoff', async () => {
    const { f, put } = await setup();
    put.mockRejectedValue(
      new HttpErrorResponse({
        status: 409,
        error: {
          error: { code: 'PREDICTIONS_CLOSED', message: 'Picks close when the match starts.' },
        },
      }),
    );
    f.nativeElement.querySelectorAll('.pick-options button')[1].click();
    f.detectChanges();
    f.nativeElement.querySelector('button.save-pick').click();
    await f.whenStable();
    f.detectChanges();
    expect(f.nativeElement.querySelector('[role="alert"]')).toBeTruthy();
    expect(f.nativeElement.querySelectorAll('.pick-options button')[0].disabled).toBe(true);
  });
  it('discards a private response arriving after identity changes', async () => {
    const { f, user, get } = await setup();
    let finish!: (v: FootballForecast) => void;
    get.mockReturnValueOnce(new Promise<FootballForecast>((r) => (finish = r)));
    const pending = f.componentInstance.load();
    user.set(null);
    f.detectChanges();
    await Promise.resolve();
    get.mockResolvedValue(forecast);
    finish({
      ...forecast,
      community: {
        ...forecast.community,
        mine: { pick: 'HOME', submittedAt: '2026-10-14T00:00:00Z' },
      },
    });
    await pending;
    await f.whenStable();
    f.detectChanges();
    expect(f.nativeElement.querySelector('.save-pick').textContent).toContain('Sign in');
    expect(f.nativeElement.querySelector('[aria-pressed="true"]')).toBeNull();
  });
});
