import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FootballResearchResults } from './football-research-results';
import { FootballResearchStore, FootballResearch } from '../../core/football-research';
import { GoalTrendChart } from './goal-trend';
const summary={played:3,wins:1,draws:1,losses:1,goalsFor:4,goalsAgainst:4,bothTeamsScored:2,over25:1,cleanSheets:1,averageGoals:2.67,goalsForPerMatch:1.33,goalsAgainstPerMatch:1.33,bothTeamsScoredPct:67,over25Pct:33,cleanSheetsPct:33};
const teamA={id:1,name:'Liverpool',shortName:'Liverpool',crestUrl:null},teamB={id:2,name:'Chelsea',shortName:'Chelsea',crestUrl:null};
const base:FootballResearch={teamA,teamB,filters:{teamA:1,teamB:2,venue:'all'},headToHead:{status:'AVAILABLE',matches:[],summary,byVenue:{home:summary,away:summary},page:1,hasMore:true,total:22},form:{teamA:{matches:[],summary,home:summary,away:summary},teamB:{matches:[],summary,home:summary,away:summary}},metadata:{provider:'local-history',source:'ARCHIVE',updatedAt:null,stale:false,providerStatus:'STORED',sampleLimit:22,historyLimit:null,excludedUnverified:0,notice:'Verified archive',isSimulated:false},competitions:[],serverNow:''};
describe('football analysis',()=>{
 it('sample controls emit precise server selections and paging retains the original summary',async()=>{
  const research=vi.fn().mockResolvedValue({...base,headToHead:{...base.headToHead,page:2,hasMore:false,matches:[]}});TestBed.configureTestingModule({imports:[FootballResearchResults],providers:[provideRouter([]),{provide:FootballResearchStore,useValue:{research}}]});const f=TestBed.createComponent(FootballResearchResults);f.componentRef.setInput('data',base);f.detectChanges();const change=vi.fn();f.componentInstance.sampleChange.subscribe(change);f.nativeElement.querySelectorAll('.sample-controls button')[0].click();expect(change).toHaveBeenCalledWith({meetings:'5'});await(f.componentInstance as any).more();expect(research).toHaveBeenCalledWith({...base.filters,page:2});expect(f.componentInstance.data().headToHead.summary.played).toBe(3);
 });
 it('date-only trend labels retain the supplied calendar day',()=>{TestBed.configureTestingModule({imports:[GoalTrendChart]});const f=TestBed.createComponent(GoalTrendChart);f.componentRef.setInput('points',[{date:'2024-01-01',goalsFor:2,goalsAgainst:1}]);f.detectChanges();expect(f.nativeElement.textContent).toContain('1 Jan');expect(f.nativeElement.textContent).not.toContain('31 Dec');});
 it('fixture history opens past meetings directly without sample filters or another research link',()=>{
  TestBed.configureTestingModule({imports:[FootballResearchResults],providers:[provideRouter([]),{provide:FootballResearchStore,useValue:{research:vi.fn()}}]});
  const f=TestBed.createComponent(FootballResearchResults);f.componentRef.setInput('data',base);f.componentRef.setInput('inlineHistory',true);f.detectChanges();
  expect(f.nativeElement.querySelector('.meetings')).toBeTruthy();expect(f.nativeElement.querySelector('.sample-controls')).toBeNull();expect(f.nativeElement.querySelector('.research-link')).toBeNull();expect(f.nativeElement.querySelectorAll('.result-tabs button')).toHaveLength(3);
 });

});
