import {TestBed} from '@angular/core/testing';
import {provideRouter} from '@angular/router';
import {MatchHistoryPage} from './match-history';
import {Api} from '../../core/api.service';
import {RealtimeService} from '../../core/realtime.service';
import {ConfigStore} from '../../core/config.store';
describe('match filter request ordering',()=>{
  it('a slower earlier filter response cannot replace the selected results',async()=>{
    const resolvers:((value:unknown)=>void)[]=[];
    TestBed.configureTestingModule({providers:[provideRouter([]),{provide:Api,useValue:{get:vi.fn(()=>new Promise(resolve=>resolvers.push(resolve)))}},{provide:RealtimeService,useValue:{}},{provide:ConfigStore,useValue:{}}]});
    TestBed.overrideComponent(MatchHistoryPage,{set:{template:''}});
    const page=TestBed.createComponent(MatchHistoryPage).componentInstance;
    const older=page.load();(page as any).filter.set('wins');const newer=page.load();
    const selected={items:[{id:2}],total:1,page:1,pageSize:20};resolvers[1](selected);await newer;
    resolvers[0]({items:[{id:1}],total:1,page:1,pageSize:20});await older;
    expect((page as any).data()).toEqual(selected);
  });
});
