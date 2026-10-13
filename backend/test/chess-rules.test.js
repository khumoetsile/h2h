import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { chessFromHistory, applyChessMove, chessOutcome, validateChessTurn } from '../src/games/chess.js';

test('server rejects illegal moves and moves leaving its king in check', () => {
  const chess = new Chess();
  assert.throws(() => applyChessMove(chess, { from: 'e2', to: 'e5' }), e => e.code === 'ILLEGAL_MOVE');
  const checked = new Chess('4k3/8/8/8/8/8/4r3/4K2R w - - 0 1');
  assert.throws(() => applyChessMove(checked, { from: 'h1', to: 'h2' }), e => e.code === 'ILLEGAL_MOVE');
});

test('castling and en passant persist when the full move history is replayed', () => {
  const chess = new Chess();
  for (const san of ['e4', 'a6', 'e5', 'd5', 'exd6', 'exd6', 'Nf3', 'Nf6', 'Be2', 'Be7', 'O-O']) chess.move(san);
  const history = chess.history({ verbose: true }).map(({ from, to, promotion }) => ({ from, to, ...(promotion ? { promotion } : {}) }));
  const resumed = chessFromHistory(history);
  assert.equal(resumed.fen(), chess.fen());
  assert.equal(resumed.pgn(), chess.pgn());
  assert.equal(resumed.get('g1').type, 'k');
  assert.equal(resumed.get('f1').type, 'r');
});

test('promotion is explicit and supports underpromotion', () => {
  const fen = '7k/P7/8/8/8/8/8/K7 w - - 0 1';
  assert.throws(() => applyChessMove(new Chess(fen), { from: 'a7', to: 'a8' }), e => e.code === 'ILLEGAL_MOVE');
  const chess = new Chess(fen);
  applyChessMove(chess, { from: 'a7', to: 'a8', promotion: 'n' });
  assert.equal(chess.get('a8').type, 'n');
});

test('checkmate selects the actual winning colour', () => {
  const chess = new Chess();
  for (const move of ['f3', 'e5', 'g4', 'Qh4#']) chess.move(move);
  assert.equal(chessOutcome(chess).winnerColor, 'b');
  assert.equal(chessOutcome(chess).endReason, 'CHESS_CHECKMATE');
});

test('threefold repetition survives reload; draw reasons cover material, stalemate and fifty moves', () => {
  const chess = new Chess();
  for (const move of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']) chess.move(move);
  const resumed = chessFromHistory(chess.history({ verbose: true }));
  assert.equal(chessOutcome(resumed).endReason, 'CHESS_REPETITION');
  assert.equal(chessOutcome(new Chess('7k/8/6QK/8/8/8/8/8 b - - 0 1')).endReason, 'CHESS_STALEMATE');
  assert.equal(chessOutcome(new Chess('7k/8/8/8/8/8/8/K7 w - - 0 1')).endReason, 'CHESS_MATERIAL');
  assert.equal(chessOutcome(new Chess('7k/8/8/8/8/8/R7/K7 w - - 100 51')).endReason, 'CHESS_FIFTY_MOVES');
});

test('turn ownership, version and deadline are server authoritative', () => {
  const game = { status: 'ACTIVE', turn_user_id: 1, version: 7, turn_deadline: new Date(Date.now() + 10000) };
  assert.throws(() => validateChessTurn(game, 2, 7), e => e.code === 'NOT_YOUR_TURN');
  assert.throws(() => validateChessTurn(game, 1, 6), e => e.code === 'STALE_CHESS_VERSION');
  assert.throws(() => validateChessTurn({ ...game, turn_deadline: new Date() }, 1, 7), e => e.code === 'CHESS_TURN_EXPIRED');
});
