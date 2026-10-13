import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, Subject } from 'rxjs';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { RealtimeService } from '../../core/realtime.service';
import { RematchService } from '../../core/rematch.service';
import { ServerClock } from '../../core/server-clock';
import { SeoService } from '../../core/seo.service';
import { FootballListPage } from './football-list';

describe('football fixture search and filter state',()=>{
  let get:ReturnType<typeof vi.fn>;let query:BehaviorSubject<ReturnType<typeof convertToParamMap>>;let route:{snapshot:{queryParamMap:ReturnType<typeof convertToParamMap>};queryParamMap:BehaviorSubject<ReturnType<typeof convertToParamMap>>};
  beforeEach(()=>{
    query=new BehaviorSubject(convertToParamMap({}));route={snapshot:{queryParamMap:query.value},queryParamMap:query};
    get=vi.fn().mockImplementation((path:string)=>Promise.resolve(path==='/football/competitions'?{competitions:[]}:{fixtures:[],total:0,lastUpdatedAt:'2026-10-13T12:00:00Z'}));
    TestBed.configureTestingModule({imports:[FootballListPage],providers:[provideRouter([]),{provide:ActivatedRoute,useValue:route},{provide:Api,useValue:{get}},
      {provide:AuthService,useValue:{isLoggedIn:()=>false,user:signal(null)}},{provide:SeoService,useValue:{publish:vi.fn()}},
      {provide:ServerClock,useValue:{now:signal(Date.parse('2026-10-13T12:00:00Z')),remainingMs:()=>10000}},
      {provide:RematchService,useValue:{current:signal(null),setPending:vi.fn()}},
      {provide:RealtimeService,useValue:{reconnected$:new Subject(),match$:new Subject(),queue$:new Subject(),config$:new Subject()}},
    ]});
  });
  it('restores a shared search and competition/date/day filters and sends the same server query',async()=>{
    query.next(convertToParamMap({q:'Liverpool',competitionId:'3',dateFrom:'2026-10-01',dateTo:'2026-10-20',day:'all'}));
    const component=TestBed.createComponent(FootballListPage).componentInstance as any;component.ngOnInit();await Promise.resolve();await Promise.resolve();
    expect(component.searchText).toBe('Liverpool');expect(component.competitionId()).toBe(3);expect(component.day()).toBe('all');
    expect(get).toHaveBeenCalledWith('/football/fixtures',expect.objectContaining({q:'Liverpool',competitionId:3,dateFrom:'2026-10-01',dateTo:'2026-10-20',pageSize:24}));
    const navigate=vi.spyOn(TestBed.inject(Router),'navigate').mockResolvedValue(true);component.selectCompetition('7');
    expect(navigate).toHaveBeenCalledWith([],expect.objectContaining({queryParams:expect.objectContaining({q:'Liverpool',competitionId:7,dateFrom:'2026-10-01',day:'all'}),replaceUrl:true}));
  });
  it('never displays results from an older fixture search after the filter changed',async()=>{
    const deferred:Array<(value:unknown)=>void>=[];get.mockImplementation(()=>new Promise(done=>deferred.push(done)));
    const component=TestBed.createComponent(FootballListPage).componentInstance as any;component.searchQuery.set('Liverpool');const older=component.load();
    component.searchQuery.set('Chelsea');const newer=component.load();deferred[2]({fixtures:[{id:2,isSimulated:false}],total:1,lastUpdatedAt:'2026-10-13T12:00:00Z'});deferred[3]({fixtures:[],total:0});await newer;
    deferred[0]({fixtures:[{id:1,isSimulated:false}],total:1,lastUpdatedAt:'2026-10-13T12:00:00Z'});deferred[1]({fixtures:[],total:0});await older;
    expect(component.fixtures().map((f:{id:number})=>f.id)).toEqual([2]);
  });
  it('keeps upcoming fixtures available when the separate past-results request fails',async()=>{
    get.mockImplementation((_path:string,params:{status?:string})=>params.status?Promise.reject(new HttpErrorResponse({status:503})):Promise.resolve({fixtures:[{id:1,isSimulated:false,kickoffAt:'2026-10-14T12:00:00Z',status:'SCHEDULED'}],total:1,lastUpdatedAt:'2026-10-13T12:00:00Z'}));
    const component=TestBed.createComponent(FootballListPage).componentInstance as any;await component.load();
    expect(component.fixtures()).toHaveLength(1);expect(component.error()).toBe('');expect(component.resultsError()).toContain('unavailable');
  });
  it('does not clear current results for whitespace-only edits of the same search',()=>{
    const component=TestBed.createComponent(FootballListPage).componentInstance as any;component.searchQuery.set('Chelsea');component.fixtures.set([{id:2}]);component.onSearch(' Chelsea ');
    expect(component.fixtures()).toEqual([{id:2}]);
  });
  it('renders a filtered upcoming empty state alongside a valid past result without claiming the data source is unconfigured',async()=>{
    query.next(convertToParamMap({q:'Arsenal vs Chelsea',day:'all'}));
    const result={id:9,competition:{id:1,name:'League'},homeTeam:{id:1,name:'Arsenal',shortName:'Arsenal'},awayTeam:{id:2,name:'Chelsea',shortName:'Chelsea'},kickoffAt:'2026-10-01T12:00:00Z',status:'FINISHED',homeScore:2,awayScore:0,isSimulated:false,openChallenges:0};
    get.mockImplementation((path:string,params:{status?:string}={})=>Promise.resolve(path==='/football/competitions'?{competitions:[]}:{fixtures:params.status?[result]:[],total:params.status?1:0,lastUpdatedAt:null}));
    const fixture=TestBed.createComponent(FootballListPage);fixture.detectChanges();await fixture.componentInstance.load();fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No matches found');expect(fixture.nativeElement.textContent).toContain('Clear filters');
    expect(fixture.nativeElement.textContent).toContain('Arsenal');expect(fixture.nativeElement.textContent).not.toContain('Football data is not available yet');
    const navigate=vi.spyOn(TestBed.inject(Router),'navigate').mockResolvedValue(true);fixture.componentInstance.clearFilters();
    expect(navigate).toHaveBeenCalledWith([],expect.objectContaining({queryParams:expect.objectContaining({q:null,competitionId:null,dateFrom:null,dateTo:null,day:'all'})}));
  });
});
