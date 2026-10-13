export type ChessColor = 'w' | 'b';
export type ChessPromotion = 'q' | 'r' | 'b' | 'n';
export interface ChessMove { from: string; to: string; promotion?: ChessPromotion; san: string; color?: ChessColor; }
export interface ChessPlayer { id: number; username: string; avatarColor: string; }
export interface ChessConfig {
  turnSeconds: number; inviteSeconds: number; stakeAmounts: number[]; platformFeePercent: number;
  stakeBreakdown: Array<{ stake: number; pool: number; fee: number; prize: number }>;
  serverNow: string; isDemo: boolean; isEnabled?: boolean;
}
export interface ChessGame {
  code: string; status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
  matchId: number | null; stake: number; pool: number; feePercent: number; fee: number; prize: number;
  isDemo: boolean; turnSeconds: number; inviteExpiresAt: string | null; turnDeadline: string | null;
  serverNow: string; version: number; createdAt: string; completedAt: string | null;
  createdBy: number; opponentId: number | null; white: ChessPlayer; black: ChessPlayer | null;
  viewerColor: ChessColor | null; isYourTurn: boolean; canAccept: boolean; canCancel: boolean; canDecline?: boolean;
  drawOfferedBy: number | null; winnerId: number | null; isDraw: boolean; resultReason: string | null;
  endReason: string | null; myOutcome: string | null; myPayout: number | null;
  fen?: string; pgn?: string; moves?: ChessMove[]; legalMoves?: ChessMove[]; inCheck?: boolean;
  turn?: ChessColor; lastMove?: ChessMove | null;
}
export interface ChessSquare { name: string; piece: string | null; dark: boolean; file: string; rank: string; }
export const PIECE_NAMES: Record<string, string> = { p: 'pawn', r: 'rook', n: 'knight', b: 'bishop', q: 'queen', k: 'king' };

/** FEN is display data from the server. Move legality is never inferred here. */
export function chessSquares(fen: string | undefined, color: ChessColor = 'w'): ChessSquare[] {
  const pieces = new Map<string, string>();
  for (const [row, chars] of (fen?.split(' ')[0] ?? '').split('/').entries()) {
    let file = 0;
    for (const piece of chars) {
      if (/^[1-8]$/.test(piece)) file += Number(piece);
      else { if (file < 8 && row < 8 && /^[prnbqkPRNBQK]$/.test(piece)) pieces.set('abcdefgh'[file] + (8 - row), piece); ++file; }
    }
  }
  const names = Array.from({ length: 64 }, (_, i) => 'abcdefgh'[i % 8] + (8 - Math.floor(i / 8)));
  if (color === 'b') names.reverse();
  return names.map((name) => ({ name, piece: pieces.get(name) ?? null, dark: ('abcdefgh'.indexOf(name[0]) + Number(name[1])) % 2 === 0, file: name[0], rank: name[1] }));
}
export function chessPieceLabel(piece: string | null) {
  return piece ? `${piece === piece.toUpperCase() ? 'White' : 'Black'} ${PIECE_NAMES[piece.toLowerCase()] ?? 'piece'}` : 'empty';
}
export function chessStatus(game: ChessGame) {
  if (game.status === 'PENDING') return game.canAccept ? 'Invitation for you' : 'Awaiting opponent';
  if (game.status === 'ACTIVE') return game.isYourTurn ? 'Your turn' : 'Waiting for opponent';
  if (game.isDraw) return 'Draw · stakes refunded';
  if (game.myOutcome === 'WIN') return 'You won';
  if (game.myOutcome === 'LOSS') return 'You lost';
  return ({ COMPLETED: 'Completed', CANCELLED: 'Cancelled', EXPIRED: 'Invitation expired' } as Record<string, string>)[game.status] ?? game.status;
}
