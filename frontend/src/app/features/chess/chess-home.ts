import { A11yModule } from '@angular/cdk/a11y';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { ChessConfig, ChessGame } from '../../core/chess';
import { formatMoney } from '../../core/format';
import { LoadError, Spinner } from '../../shared/ui';
import { SaveAccount } from '../../shared/save-account';
import { ChessActivity } from './chess-activity';
import { ChessPiece } from './chess-piece';

@Component({
  selector: 'app-chess-home',
  imports: [A11yModule, FormsModule, RouterLink, LoadError, Spinner, SaveAccount, ChessActivity, ChessPiece],
  templateUrl: './chess-home.html',
  styleUrl: './chess-home.scss',
})
export class ChessHomePage {
  protected auth = inject(AuthService);
  private api = inject(Api);
  private router = inject(Router);
  protected config = signal<ChessConfig | null>(null);
  protected loadError = signal('');
  protected busy = signal(false);
  protected error = signal('');
  protected review = signal(false);
  protected stake = signal<number | null>(null);
  protected opponent = (inject(ActivatedRoute).snapshot.queryParamMap.get('opponent') ?? '').replace(/^@/,'').slice(0,20);
  protected money = formatMoney;
  protected Math = Math;
  protected option = computed(() => this.config()?.stakeBreakdown.find((s) => s.stake === this.stake()));
  protected turnHours = computed(() => (this.config()?.turnSeconds ?? 86400) / 3600);
  protected inviteDays = computed(() => (this.config()?.inviteSeconds ?? 604800) / 86400);
  constructor() { void this.load(); }
  async load() {
    this.loadError.set('');
    try {
      const config = await this.api.get<ChessConfig>('/chess/config');
      this.config.set(config);
      if (!config.stakeAmounts.includes(this.stake() ?? -1)) this.stake.set(config.stakeAmounts[0] ?? null);
    } catch (err) { this.loadError.set(apiError(err).message); }
  }
  openReview() {
    if (!this.option() || this.config()?.isEnabled === false) return;
    this.error.set('');
    this.review.set(true);
  }
  closeReview() { if (!this.busy()) this.review.set(false); }
  async create() {
    const option = this.option();
    if (!this.review() || !option || this.busy()) return;
    this.busy.set(true); this.error.set('');
    try {
      if (!this.auth.isLoggedIn()) await this.auth.guest();
      const { game } = await this.api.post<{ game: ChessGame }>('/chess', { stake: option.stake, ...(this.opponent.trim() ? { opponent: this.opponent.trim().replace(/^@/, '') } : {}) });
      await this.router.navigate(['/chess', game.code]);
    } catch (err) { this.error.set(apiError(err).message); }
    finally { this.busy.set(false); }
  }
}
