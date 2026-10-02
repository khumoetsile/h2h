import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { picksFor, viewDisplayState } from '../../core/challenge-state';
import { ConfigStore } from '../../core/config.store';
import { relevantStat } from '../../core/football-stat';
import { formatMoney } from '../../core/format';
import { MatchView } from '../../core/models';
import { RematchService } from '../../core/rematch.service';
import { Toast } from '../../core/toast.service';
import { SaveAccount } from '../../shared/save-account';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar, LoadError, Spinner } from '../../shared/ui';

/**
 * The moment a challenge ends. One screen, instantly understandable: what
 * happened, what it meant for your money, and a one-tap Rematch that
 * creates a completely new challenge (new id, picks, stake, transactions,
 * settlement and audit trail) — never a replay of this record.
 */
@Component({
  selector: 'app-match-result',
  imports: [RouterLink, MatIconModule, MatProgressSpinnerModule, SaveAccount, MoneyPipe, Avatar, LoadError, Spinner],
  template: `
    <div class="result-screen">
      @if (error()) {
        <app-load-error [message]="error()" (retry)="load()" />
      } @else if (!match()) {
        <app-spinner />
      } @else {
        @let m = match()!;
        @let mine = me()!;
        <div class="result-body fade-in" [class.won]="ds() === 'WON'" [class.lost]="ds() === 'LOST' || ds() === 'LEFT' || ds() === 'TIMED_OUT'">
          <div class="badge-icon"><mat-icon>{{ icon() }}</mat-icon></div>
          <h1 class="result-hero">{{ headline() }}</h1>
          @if (ds() === 'WON') { <div class="result-amount win">+{{ (m.prize - m.stake) | money }}</div> }
          <p class="sub">{{ subline() }}</p>

          @if (isFootball() && m.football) {
            @let f = m.football;
            <div class="football-recap card">
              <div class="muted tiny">{{ f.challengeType?.question }} · {{ m.stake | money }}</div>
              <div class="fr-teams">
                <span>{{ f.homeTeam }}</span>
                @if (f.homeScore !== null && f.homeScore !== undefined) { <strong class="num">{{ f.homeScore }} - {{ f.awayScore }}</strong> } @else { <span class="muted small">vs</span> }
                <span>{{ f.awayTeam }}</span>
              </div>
              @if (stat(); as s) {
                @if (s.home !== null) {
                  <div class="final-stat">
                    <span class="muted tiny">FINAL {{ s.label.toUpperCase() }}</span>
                    <div><span>{{ f.homeTeam }}</span><strong>{{ s.home }}</strong></div>
                    <div><span>{{ f.awayTeam }}</span><strong>{{ s.away }}</strong></div>
                  </div>
                }
              }
              <div class="pvp-recap">
                <div class="pvp-side"><span class="muted tiny">YOU</span><strong>{{ picks().mine }}</strong></div>
                <div class="pvp-vs">vs</div>
                <div class="pvp-side"><span class="muted tiny">{{ opponent()?.username ?? 'Opponent' }}</span><strong>{{ picks().theirs || '-' }}</strong></div>
              </div>
            </div>
          } @else if (m.status === 'COMPLETED') {
            <div class="vs-row">
              <div class="vs-side"><app-avatar [name]="mine.username" [color]="mine.avatarColor" [size]="48" /><span>You</span><strong class="num">{{ mine.result?.score ?? '-' }}</strong></div>
              <div class="vs-mid">VS</div>
              <div class="vs-side"><app-avatar [name]="opponent()?.username ?? ''" [color]="opponent()?.avatarColor ?? '#64748B'" [size]="48" /><span>{{ opponent()?.username }}</span><strong class="num">{{ opponent()?.result?.score ?? '-' }}</strong></div>
            </div>
          }

          <div class="money-lines card">
            @for (l of moneyLines(); track l.label) {
              <div class="ml"><span class="muted">{{ l.label }}</span><strong [class.win]="l.tone === 'win'" [class.loss]="l.tone === 'loss'">{{ l.value }}</strong></div>
            }
          </div>

          <app-save-account class="save-slot" />
          <div class="actions">
            @if (canRematch()) {
              <button class="btn btn-primary btn-lg btn-block" [disabled]="rematching()" (click)="rematch()">
                @if (rematching()) { <mat-spinner diameter="20" /> } @else { <mat-icon>replay</mat-icon> } Rematch {{ opponent()?.username }}
              </button>
            }
            <button class="btn btn-lg btn-block" [class.btn-primary]="!canRematch()" (click)="playAgain()"><mat-icon>{{ isFootball() ? 'sports_soccer' : 'sports_esports' }}</mat-icon>{{ isFootball() ? 'Back to Football' : 'Play again' }}</button>
            <a class="link small" [routerLink]="['/matches', m.code]">View challenge details</a>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .result-screen { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px calc(24px + env(safe-area-inset-bottom)); }
    .result-body { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; max-width: 420px; width: 100%; min-width: 0; }
    .badge-icon { width: 76px; height: 76px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-bottom: 4px; background: var(--surface-2); color: var(--muted);
      mat-icon { font-size: 40px; width: 40px; height: 40px; } }
    .won .badge-icon { background: var(--win-soft); color: var(--win); }
    .lost .badge-icon { background: var(--loss-soft); color: var(--loss); }
    .won .result-hero { color: var(--win); }
    .sub { color: var(--text-2); font-size: 15px; }
    .vs-row { display: flex; align-items: center; gap: 18px; margin: 16px 0 4px; width: 100%; justify-content: center; }
    .vs-side { display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); min-width: 0;
      strong { font-family: var(--font-display); font-size: 22px; color: var(--text); } span { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } }
    .vs-mid { font-family: var(--font-display); font-weight: 700; color: var(--muted); font-size: 14px; }
    .football-recap { margin-top: 12px; width: 100%; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 16px; }
    .fr-teams { display: flex; align-items: center; justify-content: center; gap: 10px; font-weight: 700; font-family: var(--font-display); font-size: 17px; flex-wrap: wrap;
      .num { color: var(--accent); font-size: 22px; } }
    .final-stat { width: 100%; display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; background: var(--bg-elev); border-radius: var(--radius-sm);
      div { display: flex; justify-content: space-between; gap: 8px; } strong { font-family: var(--font-display); font-size: 18px; } }
    .pvp-recap { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 10px; width: 100%; }
    .pvp-side { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; strong { font-family: var(--font-display); font-size: 15px; overflow-wrap: anywhere; } }
    .pvp-vs { color: var(--muted); font-size: 12px; font-weight: 700; }
    .money-lines { width: 100%; padding: 12px 16px; display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
    .ml { display: flex; justify-content: space-between; gap: 10px; font-size: 14px; }
    .save-slot { width: 100%; margin-top: 12px; }
    .actions { display: flex; flex-direction: column; gap: 10px; width: 100%; margin-top: 12px; }
  `],
})
export class MatchResultPage implements OnInit {
  readonly code = input.required<string>();
  private api = inject(Api);
  private router = inject(Router);
  private toast = inject(Toast);
  private rematchSvc = inject(RematchService);
  private config = inject(ConfigStore);

