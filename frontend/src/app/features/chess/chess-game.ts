import { A11yModule } from '@angular/cdk/a11y';
import { Component, DestroyRef, OnChanges, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { ChessGame, ChessMove, ChessPromotion, ChessSquare, chessPieceLabel, chessSquares, chessStatus } from '../../core/chess';
import { formatMoney } from '../../core/format';
import { RealtimeService } from '../../core/realtime.service';
import { ServerClock, formatRemaining } from '../../core/server-clock';
import { Avatar, LoadError, Spinner } from '../../shared/ui';
import { SaveAccount } from '../../shared/save-account';
import { ChessPiece } from './chess-piece';

type Action = 'accept' | 'cancel' | 'decline' | 'resign' | 'draw-offer' | 'draw-accept';

@Component({
  selector: 'app-chess-game',
  imports: [A11yModule, DatePipe, FormsModule, RouterLink, Avatar, LoadError, Spinner, SaveAccount, ChessPiece],
  templateUrl: './chess-game.html',
  styleUrl: './chess-game.scss',
})
export class ChessGamePage implements OnChanges {
  readonly code = input.required<string>();
  protected auth = inject(AuthService);
  private api = inject(Api);
  private clock = inject(ServerClock);
  private realtime = inject(RealtimeService);
  private destroyRef = inject(DestroyRef);
  protected game = signal<ChessGame | null>(null);
  protected loading = signal(true);
  protected loadError = signal('');
  protected refreshError = signal('');
  protected error = signal('');
  protected busy = signal(false);
  protected action = signal<Action | null>(null);
  protected selected = signal<string | null>(null);
  protected focused = signal('a8');
  protected draft = signal<ChessMove[] | null>(null);
  protected promotion = signal<ChessPromotion>('q');
  protected copied = signal(false);
  protected moveChoice = '';
  protected money = formatMoney;
  protected pieceLabel = chessPieceLabel;
  protected status = chessStatus;
  protected squares = computed(() => chessSquares(this.game()?.fen, this.game()?.viewerColor ?? 'w'));
  protected legal = computed(() => this.game()?.legalMoves ?? []);
  protected canMove = computed(() => this.game()?.status === 'ACTIVE' && this.game()?.isYourTurn && !!this.game()?.viewerColor && !this.busy() && !this.refreshError() && this.remaining() > 0);
  protected destinations = computed(() => new Set(this.legal().filter((m) => m.from === this.selected()).map((m) => m.to)));
  protected chosenMove = computed(() => this.draft()?.find((m) => !m.promotion || m.promotion === this.promotion()) ?? null);
  protected promotions = computed(() => [...new Set((this.draft() ?? []).map((m) => m.promotion).filter((p): p is ChessPromotion => !!p))]);
  protected remaining = computed(() => this.clock.remainingMs(this.game()?.turnDeadline));
  protected countdown = computed(() => formatRemaining(this.remaining()));
  protected inviteCountdown = computed(() => formatRemaining(this.clock.remainingMs(this.game()?.inviteExpiresAt)));
  protected myColor = computed(() => this.game()?.viewerColor === 'b' ? 'Black' : 'White');
  protected opponent = computed(() => this.game()?.viewerColor === 'b' ? this.game()?.white : this.game()?.black);
  protected bottomPlayer = computed(() => this.game()?.viewerColor === 'b' ? this.game()?.black : this.game()?.white);
  protected resultTitle = computed(() => {
    const game = this.game();
    if (!game) return '';
    if (game.viewerColor) return chessStatus(game);
    return game.isDraw ? 'Draw · entries refunded' : game.winnerId ? `${game.winnerId === game.white.id ? game.white.username : game.black?.username ?? 'Opponent'} won` : 'Game complete';
  });
  protected mine = computed(() => this.auth.user()?.id === this.game()?.createdBy);
  protected shareUrl = computed(() => `${window.location.origin}/chess/${encodeURIComponent(this.code())}`);
  protected movePairs = computed(() => {
    const moves = this.game()?.moves ?? [];
    return Array.from({ length: Math.ceil(moves.length / 2) }, (_, i) => ({ number: i + 1, white: moves[i * 2]?.san ?? '', black: moves[i * 2 + 1]?.san ?? '' }));
  });
  protected resultDescription = computed(() => {
    const game = this.game();
    if (!game) return '';
    const reason = `${game.resultReason ?? ''} ${game.endReason ?? ''}`.toUpperCase();
    if (reason.includes('TIMEOUT') || reason.includes('TIME')) return 'A player missed their move deadline. The other player wins; the normal platform fee applies.';
    if (reason.includes('RESIGN')) return 'A player resigned. The other player wins; the normal platform fee applies.';
    if (game.isDraw) return 'Both demo entries are returned in full. No platform fee is charged.';
    if (reason.includes('CHECKMATE')) return 'Checkmate. The winner receives the combined entries less the platform fee.';
    if (game.status === 'EXPIRED') return 'No one accepted before the invitation expired. No entries were held and no fee was charged.';
    if (reason.includes('INVITE_DECLINED')) return 'The invitation was declined. No entries were held and no fee was charged.';
    if (game.status === 'CANCELLED') return game.matchId ? 'This game was closed. Both held entries were refunded and no platform fee was charged.' : 'The invitation was cancelled before acceptance. No entries were held and no fee was charged.';
    return game.status === 'COMPLETED' ? 'This game has finished. The result and wallet settlement are saved.' : '';
  });
  private loadSequence = 0;
  private loadingCode: string | null = null;
  private refreshQueued = false;
  private destroyed = false;

  constructor() {
    const timer = setInterval(() => {
      const game = this.game();
      if (document.hidden || this.busy()) return;
      if (!game || game.status === 'PENDING' || game.status === 'ACTIVE') void this.load(false);
    }, 15000);
    const visibility = () => { if (!document.hidden) { void this.clock.sync(true); void this.load(false); } };
    document.addEventListener('visibilitychange', visibility);
    this.realtime.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.load(false));
    this.realtime.chess$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((event) => { if (event.code === this.code()) void this.load(false); });
    this.destroyRef.onDestroy(() => { this.destroyed = true; clearInterval(timer); document.removeEventListener('visibilitychange', visibility); });
  }
  ngOnChanges() {
    this.game.set(null); this.selected.set(null); this.draft.set(null); this.action.set(null); this.error.set('');
    void this.load();
  }
  async load(showLoading = true) {
    const code = this.code();
    if (this.loadingCode === code) { this.refreshQueued = true; return; }
    if (this.busy() && !showLoading) return;
    const sequence = ++this.loadSequence;
    this.loadingCode = code;
    if (showLoading && !this.game()) this.loading.set(true);
    try {
      const { game } = await this.api.get<{ game: ChessGame }>(`/chess/${encodeURIComponent(code)}`);
      if (this.destroyed || sequence !== this.loadSequence || code !== this.code()) return;
      this.apply(game); this.loadError.set(''); this.refreshError.set('');
    } catch (err) {
      if (this.destroyed || sequence !== this.loadSequence) return;
      if (this.game()) this.refreshError.set(apiError(err).message); else this.loadError.set(apiError(err).message);
    } finally {
      if (sequence === this.loadSequence) { this.loadingCode = null; this.loading.set(false); if (this.refreshQueued && !this.destroyed) { this.refreshQueued = false; void this.load(false); } }
    }
  }
  /** Prevent a delayed poll from rolling back a move confirmed by a newer response. */
  apply(game: ChessGame) {
    if (game.code !== this.code() || (this.game() && game.version < this.game()!.version)) return;
    const previous = this.game();
    if (previous?.version !== game.version) { this.selected.set(null); this.draft.set(null); this.moveChoice = ''; this.action.set(null); }
    this.game.set(game);
    if (game.viewerColor && previous?.status === 'ACTIVE' && ['COMPLETED','CANCELLED'].includes(game.status)) void this.auth.refreshMe().catch(() => {});
  }
  protected squareLabel(square: ChessSquare) {
    const suffix = this.selected() === square.name ? ', selected' : this.destinations().has(square.name) ? ', legal destination' : '';
    return `${square.name}, ${chessPieceLabel(square.piece)}${suffix}`;
  }
  protected lastMove(square: string) { return this.game()?.lastMove?.from === square || this.game()?.lastMove?.to === square; }
  protected checked(square: ChessSquare) {
    return !!this.game()?.inCheck && square.piece === (this.game()?.turn === 'w' ? 'K' : 'k');
  }
  selectSquare(square: ChessSquare) {
    this.focused.set(square.name);
    if (!this.canMove()) return;
    const choices = this.legal().filter((m) => m.from === this.selected() && m.to === square.name);
    if (choices.length) { this.prepareMove(choices); return; }
    const color = square.piece ? (square.piece === square.piece.toUpperCase() ? 'w' : 'b') : null;
    if (color === this.game()?.viewerColor && this.legal().some((m) => m.from === square.name)) this.selected.set(this.selected() === square.name ? null : square.name);
    else this.selected.set(null);
  }
  protected keyboard(event: KeyboardEvent, square: string) {
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 };
    const offset = offsets[event.key];
    if (offset === undefined) return;
    event.preventDefault();
    const i = this.squares().findIndex((s) => s.name === square);
    const next = i + offset;
    if (next < 0 || next > 63 || (Math.abs(offset) === 1 && Math.floor(next / 8) !== Math.floor(i / 8))) return;
    const name = this.squares()[next].name;
    this.focused.set(name);
    document.getElementById(`chess-square-${name}`)?.focus();
  }
  prepareMove(moves: ChessMove[]) {
    if (!this.canMove() || !moves.length) return;
    this.error.set(''); this.promotion.set(moves.some((m) => m.promotion === 'q') ? 'q' : moves[0].promotion ?? 'q'); this.draft.set(moves);
  }
  protected chooseFromList() {
    const [from, to, promotion] = this.moveChoice.split(':');
    const move = this.legal().find((m) => m.from === from && m.to === to && (m.promotion ?? '') === (promotion ?? ''));
    if (move) this.prepareMove([move]);
  }
  protected moveValue(move: ChessMove) { return `${move.from}:${move.to}:${move.promotion ?? ''}`; }
  protected closeMove() { if (!this.busy()) { this.draft.set(null); this.moveChoice = ''; } }
  async confirmMove() {
    const game = this.game(); const move = this.chosenMove();
    if (!game || !move || !this.canMove()) return;
    this.busy.set(true); this.error.set('');
    try {
      const result = await this.api.post<{ game: ChessGame }>(`/chess/${encodeURIComponent(game.code)}/move`, { from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}), version: game.version });
      this.apply(result.game); this.draft.set(null); this.selected.set(null); this.moveChoice = '';
    } catch (err) {
      this.error.set(apiError(err).message);
      this.draft.set(null); this.selected.set(null);
    } finally { this.busy.set(false); }
    await this.load(false);
  }
  protected ask(action: Action) { this.error.set(''); this.action.set(action); }
  protected closeAction() { if (!this.busy()) this.action.set(null); }
  async confirmAction() {
    const action = this.action(); const game = this.game();
    if (!action || !game || this.busy()) return;
    this.busy.set(true); this.error.set('');
    try {
      if (action === 'accept' && !this.auth.isLoggedIn()) await this.auth.guest();
      const path = action.startsWith('draw-') ? 'draw' : action;
      const body = action.startsWith('draw-') ? { action: action === 'draw-offer' ? 'offer' : 'accept' } : {};
      const result = await this.api.post<{ game: ChessGame }>(`/chess/${encodeURIComponent(game.code)}/${path}`, body);
      this.apply(result.game); this.action.set(null);
      await this.auth.refreshMe();
    } catch (err) { this.error.set(apiError(err).message); }
    finally { this.busy.set(false); }
    await this.load(false);
  }
  async declineDraw() {
    const game = this.game(); if (!game || this.busy()) return;
    this.busy.set(true); this.error.set('');
    try { this.apply((await this.api.post<{ game: ChessGame }>(`/chess/${encodeURIComponent(game.code)}/draw`, { action: 'decline' })).game); }
    catch (err) { this.error.set(apiError(err).message); }
    finally { this.busy.set(false); }
    await this.load(false);
  }
  protected async copyLink() {
    try { await navigator.clipboard.writeText(this.shareUrl()); this.copied.set(true); setTimeout(() => this.copied.set(false), 3000); }
    catch { this.error.set('Copy the invitation link from the field below.'); }
  }
}
