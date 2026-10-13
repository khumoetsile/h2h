import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ChessGame, chessPieceLabel, chessSquares } from '../../core/chess';
import { RealtimeService } from '../../core/realtime.service';
import { ServerClock } from '../../core/server-clock';
import { Toast } from '../../core/toast.service';
import { ChessGamePage } from './chess-game';

function activeGame(overrides: Partial<ChessGame> = {}): ChessGame {
  return {
    code: 'M-CHESSTEST', status: 'ACTIVE', matchId: 10, stake: 5, pool: 10, feePercent: 10, fee: 1, prize: 9,
    isDemo: true, turnSeconds: 86400, inviteExpiresAt: null, turnDeadline: '2026-10-14T10:00:00Z',
    serverNow: '2026-10-13T10:00:00Z', version: 2, createdAt: '2026-10-13T09:00:00Z', completedAt: null,
    createdBy: 1, opponentId: 2, white: { id: 1, username: 'WhitePlayer', avatarColor: '#fff' }, black: { id: 2, username: 'BlackPlayer', avatarColor: '#444' },
    viewerColor: 'w', isYourTurn: true, canAccept: false, canCancel: false, drawOfferedBy: null,
    winnerId: null, isDraw: false, resultReason: null, endReason: null, myOutcome: null, myPayout: 0,
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: [],
    legalMoves: [{ from: 'e2', to: 'e4', san: 'e4' }, { from: 'e2', to: 'e3', san: 'e3' }], inCheck: false, turn: 'w', lastMove: null,
    ...overrides,
  };
}

