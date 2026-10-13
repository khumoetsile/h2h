import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FootballResearch, FootballResearchStore, ResearchMeeting, ResearchSummary, researchMetric } from '../../core/football-research';
import { GoalTrendChart } from './goal-trend';
import { apiError } from '../../core/api-error';

@Component({
  selector:'app-football-research-results',imports:[DatePipe,RouterLink,GoalTrendChart],templateUrl:'./football-research-results.html',styleUrl:'./football-research-results.scss',
})
export class FootballResearchResults {
  readonly data=input.required<FootballResearch>();readonly compact=input(false);readonly inlineHistory=input(false);
  readonly busy=input(false);readonly sampleChange=output<{meetings?:'5'|'10'|'all';form?:5|10}>();
  private store=inject(FootballResearchStore);private version=0;
  protected metric=researchMetric;protected tab=signal<'overview'|'meetings'|'form'|'venues'|'goals'>('overview');protected matches=signal<ResearchMeeting[]>([]);
  protected moreBusy=signal(false);protected moreError=signal('');protected hasMore=signal(false);private page=1;
  constructor(){effect(()=>{if(this.inlineHistory())this.tab.set('meetings');});effect(()=>{const d=this.data();++this.version;this.matches.set(d.headToHead.matches);this.hasMore.set(!!d.headToHead.hasMore);this.page=d.headToHead.page??1;this.moreError.set('');this.moreBusy.set(false);});}
  protected forms=computed(()=>[{team:this.data().teamA,data:this.data().form.teamA},{team:this.data().teamB,data:this.data().form.teamB}]);
  protected source=computed(()=>this.data().metadata.source==='ARCHIVE'?'Historical archive':this.data().metadata.source==='COMBINED'?'Archive + synced scores':this.data().metadata.source==='SYNCED'?'Synced scores':'No stored scores');
  protected sections=[{id:'overview' as const,label:'Overview'},{id:'meetings' as const,label:'Past meetings'},{id:'form' as const,label:'Recent form'},{id:'venues' as const,label:'Home & away'},{id:'goals' as const,label:'Goal trends'}];
  protected stats=[{key:'shots',label:'Shots'},{key:'shotsOnTarget',label:'On target'},{key:'possession',label:'Possession %'},{key:'corners',label:'Corners'},{key:'fouls',label:'Fouls'},{key:'yellowCards',label:'Yellow cards'},{key:'redCards',label:'Red cards'}];
  protected hasStatistics(m:ResearchMeeting){return this.stats.some(s=>m.statistics?.[s.key]?.some(value=>value!=null));}
  protected rate=(n:number,denominator:number)=>denominator?Math.round(n/denominator*100):0;
  protected summaryMetrics(s:ResearchSummary){return [{label:'Goals scored',value:s.goalsFor},{label:'Goals conceded',value:s.goalsAgainst},{label:'Clean sheets',value:s.cleanSheets},{label:'Scored / match',value:s.goalsForPerMatch},{label:'Conceded / match',value:s.goalsAgainstPerMatch}];}
  protected async more(){if(this.moreBusy())return;const version=this.version;this.moreBusy.set(true);this.moreError.set('');try{const d=await this.store.research({...this.data().filters,page:this.page+1});if(version!==this.version)return;this.matches.update(rows=>[...rows,...d.headToHead.matches]);this.page++;this.hasMore.set(!!d.headToHead.hasMore);}catch(err){if(version===this.version)this.moreError.set(apiError(err).message);}finally{if(version===this.version)this.moreBusy.set(false);}}
}
