import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { MatchPlayer, MatchView } from '../../core/models';
import { Toast } from '../../core/toast.service';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar, DemoBadge, GameIcon, LoadError, MatchStatusChip, Spinner } from '../../shared/ui';

const SUMMARY_LABELS: Record<string, string> = {
  hits: 'Hits', misses: 'Misses', averageReactionMs: 'Avg reaction', bestReactionMs: 'Best reaction', totalReactionMs: 'Total reaction',
  accuracyPct: 'Accuracy', averagePrecisionPct: 'Avg precision', sequencesCorrect: 'Sequences correct', longestSequence: 'Longest sequence',
  totalInputMs: 'Total input time', wordsSolved: 'Words solved', averageSolveMs: 'Avg solve time', goals: 'Goals', saved: 'Saved', wide: 'Wide',
  shots: 'Shots', totalRounds: 'Rounds', totalWords: 'Words',
};

@Component({
  selector: 'app-match-detail',
  imports: [RouterLink, DatePipe, MatIconModule, MoneyPipe, Avatar, DemoBadge, GameIcon, LoadError, MatchStatusChip, Spinner],
  templateUrl: './match-detail.html',
  styleUrl: './match-detail.scss',
})
export class MatchDetailPage implements OnInit {
  readonly code = input.required<string>();
  private api = inject(Api);
  protected auth = inject(AuthService);
  private router = inject(Router);
  private toast = inject(Toast);

  protected match = signal<MatchView | null>(null);
  protected error = signal('');
  protected rematching = signal(false);

  protected me = computed(() => this.match()?.players.find((p) => p.userId === this.match()?.viewerId) ?? null);
  protected isPlayer = computed(() => !!this.me());
  protected left = computed(() => this.me() ?? this.match()?.players[0] ?? null);
  protected right = computed(() => this.match()?.players.find((p) => p.userId !== this.left()?.userId) ?? null);
  protected winner = computed(() => this.match()?.players.find((p) => p.userId === this.match()?.winnerId) ?? null);
  protected loser = computed(() => this.match()?.players.find((p) => p.outcome === 'LOSS') ?? null);
  protected rounds = computed(() => {
    const l = this.left()?.result?.rounds ?? [];
    const r = this.right()?.result?.rounds ?? [];
    return Array.from({ length: Math.max(l.length, r.length) }, (_, i) => ({ n: i + 1, l: l[i], r: r[i] }));
  });

  async ngOnInit() { await this.load(); }

  async load() {
    this.error.set('');
    try {
      const path = this.auth.isAdmin() ? `/admin/matches/${this.code()}` : `/matches/${this.code()}`;
      const { match } = await this.api.get<{ match: MatchView }>(path);
      if (!this.auth.isAdmin() && !['COMPLETED', 'CANCELLED'].includes(match.status)) {
        this.router.navigate(['/match', match.code], { replaceUrl: true });
        return;
      }
      this.match.set(match);
    } catch (err) {
      this.error.set(apiError(err).message);
    }
  }

  summaryEntries(p: MatchPlayer | null) {
    const s = p?.result?.summary ?? {};
    return Object.entries(s)
      .filter(([k]) => SUMMARY_LABELS[k] && !['totalRounds', 'totalWords', 'shots'].includes(k))
      .map(([k, v]) => ({ label: SUMMARY_LABELS[k], value: v == null ? '-' : /Ms$/.test(k) ? `${v} ms` : /Pct$/.test(k) ? `${v}%` : String(v) }));
  }

  roundCell(r: Record<string, unknown> | undefined, slug: string) {
    if (!r) return { main: '-', sub: '', ok: false };
    const status = String(r['status'] ?? '');
    const ok = ['HIT', 'CORRECT', 'GOAL'].includes(status);
    let main = status.replace('_', ' ').toLowerCase();
    if (slug === 'reaction-rush' || slug === 'aim-challenge') main = ok ? `${r['reactionMs']} ms` : main;
    if (slug === 'word-battle') main = ok ? String(r['answer']) : `${r['guess'] || '-'}`;
    if (slug === 'memory-battle') main = ok ? `${r['length']} tiles` : `${r['correctPrefix']}/${r['length']}`;
    if (slug === 'penalty-shootout' && r['zone'] != null) {
      // A live shootout kick: where it was aimed and how well it was struck.
      const zone = ['top left', 'top centre', 'top right', 'bottom left', 'bottom centre', 'bottom right'][Number(r['zone'])] ?? '';
      const quality = String(r['quality'] ?? '').toLowerCase();
      main = status === 'GOAL' ? 'Goal' : status === 'SAVED' ? 'Saved' : 'Missed';
      return { main, sub: [zone, quality && quality !== 'none' ? quality : ''].filter(Boolean).join(', '), ok };
    }
    if (slug === 'penalty-shootout') main = status === 'GOAL' ? 'Goal' : status === 'SAVED' ? `Saved (${String(r['keeperDive']).toLowerCase()})` : 'Wide';
    return { main, sub: r['points'] != null ? `${r['points']} pts` : '', ok };
  }

  playAgain() {
    const m = this.match();
    if (m) this.router.navigate(['/games', m.game.slug]);
  }

  async rematch() {
    const m = this.match();
    const opp = this.right();
    if (!m || !opp) return;
    if (opp.isBot) { this.playAgain(); return; }
    this.rematching.set(true);
    try {
      await this.api.post('/challenges', { opponent: opp.username, gameId: m.game.id, stake: m.stake, message: 'Rematch?' });
      this.toast.success(`Rematch challenge sent to @${opp.username}.`);
      this.router.navigate(['/challenges']);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.rematching.set(false);
    }
  }
}
