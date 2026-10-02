import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { filter, interval, merge } from 'rxjs';
import { Api } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { Challenge, MatchSummary, MatchView, Paged } from '../core/models';
import { RealtimeService } from '../core/realtime.service';

interface Row {
  code: string;
  status: string;
  game: string;
  oppName: string | null;
  iAmReady: boolean;
  iAmDone: boolean;
}

interface Item { text: string; cta: string; hot: boolean; link: string[]; query?: Record<string, string>; dismiss?: () => void; }

const DISMISS_KEY = 'h2h.challenge.dismissed';
function readDismissed(): number[] {
  try { return JSON.parse(sessionStorage.getItem(DISMISS_KEY) || '[]'); } catch { return []; }
}

const fromSummary = (m: MatchSummary): Row => ({
  code: m.code, status: m.status, game: m.game.name, oppName: m.opponent?.username ?? null,
  iAmReady: !!m.lockedIn, iAmDone: !!m.submitted,
});

const fromView = (m: MatchView): Row => {
  const me = m.players.find((p) => p.userId === m.viewerId);
  const opp = m.players.find((p) => p.userId !== m.viewerId);
  return { code: m.code, status: m.status, game: m.game.name, oppName: opp?.username ?? null, iAmReady: !!me?.lockedIn, iAmDone: !!me?.submitted };
};

/**
 * A slim bar under the header while the player has a game that needs them:
 * searching, an opponent found, or a match ready to play. One tap goes back to
 * it, so nobody loses a match by wandering off to another page.
 */
@Component({
  selector: 'app-active-match-bar',
  imports: [RouterLink, MatIconModule],
  template: `
    @if (item(); as it) {
      <div class="amb" [class.hot]="it.hot" role="status">
        <a class="main" [routerLink]="it.link" [queryParams]="it.query">
          <span class="txt">{{ it.text }}</span>
          <span class="cta">{{ it.cta }}<mat-icon>chevron_right</mat-icon></span>
        </a>
        @if (it.dismiss) { <button class="x" type="button" aria-label="Dismiss" (click)="it.dismiss()"><mat-icon>close</mat-icon></button> }
      </div>
    }
  `,
  styles: [`
    :host { display: block; position: sticky; top: var(--header-h); z-index: 40; }
    .amb { display: flex; align-items: center; min-height: 46px; background: var(--surface-2); border-bottom: 1px solid var(--border); font-size: 16px; font-weight: 600; }
    .main { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 46px; padding: 0 16px; }
    .x { width: 44px; height: 46px; display: flex; align-items: center; justify-content: center; color: inherit; opacity: .7; cursor: pointer; }
    .x mat-icon { font-size: 20px; width: 20px; height: 20px; }
    .amb.hot { background: var(--accent); color: var(--accent-ink); border-bottom-color: var(--accent); }
    .txt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cta { display: inline-flex; align-items: center; flex-shrink: 0; font-family: var(--font-display); font-size: 19px; }
    .cta mat-icon { font-size: 22px; width: 22px; height: 22px; }
  `],
})
export class ActiveMatchBar implements OnInit {
  private api = inject(Api);
  private auth = inject(AuthService);
  private realtime = inject(RealtimeService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  private rows = signal<Row[]>([]);
  private challenges = signal<Challenge[]>([]);
  /** Challenges the player has waved away this session; they stay on the Challenges page. */
  private dismissed = signal<number[]>(readDismissed());
  private url = signal(this.router.url);

  protected item = computed<Item | null>(() => {
    if (this.auth.isAdmin() || this.url().startsWith('/match/')) return null;
    const rows = this.rows();
    const found = rows.find((r) => r.status === 'MATCHED' && !r.iAmReady);
    if (found) return { text: `Opponent found${found.oppName ? ': ' + found.oppName : ''}`, cta: 'Get ready', hot: true, link: ['/match', found.code] };
    const play = rows.find((r) => ['READY', 'IN_PROGRESS'].includes(r.status) && !r.iAmDone);
    if (play) return { text: `Your ${play.game} match is on`, cta: 'Play', hot: true, link: ['/match', play.code, 'play'] };
    const wait = rows.find((r) => r.status === 'MATCHED' && r.iAmReady);
    if (wait) return { text: `Waiting for ${wait.oppName ?? 'your opponent'} to get ready`, cta: 'Open', hot: false, link: ['/match', wait.code] };
    // A challenge for you: one quiet line, never a popup.
    const ch = this.challenges().find((c) => !this.dismissed().includes(c.id));
    if (ch) {
      const what = ch.football ? `${ch.football.homeTeam} vs ${ch.football.awayTeam}` : ch.game.name;
      return { text: `${ch.challenger.username} challenged you: ${what}`, cta: 'View', hot: false, link: ['/challenges'], query: { tab: 'incoming' }, dismiss: () => this.dismiss(ch.id) };
    }
    const search = rows.find((r) => r.status === 'WAITING');
    if (search) return { text: `Looking for an opponent: ${search.game}`, cta: 'Open', hot: false, link: ['/match', search.code] };
    return null;
  });

  ngOnInit() {
    void this.load();
    this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd), takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      const wasInMatch = this.url().startsWith('/match/');
      this.url.set(e.urlAfterRedirects);
      if (wasInMatch && !e.urlAfterRedirects.startsWith('/match/')) void this.load();
    });
    this.realtime.match$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((m) => {
      if (m.category === 'FOOTBALL') return;
      const done = ['COMPLETED', 'CANCELLED', 'VOID'].includes(m.status);
      this.rows.update((l) => {
        const rest = l.filter((r) => r.code !== m.code);
        return done ? rest : [fromView(m), ...rest];
      });
    });
    this.realtime.challenge$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.load());
    merge(this.realtime.reconnected$, interval(30000)).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.load());
  }

  private async load() {
    if (!this.auth.isLoggedIn() || this.auth.isAdmin()) return;
    try {
      const res = await this.api.get<Paged<MatchSummary>>('/matches', { status: 'active', category: 'SKILL_GAME', pageSize: 10 });
      this.rows.set(res.items.map(fromSummary));
    } catch { /* the bar just stays as it was */ }
    try {
      const c = await this.api.get<{ challenges: Challenge[] }>('/challenges', { box: 'incoming', status: 'active' });
      this.challenges.set(c.challenges.filter((x) => x.status === 'PENDING'));
    } catch { /* same */ }
  }

  private dismiss(id: number) {
    const next = [...this.dismissed(), id].slice(-50);
    this.dismissed.set(next);
    try { sessionStorage.setItem(DISMISS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }
}
