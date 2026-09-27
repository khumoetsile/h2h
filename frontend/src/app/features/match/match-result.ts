import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { MatchView } from '../../core/models';
import { Toast } from '../../core/toast.service';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar, LoadError, Spinner } from '../../shared/ui';
import { relevantStat } from '../../core/football-stat';
import { RematchService } from '../../core/rematch.service';

/**
 * The moment right after a game ends. One screen, instantly understandable:
 * did you win or lose, and by how much — then "Play again" or "Back home".
 * The full round-by-round breakdown is one tap further, for anyone curious;
 * it is never the first thing shown.
 */
@Component({
  selector: 'app-match-result',
  imports: [RouterLink, MatIconModule, MoneyPipe, Avatar, LoadError, Spinner],
  template: `
    <div class="result-screen">
      @if (error()) {
        <app-load-error [message]="error()" (retry)="load()" />
      } @else if (!match()) {
        <app-spinner />
      } @else {
        @let m = match()!;
        @let mine = me()!;
        <div class="result-body fade-in" [class.won]="mine.outcome === 'WIN'" [class.lost]="mine.outcome === 'LOSS'">
          <div class="badge-icon">
            <mat-icon>{{ icon() }}</mat-icon>
          </div>
          <h1 class="result-hero">{{ headline() }}</h1>
          @if (mine.outcome === 'WIN') {
            <div class="result-amount win">+{{ (m.prize - m.stake) | money }}</div>
          } @else {
            <p class="sub">{{ subline() }}</p>
          }

          @if (isFootball() && m.football) {
            <div class="football-recap">
              <div class="fr-teams">
                <span>{{ m.football.homeTeam }}</span>
                @if (m.football.homeScore !== null && m.football.homeScore !== undefined) {
                  <strong class="num">{{ m.football.homeScore }} – {{ m.football.awayScore }}</strong>
                } @else {
                  <span class="muted small">vs</span>
                }
                <span>{{ m.football.awayTeam }}</span>
              </div>
              @if (stat(); as s) {
                <p class="stat-line">{{ s.label }}: {{ m.football.homeTeam }} <strong>{{ s.home ?? '–' }}</strong> · {{ m.football.awayTeam }} <strong>{{ s.away ?? '–' }}</strong></p>
              }
              <p class="muted small">{{ m.football.challengeType?.question }}</p>
              <div class="pvp-recap">
                <div class="pvp-side"><span class="muted tiny">YOU</span><strong>{{ myPick() }}</strong></div>
                <div class="pvp-vs">vs</div>
                <div class="pvp-side"><span class="muted tiny">{{ opponent()?.username ?? 'OPPONENT' }}</span><strong>{{ opponentPick() }}</strong></div>
              </div>
            </div>
          } @else {
            <div class="vs-row">
              <div class="vs-side">
                <app-avatar [name]="mine.username" [color]="mine.avatarColor" [size]="48" />
                <span>You</span>
                <strong class="num">{{ mine.result?.score ?? '—' }}</strong>
              </div>
              <div class="vs-mid">VS</div>
              <div class="vs-side">
                <app-avatar [name]="opponent()?.username ?? ''" [color]="opponent()?.avatarColor ?? '#64748B'" [size]="48" />
                <span>{{ opponent()?.username }}</span>
                <strong class="num">{{ opponent()?.result?.score ?? '—' }}</strong>
              </div>
            </div>
          }

          <div class="actions">
            @if (isFootball() && opponent() && !opponent()!.isBot) {
              <button class="btn btn-primary btn-lg btn-block" (click)="rematch()"><mat-icon>swords</mat-icon>Rematch {{ opponent()?.username }}</button>
              <button class="btn btn-lg btn-block" (click)="playAgain()"><mat-icon>sports_soccer</mat-icon>Back to Football</button>
            } @else {
              <button class="btn btn-primary btn-lg btn-block" (click)="playAgain()"><mat-icon>replay</mat-icon>Play again</button>
            }
            <a class="btn btn-lg btn-block" routerLink="/dashboard"><mat-icon>home</mat-icon>Back home</a>
            <a class="link small" [routerLink]="['/matches', m.code]">View match details</a>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .result-screen { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px calc(24px + env(safe-area-inset-bottom)); }
    .result-body { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; max-width: 420px; width: 100%; }
    .badge-icon {
      width: 76px; height: 76px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-bottom: 6px;
      background: var(--surface-2); color: var(--muted);
      mat-icon { font-size: 40px; width: 40px; height: 40px; }
    }
    .won .badge-icon { background: var(--win-soft); color: var(--win); }
    .lost .badge-icon { background: var(--loss-soft); color: var(--loss); }
    .won .result-hero { color: var(--win); }
    .sub { color: var(--text-2); font-size: 16px; margin-top: 2px; }
    .vs-row { display: flex; align-items: center; gap: 18px; margin: 26px 0 8px; width: 100%; justify-content: center; }
    .vs-side { display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 13px; color: var(--muted);
      strong { font-family: var(--font-display); font-size: 22px; color: var(--text); } }
    .vs-mid { font-family: var(--font-display); font-weight: 700; color: var(--muted); font-size: 14px; }
    .football-recap { margin: 22px 0 8px; width: 100%; display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .fr-teams { display: flex; align-items: center; justify-content: center; gap: 12px; font-weight: 700; font-family: var(--font-display); font-size: 18px;
      .num { color: var(--accent); font-size: 22px; } }
    .stat-line { font-size: 14px; color: var(--text-2); strong { color: var(--text); } }
    .pvp-recap { display: flex; align-items: center; gap: 14px; margin-top: 8px; }
    .pvp-side { display: flex; flex-direction: column; align-items: center; gap: 2px; strong { font-family: var(--font-display); font-size: 16px; } }
    .pvp-vs { color: var(--muted); font-size: 12px; font-weight: 700; }
    .actions { display: flex; flex-direction: column; gap: 10px; width: 100%; margin-top: 22px; }
  `],
})
export class MatchResultPage implements OnInit {
  readonly code = input.required<string>();
  private api = inject(Api);
  private router = inject(Router);
  private toast = inject(Toast);
  private rematchSvc = inject(RematchService);

