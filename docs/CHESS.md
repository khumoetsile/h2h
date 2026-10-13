# Correspondence chess

Chess lives at `/chess`, with each invitation and saved game at `/chess/:code`. It is discoverable from Play, Games, Challenges and the public landing page. Active turns and their deadlines appear in Challenges and the home screen. Accepted games also appear in My matches, wallet activity, player statistics, rankings and admin match/settlement records.

## Rules shown before commitment

- The creator plays White; the invited player plays Black. White moves first.
- An invitation lasts seven days by default. Sending it holds no funds. Named invitations can only be accepted by their recipient; open links can be accepted by one eligible player.
- Acceptance checks both available balances and holds both demo entries in one transaction. Insufficient balance leaves neither entry held. The fee, prize and turn duration are frozen when the invitation is created.
- Each player receives 24 hours per move by default. Acceptance starts White's first deadline; each legal, confirmed move starts the opponent's fresh deadline. Leaving the page, disconnecting and draw offers do not pause that deadline.
- Missing the deadline or resigning awards the other player the disclosed prize. The normal platform fee is deducted from the combined entry pool. There is no additional abandonment fee for chess.
- Checkmate wins. Stalemate, insufficient material, threefold repetition and the fifty-move rule are automatic draws. An agreed draw also ends the game. Draws refund both entries and charge no fee.
- These are Head2Head correspondence rules: a missed move deadline always awards the opponent a win. The app does not claim to implement FIDE tournament clock regulations or every optional tournament draw-claim procedure.
- Pending invitations may be withdrawn or declined without a fee. Accepted games end by result, resignation, agreed draw or an administrative cancellation/refund.
- All funds remain simulated. This feature does not enable real payments.

## Saved moves and settlement

The server uses [chess.js](https://github.com/jhlywa/chess.js) for legal moves. It stores the full move history, FEN, PGN and version in `chess_games`. Rebuilding the full history retains repetition detection after a restart. The browser receives legal destinations from the server and submits a move only after the player's review; it never submits scores or decides outcomes.

Every action locks the game row. A version prevents competing moves; an exact move retry is safe. Acceptance locks wallets in ascending user ID order. Accepted games use category `CHESS` in the existing matches, transactions and settlements tables. Unique ledger keys and the existing settlement guard prevent duplicate holds, payouts and refunds. Generic live-game routes reject chess.

Both the sweeper and chess reads/actions enforce expired deadlines. A late request commits any due timeout before returning an error. Stored deadlines survive server restarts. The existing heartbeat compensates detected platform downtime before the API begins accepting requests, with a transactional heartbeat lock preventing duplicate extensions across workers. Player connection loss does not extend a chess deadline.

Existing notification preferences control turn/draw push notifications and quiet hours; in-app notifications remain available. Push delivery is optional and is not a guarantee of receiving a reminder. Players must follow the displayed deadline.

## Configuration and deployment

Apply migration `017_correspondence_chess.sql` with the normal deployment migration runner. It adds the chess game catalogue row and the extension table without reseeding users or wallets.

```text
CHESS_TURN_TIMEOUT_SECONDS=86400
CHESS_INVITE_TIMEOUT_SECONDS=604800
```

These values apply to newly created invitations; existing games keep their saved duration. Use the existing platform fee and permitted entry settings. Disabling Chess in Admin prevents new invitations and acceptance while allowing active games to finish.

No separate chess bot, paid referral reward, engine assistance or chess-specific rating system is introduced. Broader release work includes abuse/cheating controls, real-player usability sessions and the existing support/email setup.

## Verification

Backend coverage includes legal/illegal moves, checkmate, castling, en passant, promotion, draw rules, saved-history repetition, acceptance balances, named/open invitations, deadline enforcement, fee snapshots, concurrency and repeated settlement, administrative cancellation races, and restart compensation. Frontend coverage includes consent before posting, promotion, server versions, stale responses, recovery from failures, private invitations, orientation, refund presentation and read-only admin controls. Responsive and two-player browser checks supplement these automated tests.
