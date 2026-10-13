import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { RealtimeService } from '../../core/realtime.service';
import { ServerClock } from '../../core/server-clock';
import { Toast } from '../../core/toast.service';
import { Subject } from 'rxjs';
import { ChessHomePage } from './chess-home';

describe('chess invitation setup', () => {
  it('makes the stake/fee review concrete before creating an invitation', async () => {
    const post = vi.fn().mockResolvedValue({ game: { code: 'M-NEWCHESS' } });
    const get = vi.fn().mockResolvedValue({ turnSeconds: 86400, inviteSeconds: 604800, platformFeePercent: 10, stakeAmounts: [5,10], stakeBreakdown: [{ stake:5, pool:10, fee:1, prize:9 }, { stake:10, pool:20, fee:2, prize:18 }], isEnabled:true });
    TestBed.configureTestingModule({ imports:[ChessHomePage], providers:[provideRouter([]),
      {provide:Api,useValue:{get,post}},
      {provide:AuthService,useValue:{user:signal(null),isLoggedIn:()=>false,guest:vi.fn().mockResolvedValue({})}},
      {provide:Toast,useValue:{}},{provide:ServerClock,useValue:{remainingMs:()=>86400000}},
      {provide:RealtimeService,useValue:{chess$:new Subject(),reconnected$:new Subject()}},
    ]});
    const fixture = TestBed.createComponent(ChessHomePage); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const component = fixture.componentInstance as any;
    component.stake.set(10); component.openReview(); fixture.detectChanges();
    expect(post).not.toHaveBeenCalled();
    const review = fixture.nativeElement.querySelector('[role="dialog"]').textContent;
    expect(review).toContain('P10.00'); expect(review).toContain('P2.00'); expect(review).toContain('P18.00'); expect(review).toContain('24 hours');
    vi.spyOn(TestBed.inject(Router),'navigate').mockResolvedValue(true);
    await component.create();
    expect(post).toHaveBeenCalledExactlyOnceWith('/chess',{stake:10});
  });
});
