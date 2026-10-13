import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { QuickPlay } from './quick-play';
import { AuthService } from './auth.service';
import { Api } from './api.service';

describe('review entry before play', () => {
  it('opens setup without creating or staking a match', async () => {
    const navigate = vi.fn().mockResolvedValue(true);
    const post = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { navigate } },
        { provide: AuthService, useValue: { isLoggedIn: () => true } },
        { provide: Api, useValue: { post } },
      ],
    });
    await TestBed.inject(QuickPlay).playNow('reaction-rush');
    expect(navigate).toHaveBeenCalledWith(['/games', 'reaction-rush']);
    expect(post).not.toHaveBeenCalled();
  });
  it('creates a guest only when necessary and reviews a friend invitation first', async () => {
    const navigate = vi.fn().mockResolvedValue(true);
    const guest = vi.fn().mockResolvedValue({});
    const post = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { navigate } },
        { provide: AuthService, useValue: { isLoggedIn: () => false, guest } },
        { provide: Api, useValue: { post } },
      ],
    });
    await TestBed.inject(QuickPlay).inviteFriend();
    expect(guest).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(['/games', 'penalty-shootout'], {
      queryParams: { mode: 'invite' },
    });
    expect(post).not.toHaveBeenCalled();
  });
});
