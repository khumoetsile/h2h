import {describe,it,expect} from 'vitest';
import {dashboardNextAction} from './next-action';
import {MatchSummary,Challenge} from './models';
import {DailyOverview} from './daily-predictions';
const now=Date.parse('2026-10-22T12:00:00Z');
const invitation=(expiresAt:string)=>({status:'PENDING',expiresAt,challenger:{username:'friend'}} as Challenge);
describe('dashboard action priority',()=>{
  it('puts an actual chess turn ahead of an invitation or discovery',()=>{
    const match={chess:{isYourTurn:true,code:'CH-ABC'},opponent:{username:'friend'}} as MatchSummary;
    expect(dashboardNextAction([match],[invitation('2026-10-23')],null,[],now).link).toBe('/chess/CH-ABC');
  });
  it('resumes skill gameplay before a pending invitation but not after submission',()=>{
    const m={category:'SKILL_GAME',status:'IN_PROGRESS',submitted:false,code:'H2H-ABCDEFGH',game:{name:'Shootout'}} as MatchSummary;
    const invites=[invitation('2026-10-23')];
    expect(dashboardNextAction([m],invites,null,[],now).link).toBe('/match/H2H-ABCDEFGH');
    expect(dashboardNextAction([{...m,submitted:true}],invites,null,[],now).link).toContain('/challenges');
  });
  it('ignores expired invitations and stale prediction eligibility at the cutoff',()=>{
    const daily={challenges:[{canSubmit:true,pick:null,kickoffAt:'2026-10-22T11:59:00Z'}]} as DailyOverview;
    expect(dashboardNextAction([],[invitation('2026-10-21')],daily,[],now).link).toBe('/games');
  });
  it('offers a genuinely open unsubmitted prediction without a wallet action',()=>{
    const daily={challenges:[{canSubmit:true,pick:null,kickoffAt:'2026-10-23',homeTeam:'Home',awayTeam:'Away'}]} as DailyOverview;
    expect(dashboardNextAction([],[],daily,[],now).link).toBe('/daily-predictions');
  });
});
