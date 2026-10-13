import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { MatchPlayPage } from './match-play';
import { Api } from '../../core/api.service';
import { Toast } from '../../core/toast.service';
const match={id:1,code:'M-RECOVERY',category:'SKILL_GAME',viewerId:9,game:{slug:'reaction-rush',name:'Reaction Rush'},players:[],status:'IN_PROGRESS'};
const start={game:'reaction-rush',spec:{},deadline:new Date(Date.now()+600000).toISOString()};
const result={actions:{rounds:[{hit:true,reactionMs:250}]},clientElapsedMs:5000};
describe('game result recovery',()=>{
  afterEach(()=>{TestBed.resetTestingModule();sessionStorage.clear();vi.useRealTimers();});
  async function page(post:ReturnType<typeof vi.fn>){TestBed.configureTestingModule({imports:[MatchPlayPage],providers:[provideRouter([]),{provide:Api,useValue:{get:vi.fn().mockResolvedValue({match}),post}},{provide:Toast,useValue:{dismiss:vi.fn()}}]});await TestBed.compileComponents();const f=TestBed.createComponent(MatchPlayPage);f.componentRef.setInput('code','M-RECOVERY');vi.spyOn(TestBed.inject(Router),'navigate').mockResolvedValue(true);return f;}
  it('keeps a failed result scoped to the user/match and teardown cancels automatic retries',async()=>{vi.useFakeTimers();const post=vi.fn().mockImplementation(path=>path.endsWith('/start')?Promise.resolve(start):Promise.reject({status:0}));const f=await page(post);await f.componentInstance.ngOnInit();await f.componentInstance.submit(result);expect(JSON.parse(sessionStorage.getItem('h2h.result:9:M-RECOVERY')!)).toEqual(result);expect(post).toHaveBeenCalledTimes(2);f.destroy();await vi.advanceTimersByTimeAsync(10000);expect(post).toHaveBeenCalledTimes(2);});
  it('resubmits a saved result on reload and clears it after server confirmation',async()=>{sessionStorage.setItem('h2h.result:9:M-RECOVERY',JSON.stringify(result));const post=vi.fn().mockImplementation(path=>Promise.resolve(path.endsWith('/start')?start:{result:{valid:true},match:{...match,status:'COMPLETED'}}));const f=await page(post);await f.componentInstance.ngOnInit();await Promise.resolve();await Promise.resolve();expect(post).toHaveBeenCalledWith('/matches/M-RECOVERY/result',result);expect(sessionStorage.getItem('h2h.result:9:M-RECOVERY')).toBeNull();expect(TestBed.inject(Router).navigate).toHaveBeenCalledWith(['/match','M-RECOVERY','result'],{replaceUrl:true});});
});
