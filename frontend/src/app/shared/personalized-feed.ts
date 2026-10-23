import { Component, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api.service';
import { Favourites } from '../core/favourites';
import { FootballFixture } from '../core/models';

@Component({
  selector: 'app-personalized-feed', imports: [RouterLink, DatePipe],
  template: `<section class="card feed" aria-label="Your football feed"><h2>Your football</h2><p class="muted small">Follow teams and leagues on a fixture page. Preferences stay in this browser for your account.</p>
    <div class="links">@for (v of favourites.items(); track v.kind + v.id) { <button class="btn btn-sm" (click)="favourites.toggle(v)" [attr.aria-label]="'Unfollow ' + v.name">★ {{ v.name }} ×</button> }</div>
    @if (loading()) { <p role="status">Loading your fixtures…</p> }
    @if (error()) { <p role="status">{{ error() }}</p><button class="btn btn-sm" (click)="load()">Retry</button> }
    @for (f of fixtures().slice(0,4); track f.id) { <a class="fixture" [routerLink]="['/football', f.id]"><strong>{{ f.homeTeam.name }} vs {{ f.awayTeam.name }}</strong><span class="muted small">{{ f.competition.name }} · {{ f.kickoffAt | date:'EEE d MMM, HH:mm' }} · {{ f.openChallenges }} open challenges</span></a> }
    @if (!loading() && !error() && !fixtures().length) { <p class="muted small">{{ favourites.items().length ? 'No upcoming fixtures found for your favourites.' : 'Choose a team to build your feed.' }}</p> }
    @if (recent().length) { <h3>Recent results for your favourites</h3>@for(f of recent().slice(0,3);track f.id){<a class="fixture" [routerLink]="['/football',f.id]"><strong>{{f.homeTeam.name}} {{f.homeScore}}–{{f.awayScore}} {{f.awayTeam.name}}</strong><span class="muted small">{{f.kickoffAt | date:'d MMM'}} · {{f.competition.name}} · Review analysis →</span></a>} }
    @if(favourites.items().length>6){<p class="muted small">Showing recent results for your first six favourites. Upcoming fixtures include all your favourites.</p>}
    <a routerLink="/football">Browse fixtures and match analysis →</a></section>`,
  styles: [`.feed { margin-bottom:16px; display:flex; flex-direction:column; gap:12px; } .links { display:flex; gap:8px; flex-wrap:wrap; } .fixture { display:flex; flex-direction:column; gap:4px; padding:12px 0; border-bottom:1px solid var(--border); overflow-wrap:anywhere; }`],
})
export class PersonalizedFeed {
  protected favourites = inject(Favourites);
  private api = inject(Api);
  protected fixtures = signal<FootballFixture[]>([]);
  protected recent = signal<FootballFixture[]>([]);
  protected loading = signal(false);
  protected error = signal('');
  private version = 0;
  constructor() { effect(() => { this.favourites.items(); void this.load(); }); }
  protected async load() {
    const version = ++this.version;
    const favourites = this.favourites.items();
    this.fixtures.set([]); this.recent.set([]); this.error.set(''); this.loading.set(!!favourites.length);
    if (!favourites.length) return;
    const recentRequest = Promise.allSettled(favourites.slice(0,6).map(v=>this.api.get<{fixtures:FootballFixture[]}>('/football/fixtures',{status:'completed',pageSize:3,[v.kind==='team'?'teamId':'competitionId']:v.id})));
    const results = await Promise.allSettled(favourites.map(v => this.api.get<{fixtures: FootballFixture[]}>('/football/fixtures', {status:'upcoming', pageSize:20, [v.kind === 'team' ? 'teamId' : 'competitionId']:v.id})));
    const past = await recentRequest;
    if (version !== this.version) return;
    const recent = past.flatMap(r=>r.status==='fulfilled'?r.value.fixtures:[]).filter(f=>f.status==='FINISHED'&&f.homeScore!==null&&f.awayScore!==null);
    this.recent.set([...new Map(recent.map(f=>[f.id,f])).values()].sort((a,b)=>Date.parse(b.kickoffAt)-Date.parse(a.kickoffAt)));
    const fixtures = results.flatMap(r => r.status === 'fulfilled' ? r.value.fixtures : []);
    this.fixtures.set([...new Map(fixtures.map(f => [f.id, f])).values()].sort((a,b) => Date.parse(a.kickoffAt)-Date.parse(b.kickoffAt)).slice(0,12));
    if ([...results,...past].some(r => r.status === 'rejected')) this.error.set('Some favourite fixtures could not be loaded.');
    this.loading.set(false);
  }
}