  protected match = signal<MatchView | null>(null);
  protected error = signal('');
  protected rematching = signal(false);

  protected me = computed(() => this.match()?.players.find((p) => p.userId === this.match()?.viewerId) ?? null);
  protected opponent = computed(() => this.match()?.players.find((p) => p.userId !== this.match()?.viewerId) ?? null);
  protected isFootball = computed(() => this.match()?.category === 'FOOTBALL');
  protected ds = computed(() => { const m = this.match(); return m ? viewDisplayState(m) : null; });
  protected picks = computed(() => { const m = this.match(); return m ? picksFor(m) : { mine: '', theirs: '' }; });
  protected stat = computed(() => { const f = this.match()?.football; return f ? relevantStat(f) : null; });
  protected canRematch = computed(() => {
    const opp = this.opponent();
    return !!opp && !opp.isBot && this.ds() !== 'EXPIRED';
  });

  protected icon = computed(() => ({
    WON: 'emoji_events', LOST: 'sentiment_dissatisfied', DRAW: 'balance', VOID: 'block', EXPIRED: 'timer_off', TIMED_OUT: 'timer_off',
    LEFT: 'logout', OPPONENT_LEFT: 'person_off', CANCELLED: 'undo',
  } as Record<string, string>)[this.ds() ?? ''] ?? 'sports_esports');

