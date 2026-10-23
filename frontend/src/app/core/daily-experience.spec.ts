import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {DailyExperience} from './daily-experience';
import {AuthService} from './auth.service';
import {Api} from './api.service';
import {DailyOverview} from './daily-predictions';
describe('prediction discovery reads',()=>{
  it('shares a pending read, refreshes submitted data and never reuses another account’s selection',async()=>{
    const user=signal({id:1});const first={challenges:[],stats:{winningStreak:1}} as unknown as DailyOverview;
    const get=vi.fn().mockResolvedValue(first);
    TestBed.configureTestingModule({providers:[{provide:Api,useValue:{get}},{provide:AuthService,useValue:{user}}]});
    const daily=TestBed.inject(DailyExperience);
    await Promise.all([daily.load(),daily.load()]);expect(get).toHaveBeenCalledTimes(1);
    const saved={...first,stats:{...first.stats,winningStreak:2}};daily.remember(saved);
    expect(await daily.load()).toBe(saved);expect(get).toHaveBeenCalledTimes(1);
    user.set({id:2});await daily.load();expect(get).toHaveBeenCalledTimes(2);
  });
});
