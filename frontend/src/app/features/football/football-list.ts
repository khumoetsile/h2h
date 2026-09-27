import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { FootballCompetition, FootballFixture, MatchStatus, MatchSummary, MatchView, OpenFootballChallenge, Paged } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { Toast } from '../../core/toast.service';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar, EmptyState, LoadError } from '../../shared/ui';

type SubTab = 'fixtures' | 'open' | 'mine';

const MY_SECTIONS: { key: MatchStatus | 'DRAW'; label: string }[] = [
  { key: 'WAITING', label: 'Waiting for opponent' },
  { key: 'MATCHED', label: 'Locked in' },
  { key: 'IN_PROGRESS', label: 'In progress' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'DRAW', label: 'Draw' },
  { key: 'CANCELLED', label: 'Cancelled' },
  { key: 'VOID', label: 'Void' },
];

/**
 * "Football" tab. Three views: browse real fixtures, discover other players'
 * open "Find an opponent" challenges (this is what makes matchmaking a real,
 * visible 1v1 rather than an invisible queue), and track your own challenges
 * end to end. Head2Head never creates the football match — fixtures come
 * from an external provider via the backend; a challenge is always one real
 * player against another.
 */
@Component({
  selector: 'app-football-list',
  imports: [RouterLink, MatIconModule, MoneyPipe, Avatar, EmptyState, LoadError],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Play</h1>
          <p class="sub">Pick a category to challenge someone.</p>
        </div>
      </div>

      <div class="segmented tabs play-tabs">
        <a routerLink="/games"><mat-icon inline>sports_esports</mat-icon> Games</a>
        <button class="active"><mat-icon inline>sports_soccer</mat-icon> Football</button>
      </div>

      <div class="segmented tabs sub-tabs">
        <button [class.active]="subTab() === 'fixtures'" (click)="setSubTab('fixtures')">Fixtures</button>
        <button [class.active]="subTab() === 'open'" (click)="setSubTab('open')">
          Open Challenges @if (openChallenges() && openChallenges()!.length) { <span class="count">{{ openChallenges()!.length }}</span> }
        </button>
        <button [class.active]="subTab() === 'mine'" (click)="setSubTab('mine')">Mine</button>
      </div>

      @if (subTab() === 'fixtures') {
        <div class="segmented tabs comp-tabs">
          <button [class.active]="competitionId() === null" (click)="setCompetition(null)">All</button>
          @for (c of competitions(); track c.id) {
            <button [class.active]="competitionId() === c.id" (click)="setCompetition(c.id)">{{ c.code }}</button>
          }
        </div>

        @if (error()) {
          <app-load-error [message]="error()" (retry)="load()" />
        } @else if (!fixtures()) {
          <div class="fixture-list">
            @for (i of [1,2,3,4]; track i) {
              <div class="card fixture-card"><div class="skeleton" style="height:16px;width:60%"></div><div class="skeleton" style="height:22px;width:90%;margin-top:10px"></div></div>
            }
          </div>
        } @else if (fixtures()!.length === 0) {
          <app-empty icon="sports_soccer" title="No upcoming fixtures right now" text="Please check back soon." />
        } @else {
          <div class="fixture-list">
            @for (f of fixtures(); track f.id) {
              <a class="card fixture-card card-interactive fade-in" [routerLink]="['/football', f.id]">
                <div class="fc-top">
                  <span class="muted small">{{ f.competition.name }}</span>
                  @if (f.status === 'LIVE') {
                    <span class="chip chip-win"><span class="live-dot"></span>LIVE @if (f.minute) { {{ f.minute }}' }</span>
                  } @else {
                    <span class="muted tiny">{{ kickoffLabel(f.kickoffAt) }}</span>
                  }
                </div>
                <div class="fc-teams">
                  <span class="team">{{ f.homeTeam.name }}</span>
                  @if (f.status === 'LIVE' || f.status === 'FINISHED') {
                    <span class="score">{{ f.homeScore }} – {{ f.awayScore }}</span>
                  } @else {
                    <span class="vs-sep">vs</span>
                  }
                  <span class="team">{{ f.awayTeam.name }}</span>
                </div>
                <div class="fc-foot">
                  @if (f.isSimulated) { <span class="muted tiny">Simulated demo fixture</span> } @else { <span class="muted tiny">Live football data</span> }
                  @if (f.status === 'SCHEDULED') { <span class="btn btn-sm btn-primary">Challenge<mat-icon>chevron_right</mat-icon></span> }
                </div>
              </a>
            }
          </div>
        }
      }

      @if (subTab() === 'open') {
        <p class="muted small section-note">Players looking for an opponent — join one directly, or start your own from a fixture.</p>
        @if (openError()) {
          <app-load-error [message]="openError()" (retry)="loadOpen()" />
        } @else if (!openChallenges()) {
          <app-empty icon="hourglass_empty" title="Loading open challenges…" />
        } @else if (openChallenges()!.length === 0) {
          <app-empty icon="swords" title="No open challenges right now" text="Be the first — pick a fixture and choose Find Opponent." />
        } @else {
          <div class="fixture-list">
            @for (c of openChallenges(); track c.matchId) {
              <div class="card fixture-card fade-in open-card">
                <div class="fc-top">
                  <span class="chip chip-demo">Open challenge</span>
                  <span class="money accent stake-tag">{{ c.stake | money }}</span>
                </div>
                <div class="fc-teams">
                  <span class="team">{{ c.homeTeam }}</span>
                  <span class="vs-sep">vs</span>
                  <span class="team">{{ c.awayTeam }}</span>
                </div>
                <p class="question-line">{{ c.challengeType.question }}</p>
                <div class="creator-row">
                  <app-avatar [name]="c.creator.username" [color]="c.creator.avatarColor" [size]="26" />
                  <span class="small">{{ c.creator.username }} picked <strong>{{ c.creatorPickLabel }}</strong></span>
                </div>
                <button class="btn btn-primary btn-block" [disabled]="joining() === c.matchId" (click)="openJoinConfirm(c)">
                  <mat-icon>swords</mat-icon> Join Challenge
                </button>
              </div>
            }
          </div>
        }
      }

      @if (subTab() === 'mine') {
        @if (mineError()) {
          <app-load-error [message]="mineError()" (retry)="loadMine()" />
        } @else if (!mine()) {
          <app-empty icon="hourglass_empty" title="Loading your challenges…" />
        } @else if (mine()!.length === 0) {
          <app-empty icon="swords" title="You have no football challenges yet" text="Pick a fixture to start your first one." />
        } @else {
          @for (section of sections(); track section.key) {
            <div class="my-section">
              <h3>{{ section.label }} <span class="muted small">({{ section.items.length }})</span></h3>
              <div class="list">
                @for (m of section.items; track m.id) {
                  <a class="list-item mine-row" [routerLink]="isActiveStatus(m.status) ? ['/match', m.code] : ['/matches', m.code]">
                    <div class="grow">
                      <div class="t">{{ m.football?.homeTeam }} vs {{ m.football?.awayTeam }}</div>
                      <div class="muted small">{{ m.football?.questionName }} · <span class="money">{{ m.stake | money }}</span></div>
                    </div>
                    @if (m.opponent) { <span class="muted tiny">vs {{ m.opponent.username }}</span> }
                    <mat-icon class="chev">chevron_right</mat-icon>
                  </a>
                }
              </div>
            </div>
          }
        }
      }
    </div>

    @if (joinConfirmTarget(); as c) {
      <div class="confirm-backdrop" (click)="closeJoinConfirm()">
        <div class="confirm-card fade-in" (click)="$event.stopPropagation()">
          <h2>Before you join</h2>
          <p class="text-2">You are entering a 1v1 challenge with another player.</p>
          <div class="confirm-summary">
            <div class="cs-row"><span class="muted small">Fixture</span><strong>{{ c.homeTeam }} vs {{ c.awayTeam }}</strong></div>
            <div class="cs-row"><span class="muted small">Question</span><strong>{{ c.challengeType.question }}</strong></div>
            <div class="cs-row"><span class="muted small">Your pick</span><strong>{{ opponentPickLabel(c) }}</strong></div>
            <div class="cs-row"><span class="muted small">Stake</span><strong class="money">{{ c.stake | money }}</strong></div>
          </div>
          <p class="fee-note"><mat-icon inline>info</mat-icon> Leaving after the challenge is locked will incur a <strong>P0.50</strong> abandonment fee.</p>
          @if (joinError()) { <div class="form-error"><mat-icon>error</mat-icon>{{ joinError() }}</div> }
          <div class="confirm-actions">
            <button class="btn btn-ghost btn-block" (click)="closeJoinConfirm()">Cancel</button>
            <button class="btn btn-primary btn-block" [disabled]="!!joining()" (click)="confirmJoin(c)">
              @if (joining() === c.matchId) { Joining… } @else { Lock In }
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .play-tabs { margin-bottom: 12px; }
    .sub-tabs { margin-bottom: 12px; }
    .comp-tabs { margin-bottom: 16px; }
    .count { background: var(--accent); color: var(--accent-ink); border-radius: 9px; padding: 0 6px; font-size: 11px; margin-left: 4px; }
    .section-note { margin-bottom: 12px; }
    .fixture-list { display: grid; gap: 12px; grid-template-columns: 1fr; }
    @media (min-width: 640px) { .fixture-list { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 960px) { .fixture-list { grid-template-columns: repeat(3, 1fr); } }
    .fixture-card { display: flex; flex-direction: column; gap: 10px; padding: 16px; }
    .fc-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .fc-teams { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 700; font-family: var(--font-display); font-size: 15px; }
    .team { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .team:last-child { text-align: right; }
    .vs-sep { color: var(--muted); font-size: 12px; font-weight: 500; flex-shrink: 0; }
    .score { color: var(--accent); flex-shrink: 0; font-size: 17px; }
    .fc-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
    .live-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: blink 1.4s infinite; margin-right: 4px; }
    @keyframes blink { 50% { opacity: .3; } }

    .open-card { gap: 8px; }
    .stake-tag { font-size: 16px; font-family: var(--font-display); }
    .question-line { font-size: 13px; color: var(--text-2); }
    .creator-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }

    .my-section { margin-bottom: 20px; }
    .my-section h3 { font-size: 14px; margin-bottom: 8px; }
    .mine-row { display: flex; align-items: center; gap: 10px; }
    .chev { color: var(--muted); flex-shrink: 0; }

    .confirm-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: flex-end; justify-content: center; z-index: 200; }
    @media (min-width: 640px) { .confirm-backdrop { align-items: center; } }
    .confirm-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius) var(--radius) 0 0; padding: 24px 20px calc(20px + env(safe-area-inset-bottom)); width: 100%; max-width: 440px; }
    @media (min-width: 640px) { .confirm-card { border-radius: var(--radius); } }
    .confirm-summary { background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; margin: 14px 0; }
    .cs-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 13px; }
    .fee-note { display: flex; align-items: flex-start; gap: 6px; font-size: 13px; color: var(--text-2); background: rgba(234,179,8,.1); padding: 10px 12px; border-radius: var(--radius-sm); }
    .confirm-actions { display: flex; gap: 10px; margin-top: 16px; }
  `],
})
export class FootballListPage implements OnInit {
  private api = inject(Api);
  private router = inject(Router);
  private toast = inject(Toast);
  private realtime = inject(RealtimeService);
  private destroyRef = inject(DestroyRef);

  protected subTab = signal<SubTab>('fixtures');
  protected competitions = signal<FootballCompetition[]>([]);
  protected competitionId = signal<number | null>(null);
  protected fixtures = signal<FootballFixture[] | null>(null);
  protected error = signal('');

  protected openChallenges = signal<OpenFootballChallenge[] | null>(null);
  protected openError = signal('');
  protected joining = signal<number | null>(null);
  protected joinConfirmTarget = signal<OpenFootballChallenge | null>(null);
  protected joinError = signal('');

  protected mine = signal<MatchSummary[] | null>(null);
  protected mineError = signal('');
  protected sections = signal<{ key: string; label: string; items: MatchSummary[] }[]>([]);

  ngOnInit() {
    this.loadCompetitions();
    this.load();
    this.realtime.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.load();
      if (this.subTab() === 'open') this.loadOpen();
      if (this.subTab() === 'mine') this.loadMine();
    });
    this.realtime.match$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.subTab() === 'open') this.loadOpen();
    });
  }

  setSubTab(t: SubTab) {
    this.subTab.set(t);
    if (t === 'open' && !this.openChallenges()) this.loadOpen();
    if (t === 'mine' && !this.mine()) this.loadMine();
  }

  async loadCompetitions() {
    try {
      this.competitions.set((await this.api.get<{ competitions: FootballCompetition[] }>('/football/competitions')).competitions);
    } catch { /* the "All" filter still works without this */ }
  }

  setCompetition(id: number | null) {
    this.competitionId.set(id);
    this.load();
  }

  async load() {
    this.error.set('');
    try {
      const params: Record<string, string> = { status: 'upcoming' };
      if (this.competitionId() !== null) params['competitionId'] = String(this.competitionId());
      this.fixtures.set((await this.api.get<{ fixtures: FootballFixture[] }>('/football/fixtures', params)).fixtures);
    } catch (err) {
      this.error.set(apiError(err).message);
    }
  }

  async loadOpen() {
    this.openError.set('');
    try {
      this.openChallenges.set((await this.api.get<{ challenges: OpenFootballChallenge[] }>('/football/open-challenges')).challenges);
    } catch (err) {
      this.openError.set(apiError(err).message);
    }
  }

  opponentPickLabel(c: OpenFootballChallenge) {
    if (c.challengeType.pickType === 'YES_NO') return c.creatorPick === 'YES' ? 'No' : 'Yes';
    return c.creatorPick === 'HOME' ? c.awayTeam : c.homeTeam;
  }

  openJoinConfirm(c: OpenFootballChallenge) {
    this.joinError.set('');
    this.joinConfirmTarget.set(c);
  }
  closeJoinConfirm() {
    if (this.joining()) return;
    this.joinConfirmTarget.set(null);
  }

  async confirmJoin(c: OpenFootballChallenge) {
    this.joining.set(c.matchId);
    this.joinError.set('');
    try {
      const { match } = await this.api.post<{ match: MatchView }>(`/football/open-challenges/${c.matchId}/join`);
      this.toast.success('Challenge locked in!');
      this.joinConfirmTarget.set(null);
      await this.router.navigate(['/match', match.code]);
    } catch (err) {
      const msg = apiError(err).message;
      this.joinError.set(msg);
      if (apiError(err).code === 'CHALLENGE_ALREADY_TAKEN') {
        this.toast.info(msg);
        this.joinConfirmTarget.set(null);
        this.loadOpen();
      }
    } finally {
      this.joining.set(null);
    }
  }

  isActiveStatus(s: MatchStatus) {
    return ['WAITING', 'MATCHED', 'READY', 'IN_PROGRESS'].includes(s);
  }

  async loadMine() {
    this.mineError.set('');
    try {
      const res = await this.api.get<Paged<MatchSummary>>('/matches', { category: 'FOOTBALL', pageSize: 50 });
      this.mine.set(res.items);
      this.sections.set(
        MY_SECTIONS.map((s) => ({
          key: s.key, label: s.label,
          items: res.items.filter((m) => (s.key === 'DRAW' ? m.status === 'COMPLETED' && m.isDraw : m.status === s.key && !(s.key === 'COMPLETED' && m.isDraw))),
        })).filter((s) => s.items.length > 0),
      );
    } catch (err) {
      this.mineError.set(apiError(err).message);
    }
  }

  kickoffLabel(iso: string) {
    const d = new Date(iso);
    const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return `${day}, ${time}`;
  }
}