  protected headline = computed(() => {
    const m = this.match();
    if (!m) return '';
    switch (this.ds()) {
      case 'WON': return 'You won';
      case 'LOST': return m.endReason === 'ACTION_TIMEOUT' ? 'Timed out' : 'You lost';
      case 'DRAW': return 'Draw';
      case 'VOID': return 'Void';
      case 'EXPIRED': return 'Challenge expired';
      case 'TIMED_OUT': return 'Timed out';
      case 'LEFT': return 'You left the challenge';
      case 'OPPONENT_LEFT': return 'Opponent left';
      default: return 'Challenge cancelled';
    }
  });

  protected subline = computed(() => {
    const m = this.match();
    const opp = this.opponent()?.username ?? 'your opponent';
    if (!m) return '';
    const stake = formatMoney(m.stake);
    // A finished shootout carries its own scoreline ("Won the shootout 3-2 in sudden death").
    const shootout = /^Won the shootout (.+)$/.exec(m.resultReason ?? '')?.[1];
    if (shootout && !m.endReason) {
      if (this.ds() === 'WON') return `You beat ${opp}, ${shootout}.`;
      if (this.ds() === 'LOST') return `${opp} won ${shootout}.`;
    }
    switch (this.ds()) {
      case 'WON': return m.endReason === 'ACTION_TIMEOUT' ? `You beat ${opp}. They didn't finish before the timer ran out.` : `You beat ${opp}.`;
      case 'LOST': return m.endReason === 'ACTION_TIMEOUT' ? `You didn't finish before the timer ran out, so ${opp} won.` : `${opp} won this one.`;
      case 'DRAW': return `${stake} refunded to both players.`;
      case 'VOID': return `The result couldn't be fairly decided (${m.cancelReason ?? 'no verifiable result'}). ${stake} refunded to both players.`;
      case 'EXPIRED': return `No opponent joined in time. Your ${stake} was returned, with no fee.`;
      case 'TIMED_OUT': return `${m.cancelReason ?? 'The timer ran out'}. Both stakes were returned in full, with no fee.`;
      case 'LEFT': return `You left after the challenge was locked. Your ${stake} was refunded and the ${this.config.abandonmentFee()} abandonment fee was charged.`;
      case 'OPPONENT_LEFT': return `${opp} left after the challenge was locked. Your ${stake} was refunded in full, with no fee for you.`;
      default: return `${m.cancelReason ? m.cancelReason.charAt(0).toUpperCase() + m.cancelReason.slice(1) + '. ' : ''}Your ${stake} was returned, with no fee.`;
    }
  });

  /** Exactly what happened to the money — including an explicit zero platform fee when no one won. */
  protected moneyLines = computed(() => {
    const m = this.match();
    if (!m) return [];
    const zero = formatMoney(0);
    const lines: { label: string; value: string; tone?: 'win' | 'loss' }[] = [{ label: 'Stake', value: formatMoney(m.stake) }];
    switch (this.ds()) {
      case 'WON': lines.push({ label: 'Platform fee', value: formatMoney(m.fee) }, { label: 'You received', value: formatMoney(m.prize), tone: 'win' }); break;
      case 'LOST': lines.push({ label: 'Result', value: `−${formatMoney(m.stake)}`, tone: 'loss' }); break;
      case 'LEFT': lines.push({ label: 'Refunded', value: formatMoney(m.stake) }, { label: 'Abandonment fee', value: `−${this.config.abandonmentFee()}`, tone: 'loss' }); break;
      default: lines.push({ label: 'Refunded', value: formatMoney(m.stake) }, { label: 'Platform fee', value: zero });
    }
    return lines;
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
    if (m?.category === 'FOOTBALL') { this.router.navigate(['/football']); return; }
    const slug = m?.game.slug;
    this.router.navigate(slug ? ['/games', slug] : ['/games']);
  }

  /** A brand-new challenge — never a reuse of this record. */
  async rematch() {
    const m = this.match();
    const opp = this.opponent();
    if (!m || !opp) return;
    if (m.category === 'FOOTBALL') {
      // The fixture has been played — same opponent, same question and stake, on a fixture they pick next.
      this.rematchSvc.setPending({ username: opp.username, avatarColor: opp.avatarColor, challengeTypeSlug: m.football?.challengeType?.slug, stake: m.stake });
      this.router.navigate(['/football']);
      return;
    }
    this.rematching.set(true);
    try {
      await this.api.post('/challenges', { opponent: opp.username, gameId: m.game.id, stake: m.stake });
      this.toast.success(`Rematch challenge sent to ${opp.username}.`);
      this.router.navigate(['/challenges'], { queryParams: { tab: 'outgoing' } });
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.rematching.set(false);
    }
  }
}

