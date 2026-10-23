import {TestBed} from '@angular/core/testing';
import {provideRouter,Router} from '@angular/router';
import {MatchDetailPage} from './match-detail';
import {Api} from '../../core/api.service';
import {AuthService} from '../../core/auth.service';
import {Toast} from '../../core/toast.service';
import {RematchService} from '../../core/rematch.service';
import {MatchView} from '../../core/models';
describe('result rematch journeys',()=>{
  function setup(category:'FOOTBALL'|'CHESS'|'SKILL_GAME',status='COMPLETED'){
    const post=vi.fn().mockResolvedValue({});
    TestBed.configureTestingModule({providers:[provideRouter([]),{provide:Api,useValue:{post}},{provide:AuthService,useValue:{isAdmin:()=>false}},{provide:Toast,useValue:{success:vi.fn(),error:vi.fn()}}]});
    const fixture=TestBed.createComponent(MatchDetailPage);const page=fixture.componentInstance;
    const navigate=vi.spyOn(TestBed.inject(Router),'navigate').mockResolvedValue(true);
    (page as any).match.set({category,status,viewerId:1,players:[{userId:1,username:'me'},{userId:2,username:'friend',avatarColor:'#fff',isBot:false}],game:{id:3},stake:10} as unknown as MatchView);
    return {page,post,navigate};
  }
  it('football asks for a new fixture without creating a skill challenge',async()=>{
    const {page,post,navigate}=setup('FOOTBALL');await page.rematch();
    expect(post).not.toHaveBeenCalled();expect(navigate).toHaveBeenCalledWith(['/football']);
    expect(TestBed.inject(RematchService).current()?.username).toBe('friend');
  });
  it('chess returns to setup with the intended opponent',async()=>{
    const {page,post,navigate}=setup('CHESS');await page.rematch();
    expect(post).not.toHaveBeenCalled();expect(navigate).toHaveBeenCalledWith(['/chess'],{queryParams:{opponent:'friend'}});
  });
  it('does not create a rematch for an unresolved match',async()=>{
    const {page,post,navigate}=setup('SKILL_GAME','IN_PROGRESS');await page.rematch();
    expect(post).not.toHaveBeenCalled();expect(navigate).not.toHaveBeenCalled();
  });
});
