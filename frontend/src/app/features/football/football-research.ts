import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { apiError } from '../../core/api-error';
import { FootballResearch, FootballResearchStore, ResearchTeam, researchFilters } from '../../core/football-research';
import { SeoService } from '../../core/seo.service';
import { FootballCompetition } from '../../core/models';
import { LoadError } from '../../shared/ui';
import { FootballTeamPicker } from './football-team-picker';
import { FootballResearchResults } from './football-research-results';

@Component({
  selector:'app-football-research',imports:[FormsModule,RouterLink,LoadError,FootballTeamPicker,FootballResearchResults],templateUrl:'./football-research.html',styleUrl:'./football-research.scss',
})
export class FootballResearchPage {
  private store=inject(FootballResearchStore);private route=inject(ActivatedRoute);private router=inject(Router);private destroy=inject(DestroyRef);private seo=inject(SeoService);private version=0;
  protected teamA=signal<ResearchTeam|null>(null);protected teamB=signal<ResearchTeam|null>(null);
  protected data=signal<FootballResearch|null>(null);protected loading=signal(false);protected error=signal('');protected formError=signal('');
  protected competitions=signal<FootballCompetition[]>([]);
  protected venue=signal<'all'|'home'|'away'>('all');protected competitionId=signal<number|null>(null);protected dateFrom=signal('');protected dateTo=signal('');
  protected seasons=signal<string[]>([]);protected season=signal('');
  constructor(){this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroy)).subscribe(()=>void this.load());}
  async load(force=false){
    const version=++this.version;const query=this.route.snapshot.queryParamMap;const filters=researchFilters(query);
    this.venue.set(filters?.venue??'all');this.competitionId.set(filters?.competitionId??null);this.dateFrom.set(filters?.dateFrom??query.get('dateFrom')??'');this.dateTo.set(filters?.dateTo??query.get('dateTo')??'');
    this.error.set('');this.season.set(filters?.season??'');
    const previous=this.data();
    if(!previous||previous.teamA.id!==filters?.teamA||previous.teamB.id!==filters?.teamB||previous.filters.venue!==filters?.venue||previous.filters.competitionId!==filters?.competitionId||previous.filters.dateFrom!==filters?.dateFrom||previous.filters.dateTo!==filters?.dateTo||previous.filters.season!==filters?.season)this.data.set(null);
    const a=Number(query.get('teamA')),b=Number(query.get('teamB'));
    if(this.teamA()?.id!==a)this.teamA.set(null);if(this.teamB()?.id!==b)this.teamB.set(null);
    this.loading.set(!!filters);
    try{
      if(!filters){
        const [teamA,teamB]=await Promise.all([Number.isSafeInteger(a)&&a>0?this.store.team(a):Promise.resolve(null),Number.isSafeInteger(b)&&b>0&&b!==a?this.store.team(b):Promise.resolve(null)]);
        if(version!==this.version)return;this.teamA.set(teamA);this.teamB.set(teamB);return;
      }
      if(filters.dateFrom&&filters.dateTo&&filters.dateFrom>filters.dateTo){this.formError.set('Choose an end date after the start date.');return;}
      const data=await this.store.research(filters,force);
      if(version!==this.version)return;this.data.set(data);this.competitions.set(data.competitions);this.seasons.set(data.seasons??[]);this.teamA.set(data.teamA);this.teamB.set(data.teamB);this.formError.set('');
      if(data.teamA.id!==filters.teamA||data.teamB.id!==filters.teamB)void this.router.navigate([],{relativeTo:this.route,queryParams:{teamA:data.teamA.id,teamB:data.teamB.id},queryParamsHandling:'merge',replaceUrl:true});
      this.seo.publish(`${data.teamA.name} vs ${data.teamB.name} history`,`Head-to-head scores and recent form from available football history.`,'/football/research',!data.metadata.isSimulated);
    }catch(err){if(version===this.version)this.error.set(apiError(err).message);}finally{if(version===this.version)this.loading.set(false);}
  }
  pick(which:'A'|'B',team:ResearchTeam){if(which==='A')this.teamA.set(team);else this.teamB.set(team);this.persist();}
  protected swap(){const a=this.teamA();this.teamA.set(this.teamB());this.teamB.set(a);this.persist();}
  protected changeVenue(venue:'all'|'home'|'away'){this.venue.set(venue);this.persist();}
  protected filterCompetition(value:string){this.competitionId.set(value?Number(value):null);this.persist();}
  protected filterSeason(value:string){this.season.set(value);this.persist();}
  protected changeSample(sample:{meetings?:'5'|'10'|'all';form?:5|10}){void this.router.navigate([],{relativeTo:this.route,queryParams:sample,queryParamsHandling:'merge'});}
  protected filterDates(){if(this.dateFrom()&&this.dateTo()&&this.dateFrom()>this.dateTo()){this.formError.set('Choose an end date after the start date.');return;}this.formError.set('');this.persist();}
  protected clearFilters(){this.venue.set('all');this.competitionId.set(null);this.dateFrom.set('');this.dateTo.set('');this.season.set('');this.formError.set('');this.persist();}
  private persist(){
    const version=++this.version;this.data.set(null);this.error.set('');
    void this.router.navigate([],{relativeTo:this.route,queryParams:{teamA:this.teamA()?.id??null,teamB:this.teamB()?.id??null,venue:this.venue()==='all'?null:this.venue(),competitionId:this.competitionId(),dateFrom:this.dateFrom()||null,dateTo:this.dateTo()||null,season:this.season()||null},queryParamsHandling:'merge'}).then(()=>{if(version===this.version)void this.load();});
  }
}