  protected match = signal<MatchView | null>(null);
  protected error = signal('');

  protected me = computed(() => this.match()?.players.find((p) => p.userId === this.match()?.viewerId) ?? null);
  protected opponent = computed(() => this.match()?.players.find((p) => p.userId !== this.match()?.viewerId) ?? null);

  protected isFootball = computed(() => this.match()?.category === 'FOOTBALL');
  protected myPick = computed(() => {
    const m = this.match();
    const f = m?.football;
    if (!f) return '';
    return m!.createdBy === m!.viewerId ? f.creatorPickLabel : (f.opponentPickLabel ?? f.creatorPickLabel);
  });
  protected opponentPick = computed(() => {
    const m = this.match();
    const f = m?.football;
    if (!f) return '';
    return m!.createdBy === m!.viewerId ? (f.opponentPickLabel ?? '') : f.creatorPickLabel;
  });
  protected stat = computed(() => {
    const f = this.match()?.football;
    return f ? relevantStat(f) : null;
  });

  protected icon = computed(() => {
    const m = this.match();
    if (!m) return 'sports_esports';
    if (m.status === 'CANCELLED') return 'undo';
    if (m.status === 'VOID') return 'block';
    if (m.isDraw) return 'balance';
    return this.me()?.outcome === 'WIN' ? 'emoji_events' : 'sentiment_dissatisfied';
  });

  protected headline = computed(() => {
    const m = this.match();
    if (!m) return '';
    if (m.status === 'CANCELLED') return this.isFootball() ? 'Challenge cancelled' : 'Match cancelled';
    if (m.status === 'VOID') return "Result couldn't be verified";
    if (m.isDraw) return "IT'S A DRAW";
    return this.me()?.outcome === 'WIN' ? 'YOU WON!' : 'MATCH OVER';
  });

  protected subline = computed(() => {
    const m = this.match();
    if (!m) return '';
    if (m.status === 'CANCELLED') return 'Your entry was refunded.';
    if (m.status === 'VOID') return 'We could not fairly determine a result, so your entry was refunded in full — no fee.';
    if (m.isDraw) return this.isFootball() ? "The match ended in a draw — your entry was refunded." : 'It was a tie — your entry was refunded.';
    return 'You lost this round.';
  });

  ngOnInit() {
    this.toast.dismiss();
    this.load();
  }

  async load() {
    this.error.set('');
    try {
      const { match } = await this.api.get<{ match: MatchView }>(`/matches/${this.code()}`);
      if (match.status !== 'COMPLETED' && match.status !== 'CANCELLED' && match.status !== 'VOID') {
        this.router.navigate(['/match', match.code], { replaceUrl: true });
        return;
      }
      this.match.set(match);
    } catch (err) {
      this.error.set(apiError(err).message);
    }
  }

  playAgain() {
    const m = this.match();
    if (m?.category === 'FOOTBALL') {
      // The fixture just played is already kicked off/finished — a rematch
      // has to be on a new fixture, so this goes to the Football list rather
      // than back into the same (now closed) fixture.
      this.router.navigate(['/football']);
      return;
    }
    const slug = m?.game.slug;
    this.router.navigate(slug ? ['/games', slug] : ['/games']);
  }

  /** Same opponent, a new fixture — pre-fills "Challenge someone" the next time they build a football challenge. */
  rematch() {
    const opp = this.opponent();
    if (opp) this.rematchSvc.setPending({ username: opp.username, avatarColor: opp.avatarColor });
    this.router.navigate(['/football']);
  }
}
