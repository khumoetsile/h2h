import { DatePipe } from '@angular/common';
import { Component, computed, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FootballResearch, researchMetric } from '../../core/football-research';

@Component({
  selector:'app-football-research-results',imports:[DatePipe,RouterLink],templateUrl:'./football-research-results.html',styleUrl:'./football-research-results.scss',
})
export class FootballResearchResults {
  readonly data=input.required<FootballResearch>();readonly compact=input(false);
  protected metric=researchMetric;protected tab=signal<'meetings'|'form'>('meetings');protected shown=signal(8);
  protected matches=computed(()=>this.data().headToHead.matches.slice(0,this.shown()));
  protected forms=computed(()=>[{team:this.data().teamA,data:this.data().form.teamA},{team:this.data().teamB,data:this.data().form.teamB}]);
  protected source=computed(()=>this.data().metadata.source==='PROVIDER'?'Provider history':this.data().metadata.source==='COMBINED'?'Provider + synced history':this.data().metadata.source==='SYNCED'?'Synced history':'No history source');
}
