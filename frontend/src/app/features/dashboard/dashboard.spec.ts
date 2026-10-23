import {TestBed} from '@angular/core/testing';
import {provideRouter} from '@angular/router';
import {signal} from '@angular/core';
import {DashboardPage} from './dashboard';
import {Api} from '../../core/api.service';
import {AuthService} from '../../core/auth.service';
import {RealtimeService} from '../../core/realtime.service';
import {ServerClock} from '../../core/server-clock';
import {Toast} from '../../core/toast.service';
describe('dashboard activity reads',()=>{
  function setup(failMine=false){
    const get=vi.fn().mockImplementation((url:string,params?:any)=>{
      if(url==='/arenas'&&params.section==='mine'&&failMine)return Promise.reject(new Error('Offline'));
      return Promise.resolve(url==='/dashboard'?{wallet:{},activeMatches:[],activeChallenges:[],games:[],recentMatches:[],stats:{},leaderboard:{}}:url==='/daily-predictions'?{challenges:[],stats:{}}:url==='/arenas'?{arenas:params.section==='mine'?[{id:1,name:'My entry'}]:[]}:{fixtures:[]});
    });
    TestBed.configureTestingModule({providers:[provideRouter([]),{provide:Api,useValue:{get}},{provide:AuthService,useValue:{user:signal({id:1}),wallet:signal(null)}},{provide:RealtimeService,useValue:{}},{provide:ServerClock,useValue:{now:signal(Date.now())}},{provide:Toast,useValue:{}}]});
    TestBed.overrideComponent(DashboardPage,{set:{template:''}});
    return {page:TestBed.createComponent(DashboardPage).componentInstance,get};
  }
  it('loads personal and open arena discovery from the existing plural endpoint',async()=>{
    const {page,get}=setup();await page.load();
    expect(get).toHaveBeenCalledWith('/arenas',{section:'mine',pageSize:4});
    expect((page as any).myArenas()).toHaveLength(1);
    expect(get.mock.calls.some(([url])=>url==='/arena')).toBe(false);
  });
  it('keeps core activity usable and distinguishes a failed personal-arena read from an empty list',async()=>{
    const {page}=setup(true);await page.load();
    expect((page as any).data()).not.toBeNull();expect((page as any).myArenaError()).toBe(true);
  });
});
