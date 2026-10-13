# Game usability and reliability review

The five live skill games and correspondence chess keep their existing server rules, timers and demo settlements. This pass improves the shared setup and clients:

- Setup uses each game's accent in a compact header and labels demo funds clearly. Waiting-player counts describe current availability rather than guaranteeing an immediate opponent.
- Reaction Rush supports native keyboard activation of focused targets, resets target timing between rounds, ignores late hits, matches provisional score thresholds and stops pending rounds/audio on exit.
- Aim Challenge offers a visible keyboard crosshair: arrows move, Shift reduces the step, Enter/Space fires at the chosen coordinates. It does not automatically centre a target. Pointer/touch aiming remains available. Late hits earn no points and destroyed games stop pending targets/audio.
- Memory Battle numbers tiles, supports native keyboard activation, ignores input once a round ends, matches the server's plausibility threshold and stops its pending input/audio on exit.
- Word Battle gives letter/slot controls accessible names and native keyboard activation, preserves typing/Backspace/Enter behavior, avoids intercepting Enter on a focused button, lays out large touch tiles in balanced rows and closes timers/audio on exit.
- All four quick games have an expandable controls/rules panel and a remembered sound toggle. Scores are labelled provisional; the server decides the final result.
- Penalty Shootout's sound control supports keyboards without accidentally taking a shot, and its audio context closes on exit. Existing live choice sealing, timeouts, forfeit and settlement rules remain covered by backend tests.
- A result waiting for submission is saved in tab session storage under the match and player ID, retried after reload, removed after server confirmation, and never sent again by a destroyed page. Timer deadlines still apply. Session storage recovery cannot help when the player clears/closes the tab's stored session or the device loses it.
- Unrecognized games show a recovery action rather than an empty play area. Small-phone HUDs and focus indicators are clearer.

Chess already saves moves on the server and retains its move confirmations, keyboard board, legal move list, promotion, draw/resign and individual turn deadlines. Its rules and payouts were rechecked through the existing suites; this pass does not alter chess rules.

Game result recovery is distinct from saving an unfinished quick-game round. Refreshing an unfinished live skill game still uses the existing server deadline; it does not pause or grant a new window. Correspondence chess remains the mode intended for returning across days.
