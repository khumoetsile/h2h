import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {provideRouter} from '@angular/router';
import {FootballFixturePage} from './football-fixture';
import {Api} from '../../core/api.service';
import {AuthService} from '../../core/auth.service';
import {SeoService} from '../../core/seo.service';
import {Toast} from '../../core/toast.service';
import {ServerClock} from '../../core/server-clock';
import {ConfigStore} from '../../core/config.store';
import {RematchService} from '../../core/rematch.service';
import {FootballResearchStore} from '../../core/football-research';
async function setup(loggedIn=true){
  vi.spyOn(FootballFixturePage.prototype,'ngOnInit').mockImplementation(()=>{});
  const post=vi.fn(),remaining=signal(100000);
  TestBed.configureTestingModule({imports:[FootballFixturePage],providers:[provideRouter([]),
    {provide:Api,useValue:{post}}, {provide:AuthService,useValue:{isLoggedIn:()=>loggedIn,wallet:signal({available:100})}},
    {provide:SeoService,useValue:{}},{provide:Toast,useValue:{}}, {provide:RematchService,useValue:{}},
    {provide:FootballResearchStore,useValue:{}},{provide:ServerClock,useValue:{remainingMs:()=>remaining()}},
    {provide:ConfigStore,useValue:{config:()=>({stakeBreakdown:[]}),timers:()=>({}),abandonmentFee:()=>0.5}},
  ]});
  const f=TestBed.createComponent(FootballFixturePage);f.componentRef.setInput('fixtureId','1');
  const c=f.componentInstance as any;
  c.fixture.set({id:1,status:'SCHEDULED',kickoffAt:'2030-01-01T15:00:00Z',competition:{name:'Premier League'},homeTeam:{id:1,name:'Liverpool',shortName:'Liverpool'},awayTeam:{id:2,name:'Chelsea',shortName:'Chelsea'},stakes:[5,20],challengeTypes:[{id:1,slug:'winner',question:'Who will win?',pickType:'TEAM',settlementSummary:'Draws refund both entries.'}]});
  c.stake.set(20);f.detectChanges();await f.whenStable();
  const click=(text:string)=>{const b=[...f.nativeElement.querySelectorAll('button')].find((x:any)=>x.textContent.trim().startsWith(text)) as HTMLButtonElement;if(!b)throw new Error('Missing button '+text);b.click();f.detectChanges();};
  return {f,c,post,remaining,click};
}
afterEach(()=>vi.restoreAllMocks());
describe('compact player challenge flow',()=>{
 it('starts from a visible fixture action and reveals one step at a time',async()=>{
   const {f,click}=await setup();expect(f.nativeElement.querySelector('[role=dialog]')).toBeNull();
   click('Challenge a player →');expect(f.nativeElement.querySelector('[role=dialog]')).toBeTruthy();
   expect(f.nativeElement.textContent).toContain('Step 1 of 3');
   expect(f.nativeElement.querySelector('.flow-actions button').disabled).toBe(true);
   expect(f.nativeElement.querySelector('.pick-tiles')).toBeNull();
   click('Who will win?');click('Continue →');expect(f.nativeElement.textContent).toContain('Step 2 of 3');
   expect(f.nativeElement.querySelector('.pick-tiles')).toBeTruthy();expect(f.nativeElement.querySelector('.mode-cards')).toBeNull();
 });
 it('requires a pick and opponent choice, and never sends a challenge before final review confirmation',async()=>{
   const {f,c,post,click}=await setup();click('Challenge a player →');click('Who will win?');click('Continue →');
   expect(f.nativeElement.querySelector('.flow-actions button:last-child').disabled).toBe(true);
   click('Liverpool');click('Continue →');expect(f.nativeElement.textContent).toContain('Step 3 of 3');
   expect(f.nativeElement.querySelector('.flow-actions button:last-child').disabled).toBe(true);
   c.chooseMode('find');f.detectChanges();click('Review challenge →');
   expect(c.reviewOpen()).toBe(true);expect(c.challengeOpen()).toBe(false);expect(post).not.toHaveBeenCalled();
   c.closeReview();f.detectChanges();expect(f.nativeElement.textContent).toContain('Step 3 of 3');
   click('Back');expect(f.nativeElement.textContent).toContain('Step 2 of 3');expect(c.pick()).toBe('HOME');
 });
 it('stops progression when kickoff arrives while the flow is open',async()=>{
   const {f,remaining,click}=await setup();click('Challenge a player →');remaining.set(0);f.detectChanges();
   expect(f.nativeElement.querySelector('.flow-body').textContent).toContain('Challenges have closed');
   expect(f.nativeElement.querySelector('.flow-actions')).toBeNull();
 });
 it('guests get clear sign-in actions inside the flow',async()=>{
   const {f,click}=await setup(false);click('Challenge a player →');
   expect(f.nativeElement.querySelector('.flow-body').textContent).toContain('Sign in');
   expect(f.nativeElement.querySelector('.type-list')).toBeNull();
 });
});