describe('correspondence chess board', () => {
  let get: ReturnType<typeof vi.fn>;
  let post: ReturnType<typeof vi.fn>;
  let auth: { user: ReturnType<typeof signal>; isLoggedIn: ReturnType<typeof vi.fn>; guest: ReturnType<typeof vi.fn>; refreshMe: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    get = vi.fn().mockResolvedValue({ game: activeGame() });
    post = vi.fn().mockResolvedValue({ game: activeGame({ version: 3, isYourTurn: false, turn: 'b', legalMoves: [], moves: [{ from: 'e2', to: 'e4', san: 'e4' }] }) });
    auth = { user: signal({ id: 1, username: 'WhitePlayer', avatarColor: '#fff', isGuest: false }), isLoggedIn: vi.fn().mockReturnValue(true), guest: vi.fn(), refreshMe: vi.fn().mockResolvedValue({}) };
    TestBed.configureTestingModule({
      imports: [ChessGamePage],
      providers: [provideRouter([]), { provide: Api, useValue: { get, post } }, { provide: AuthService, useValue: auth },
        { provide: RealtimeService, useValue: { chess$: new Subject(), reconnected$: new Subject() } },
        { provide: ServerClock, useValue: { remainingMs: () => 86400000, sync: vi.fn() } },
        { provide: Toast, useValue: { success: vi.fn() } }],
    });
  });
  async function page() {
    const fixture = TestBed.createComponent(ChessGamePage);
    fixture.componentRef.setInput('code', 'M-CHESSTEST');
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    return fixture;
  }
  it('requires review before sending a server-validated move and submits its exact version', async () => {
    const fixture = await page(); const component = fixture.componentInstance as any;
    const e2 = fixture.nativeElement.querySelector('#chess-square-e2') as HTMLButtonElement;
    e2.click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#chess-square-e4').getAttribute('aria-label')).toContain('legal destination');
    fixture.nativeElement.querySelector('#chess-square-e4').click(); fixture.detectChanges();
    expect(post).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[role="dialog"]')?.textContent).toContain('REVIEW YOUR MOVE');
    await component.confirmMove();
    expect(post).toHaveBeenCalledExactlyOnceWith('/chess/M-CHESSTEST/move', { from: 'e2', to: 'e4', version: 2 });
    expect(component.game().version).toBe(3);
    // The old polling response cannot replace the confirmed move.
    expect(component.game().moves).toHaveLength(1);
    expect(component.draft()).toBeNull();
  });
  it('offers every legal promotion and submits the selected piece', async () => {
    const promotions = ['q','r','b','n'] as const;
    get.mockResolvedValue({ game: activeGame({ fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1', legalMoves: promotions.map((promotion) => ({ from: 'a7', to: 'a8', promotion, san: `a8=${promotion.toUpperCase()}` })) }) });
    const fixture = await page(); const component = fixture.componentInstance as any;
    fixture.nativeElement.querySelector('#chess-square-a7').click(); fixture.nativeElement.querySelector('#chess-square-a8').click(); fixture.detectChanges();
    expect(component.promotions()).toEqual(promotions);
    fixture.nativeElement.querySelector('.promotions button[aria-label="knight"]').click(); fixture.detectChanges();
    await component.confirmMove();
    expect(post).toHaveBeenCalledWith('/chess/M-CHESSTEST/move', { from: 'a7', to: 'a8', promotion: 'n', version: 2 });
  });
  it('clears a prepared move when a newer server version arrives and ignores stale versions', async () => {
    const fixture = await page(); const component = fixture.componentInstance as any;
    component.prepareMove([{ from: 'e2', to: 'e4', san: 'e4' }]);
    component.apply(activeGame({ version: 5, isYourTurn: false }));
    expect(component.draft()).toBeNull();
    component.apply(activeGame({ version: 4, isYourTurn: true }));
    expect(component.game().version).toBe(5);
    expect(component.canMove()).toBe(false);
  });
  it('shows a retry after a load failure and recovers without fabricating a position', async () => {
    get.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    const fixture = await page(); const component = fixture.componentInstance as any;
    expect(component.game()).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Try again');
    expect(fixture.nativeElement.querySelector('.board')).toBeNull();
    await component.load(); fixture.detectChanges();
    expect(component.loadError()).toBe('');
    expect(fixture.nativeElement.querySelectorAll('.board .square')).toHaveLength(64);
  });
  it('disables moves after a failed refresh until authoritative state is refreshed', async () => {
    const fixture = await page(); const component = fixture.componentInstance as any;
    get.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 }));
    await component.load(false);
    expect(component.canMove()).toBe(false);
    expect(component.refreshError()).toContain('connect');
    await component.load(false);
    expect(component.canMove()).toBe(true);
  });
  it('requires consent before guest acceptance and then refreshes the wallet', async () => {
    auth.user.set(null); auth.isLoggedIn.mockReturnValue(false);
    get.mockResolvedValue({ game: activeGame({ status: 'PENDING', viewerColor: null, isYourTurn: false, legalMoves: [] }) });
    const fixture = await page(); const component = fixture.componentInstance as any;
    component.ask('accept');
    expect(auth.guest).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
    await component.confirmAction();
    expect(auth.guest).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith('/chess/M-CHESSTEST/accept', {});
    expect(auth.refreshMe).toHaveBeenCalledOnce();
  });
  it('does not let a spectator or the waiting player prepare a move', async () => {
    get.mockResolvedValue({ game: activeGame({ viewerColor: 'b', isYourTurn: false, legalMoves: [] }) });
    const fixture = await page(); const component = fixture.componentInstance as any;
    component.prepareMove([{ from: 'e2', to: 'e4', san: 'e4' }]);
    expect(component.draft()).toBeNull(); expect(post).not.toHaveBeenCalled();
  });
  it('requires the named account for a private invitation instead of creating an unusable guest', async () => {
    auth.user.set(null); auth.isLoggedIn.mockReturnValue(false);
    get.mockResolvedValue({ game: activeGame({ status:'PENDING', viewerColor:null, isYourTurn:false, opponentId:2, canAccept:false, legalMoves:[] }) });
    const fixture = await page();
    expect(fixture.nativeElement.textContent).toContain('Sign in to join');
    expect(fixture.nativeElement.textContent).not.toContain('Review & join');
    expect(auth.guest).not.toHaveBeenCalled();
  });
  it('keeps an administrator board read-only even when a draw offer is pending', async () => {
    auth.user.set({id:9,username:'Administrator',avatarColor:'#ccc',isGuest:false});
    get.mockResolvedValue({ game: activeGame({ viewerColor:null, isYourTurn:false, drawOfferedBy:2, legalMoves:[] }) });
    const fixture = await page();
    expect(fixture.nativeElement.querySelector('.draw-notice').textContent).toContain('BlackPlayer offered a draw');
    expect(fixture.nativeElement.querySelectorAll('.draw-notice button')).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('.player-line.me').textContent).toContain('WhitePlayer');
    expect(fixture.nativeElement.querySelector('.player-line.me').textContent).not.toContain('Administrator');
  });
  it('shows a completed draw as full refunds instead of a winner prize', async () => {
    get.mockResolvedValue({game:activeGame({status:'COMPLETED',isDraw:true,fee:0,isYourTurn:false,legalMoves:[],myOutcome:'DRAW',myPayout:5})});
    const fixture = await page();
    const recap = fixture.nativeElement.querySelector('.stake-panel').textContent;
    expect(recap).toContain('Each entry refunded');
    expect(recap).toContain('P0.00');
    expect(recap).not.toContain('Winner receives');
  });
});

describe('chess board display', () => {
  it('orients squares for Black and keeps piece names accessible', () => {
    const board = chessSquares('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'b');
    expect(board[0].name).toBe('h1'); expect(board[63].name).toBe('a8');
    expect(chessPieceLabel(board.find((square) => square.name === 'e1')!.piece)).toBe('White king');
    expect(chessPieceLabel(board.find((square) => square.name === 'e8')!.piece)).toBe('Black king');
  });
});
