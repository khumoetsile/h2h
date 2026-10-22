import { FavouriteButton } from '../../shared/favourite-button';
import { Component, inject, input, OnChanges, OnInit, SimpleChanges, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { SeoService } from '../../core/seo.service';
import { FootballFixture } from '../../core/models';
import { LoadError, Spinner } from '../../shared/ui';

interface TeamPageData {
  team: { id: number; name: string; shortName: string | null; crestUrl: string | null; lastUpdatedAt: string | null };
  upcoming: FootballFixture[];
  recentResults: FootballFixture[];
  lastUpdatedAt: string | null;
}

@Component({
  selector: 'app-football-team',
  imports: [FavouriteButton, DatePipe, RouterLink, MatIconModule, LoadError, Spinner],
  template: `
    <div class="page">
      <a class="back muted small" routerLink="/football"><mat-icon>arrow_back</mat-icon>Football</a>
      @if (error()) {
        <app-load-error [message]="error()" (retry)="load()" />
      } @else if (!data()) {
        <app-spinner />
      } @else {
        <header class="team-head card">
          @if (data()!.team.crestUrl) { <img [src]="data()!.team.crestUrl!" [alt]="data()!.team.name + ' crest'" width="52" height="52" /> }
          <div><h1>{{ data()!.team.name }}</h1><p class="muted small">Team fixtures and recent results</p></div>
          <a class="btn btn-primary btn-sm" routerLink="/football/research" [queryParams]="{teamA:data()!.team.id}">Compare a rival →</a>
        </header>
        <app-favourite-button [id]="data()!.team.id" [name]="data()!.team.name" />
        <section>
          <div class="section-title"><div><h2>Upcoming fixtures</h2><p class="sub">Matches found in synced football data</p></div></div>
          @if (!data()!.upcoming.length) { <p class="muted">No upcoming fixtures are currently available.</p> }
          <div class="card-grid">
            @for (f of data()!.upcoming; track f.id) { <a class="card fixture card-interactive" [routerLink]="['/football', f.id]">
              <span class="muted tiny">{{ f.competition.name }} · {{ f.kickoffAt | date: 'EEE d MMM, HH:mm' }}</span>
              <strong>{{ f.homeTeam.name }} vs {{ f.awayTeam.name }}</strong>
              <span class="small">View match centre <mat-icon inline>chevron_right</mat-icon></span>
            </a> }
          </div>
        </section>
        <section>
          <div class="section-title"><div><h2>Recent results</h2><p class="sub">Completed matches available from the provider</p></div></div>
          @if (!data()!.recentResults.length) { <p class="muted">No recent results are currently available.</p> }
          <div class="card-grid">
            @for (f of data()!.recentResults; track f.id) { <a class="card fixture card-interactive" [routerLink]="['/football', f.id]">
              <span class="muted tiny">{{ f.competition.name }} · {{ f.kickoffAt | date: 'EEE d MMM yyyy' }}</span>
              <strong>{{ f.homeTeam.name }} {{ f.homeScore }}–{{ f.awayScore }} {{ f.awayTeam.name }}</strong>
              <span class="small">View match centre <mat-icon inline>chevron_right</mat-icon></span>
            </a> }
          </div>
        </section>
        @if (data()!.lastUpdatedAt) { <p class="muted tiny">Football data last updated {{ data()!.lastUpdatedAt | date: 'EEE d MMM, HH:mm' }}.</p> }
      }
    </div>
  `,
  styles: [`
    .back { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 16px; }
    .team-head { display: flex; align-items: center; gap: 14px; padding: 18px; margin-bottom: 24px; flex-wrap:wrap; }.team-head>div{flex:1;min-width:0}.team-head h1{overflow-wrap:anywhere}
    .team-head img { object-fit: contain; }
    .team-head h1 { margin-bottom: 2px; }
    .section-title { margin: 20px 0 10px; }
    .fixture { display: flex; flex-direction: column; gap: 8px; padding: 16px; color: inherit; text-decoration: none; min-width: 0; }
    .fixture strong { overflow-wrap: anywhere; }
  `],
})
export class FootballTeamPage implements OnInit,OnChanges {
  readonly teamId = input.required<string>();
  private api = inject(Api);
  private seo = inject(SeoService);
  protected data = signal<TeamPageData | null>(null);
  protected error = signal('');
  private loadVersion=0;

  ngOnInit() { this.load(); }
  ngOnChanges(changes:SimpleChanges){if(changes['teamId']&&!changes['teamId'].firstChange){this.data.set(null);void this.load();}}

  async load() {
    this.error.set('');
    const version=++this.loadVersion;const teamId=this.teamId();
    try {
      const response = await this.api.get<TeamPageData>(`/football/teams/${teamId}`);
      if(version!==this.loadVersion||teamId!==this.teamId())return;
      this.data.set(response);
      this.seo.publish(
        `${response.team.name} fixtures and results`,
        `Browse upcoming fixtures and recent results for ${response.team.name}, with links to available Head2Head match centres.`,
        `/football/teams/${response.team.id}`,
        !response.upcoming.some((fx) => fx.isSimulated) && !response.recentResults.some((fx) => fx.isSimulated),
      );
    } catch (err) {
      if(version===this.loadVersion)this.error.set(apiError(err).message);
    }
  }
}
