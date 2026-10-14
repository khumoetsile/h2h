import { Injectable, inject } from '@angular/core';
import { Api } from './api.service';
import { FootballCompetition, FootballTeam } from './models';

export interface ResearchTeam extends FootballTeam { competitions?: Array<{id:number;code:string;name:string}>; }
export interface ResearchSummary {
  played:number; wins:number; draws:number; losses:number; goalsFor:number; goalsAgainst:number;
  bothTeamsScored:number; over25:number; cleanSheets:number; averageGoals:number|null;
  goalsForPerMatch:number|null; goalsAgainstPerMatch:number|null; bothTeamsScoredPct:number|null;
  over25Pct:number|null; cleanSheetsPct:number|null;
  over15?:number;over35?:number;over15Pct?:number|null;over35Pct?:number|null;opponentCleanSheets?:number;winPct?:number|null;drawPct?:number|null;lossPct?:number|null;
}
export interface ResearchMeeting {
  id:string; fixtureId:number|null; kickoffAt:string; competition:{id:number|null;code:string|null;name:string};
  homeTeam:ResearchTeam; awayTeam:ResearchTeam; homeScore:number; awayScore:number; teamAScore:number;
  teamBScore:number; teamAVenue:'HOME'|'AWAY'; outcome:'W'|'D'|'L'; source:'PROVIDER'|'SYNCED'|'ARCHIVE'; isSimulated:boolean;
  date?:string;season?:string;halfTime?:Array<number|null>;statistics?:Record<string,Array<number|null>>|null;statisticsSource?:string;sourceName?:string;sourceUrl?:string|null;license?:string|null;
}
export interface ResearchFormMatch {
  id:string; fixtureId:number|null; kickoffAt:string; competition:{id:number|null;code:string|null;name:string};
  opponent:ResearchTeam; venue:'HOME'|'AWAY'; teamScore:number; opponentScore:number; outcome:'W'|'D'|'L';
  source:'PROVIDER'|'SYNCED'|'ARCHIVE'; isSimulated:boolean;date?:string;season?:string;
}
export interface ResearchFilters {teamA:number;teamB:number;venue:'all'|'home'|'away';competitionId?:number;dateFrom?:string;dateTo?:string;season?:string;meetings?:'5'|'10'|'20'|'all';form?:5|10|20;page?:number;}
export interface FootballResearch {
  teamA:ResearchTeam;teamB:ResearchTeam;filters:ResearchFilters;nextFixture?:{id:number;kickoffAt:string}|null;
  headToHead:{status:'AVAILABLE'|'EMPTY'|'PARTIAL'|'UNAVAILABLE';matches:ResearchMeeting[];summary:ResearchSummary;byVenue:{home:ResearchSummary;away:ResearchSummary};total?:number;page?:number;hasMore?:boolean;availableMatches?:number};
  form:{teamA:ResearchForm;teamB:ResearchForm};
  insights?:Array<{key:string;numerator:number;denominator:number;text:string}>;
  trends?:{meetings:GoalTrend[];teamA:GoalTrend[];teamB:GoalTrend[]};seasons?:string[];
  metadata:{lastMatchDate?:string|null;historyCoverage?:string|null;provider:string;source:'PROVIDER'|'SYNCED'|'ARCHIVE'|'COMBINED'|null;updatedAt:string|null;stale:boolean;providerStatus:'AVAILABLE'|'UNAVAILABLE'|'UNSUPPORTED'|'STORED';sampleLimit:number;historyLimit:number|null;excludedUnverified:number;notice:string;isSimulated:boolean;scoreBasis?:'REGULATION'|'REPORTED_FINAL';conflicts?:number;truncated?:boolean;sources?:Array<{name:string;url:string|null;license:string|null}>;imports?:Array<{competition_code:string;season:string;last_imported_at:string;status:string;match_count:number;source_url:string;license:string}>};
  competitions:FootballCompetition[];serverNow:string;
}
export interface ResearchForm {matches:ResearchFormMatch[];summary:ResearchSummary;home?:ResearchSummary;away?:ResearchSummary;}
export interface GoalTrend {date:string;goalsFor:number;goalsAgainst:number;total?:number;}

export function researchMetric(value:number|null|undefined, decimals=0, suffix='') {
  return value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US',{minimumFractionDigits:decimals,maximumFractionDigits:decimals}) + suffix;
}
export function researchFilters(query:{get:(key:string)=>string|null}):ResearchFilters|null {
  const id=(key:string)=>{const value=Number(query.get(key));return Number.isSafeInteger(value)&&value>0?value:null;};
  const teamA=id('teamA'),teamB=id('teamB');
  if(!teamA||!teamB||teamA===teamB)return null;
  const venue=query.get('venue');
  const date=(key:string)=>{const value=query.get(key);return value&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value:undefined;};
  const meetings=query.get('meetings'), form=query.get('form'), season=query.get('season');
  return {teamA,teamB,venue:venue==='home'||venue==='away'?venue:'all',...(id('competitionId')?{competitionId:id('competitionId')!}:{}),...(date('dateFrom')?{dateFrom:date('dateFrom')}:{}),...(date('dateTo')?{dateTo:date('dateTo')}:{}),...(meetings==='5'||meetings==='10'||meetings==='20'?{meetings}:{}),...(['5','10','20'].includes(form||'')?{form:Number(form) as 5|10|20}:{}),...(season&&/^\d{4}(?:-\d{2})?$/.test(season)?{season}:{} )};
}

/** Short-lived display cache; simultaneous selectors/pages share one request. Failed responses are never cached. */
@Injectable({providedIn:'root'})
export class FootballResearchStore {
  private api=inject(Api);
  private cache=new Map<string,{data:unknown;until:number}>();
  private pending=new Map<string,Promise<unknown>>();
  private trimCache(){for(const [key,entry]of this.cache)if(entry.until<=Date.now())this.cache.delete(key);while(this.cache.size>100)this.cache.delete(this.cache.keys().next().value!);}
  private request<T>(path:string,params:Record<string,string|number|undefined>,ttl:number,force=false):Promise<T> {
    const key=path+JSON.stringify(params);
    this.trimCache();
    const cached=this.cache.get(key);
    if(!force&&cached&&cached.until>Date.now())return Promise.resolve(cached.data as T);
    const current=this.pending.get(key);
    if(current)return current as Promise<T>;
    const request=this.api.get<T>(path,params).then(data=>{this.cache.set(key,{data,until:Date.now()+ttl});this.trimCache();return data;}).finally(()=>this.pending.delete(key));
    this.pending.set(key,request);return request;
  }
  teams(q:string,force=false) {return this.request<{teams:ResearchTeam[];total:number;provider:string;lastUpdatedAt:string|null}>('/football/teams',{q:q.trim().slice(0,80),limit:20},60000,force);}
  team(id:number) {return this.request<{team:ResearchTeam}>('/football/research/teams/'+id,{},120000).then(r=>r.team);}
  research(filters:ResearchFilters,force=false) {return this.request<FootballResearch>('/football/research',{...filters},120000,force);}
}
