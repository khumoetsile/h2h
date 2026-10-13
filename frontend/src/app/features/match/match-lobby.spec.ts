import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { MatchLobbyPage } from './match-lobby';
import { Api } from '../../core/api.service';
import { Toast } from '../../core/toast.service';
import { RealtimeService } from '../../core/realtime.service';
import { ServerClock } from '../../core/server-clock';

describe('explicit match readiness', () => {
  it('does not mark a player ready until they choose to do so', async () => {
    const match = {
      code: 'M-READYTEST',
      category: 'SKILL_GAME',
      status: 'MATCHED',
      viewerId: 1,
      players: [
        { userId: 1, owesAction: true },
        { userId: 2, owesAction: true },
      ],
      timers: {},
    };
    const post = vi.fn().mockResolvedValue({
      match: {
        ...match,
        players: [
          { userId: 1, owesAction: false },
          { userId: 2, owesAction: true },
        ],
      },
    });
    TestBed.configureTestingModule({
      imports: [MatchLobbyPage],
      providers: [
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: Api, useValue: { post } },
        { provide: Toast, useValue: { error: vi.fn(), success: vi.fn() } },
        { provide: RealtimeService, useValue: {} },
        { provide: ServerClock, useValue: { remainingMs: () => 0 } },
      ],
    });
    const fixture = TestBed.createComponent(MatchLobbyPage);
    fixture.componentRef.setInput('code', match.code);
    (fixture.componentInstance as any).apply(match);
    expect(post).not.toHaveBeenCalled();
    await fixture.componentInstance.lockIn();
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith('/matches/M-READYTEST/ready');
  });
});
