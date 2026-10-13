// Headless legal move validation. Loading the full history preserves repetition
// detection; a FEN alone cannot tell whether a position has occurred before.
import { Chess } from 'chess.js';
import { badRequest, conflict } from '../utils/errors.js';

export function chessFromHistory(history = []) {
  const chess = new Chess();
  for (const move of history) chess.move({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
  return chess;
}

export function applyChessMove(chess, move) {
  try {
    const legal = chess.move({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
    if (!legal) throw new Error('Illegal move');
    return { from: legal.from, to: legal.to, ...(legal.promotion ? { promotion: legal.promotion } : {}), san: legal.san, color: legal.color };
  } catch {
    throw badRequest('ILLEGAL_MOVE', 'That move is not legal. Select one of the highlighted destinations.');
  }
}

export function chessOutcome(chess) {
  if (chess.isCheckmate()) return { winnerColor: chess.turn() === 'w' ? 'b' : 'w', endReason: 'CHESS_CHECKMATE', reason: 'Checkmate' };
  if (chess.isStalemate()) return { draw: true, endReason: 'CHESS_STALEMATE', reason: 'Stalemate, both entries refunded' };
  if (chess.isInsufficientMaterial()) return { draw: true, endReason: 'CHESS_MATERIAL', reason: 'Insufficient material, both entries refunded' };
  if (chess.isThreefoldRepetition()) return { draw: true, endReason: 'CHESS_REPETITION', reason: 'Threefold repetition, both entries refunded' };
  if (chess.isDrawByFiftyMoves()) return { draw: true, endReason: 'CHESS_FIFTY_MOVES', reason: 'Fifty-move draw, both entries refunded' };
  return null;
}

export function validateChessTurn(game, userId, version, now = new Date()) {
  if (game.status !== 'ACTIVE') throw conflict('CHESS_NOT_ACTIVE', 'This chess game is not active.');
  if (game.turn_user_id !== userId) throw conflict('NOT_YOUR_TURN', 'It is your opponent’s turn.');
  if (new Date(game.turn_deadline) <= now) throw conflict('CHESS_TURN_EXPIRED', 'The move deadline has passed. Refresh to see the result.');
  if (version !== game.version) throw conflict('STALE_CHESS_VERSION', 'The board has changed. Refresh before choosing a move.');
}
