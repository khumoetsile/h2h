# Fantasy Arena

Fantasy Arena is a separate multiplayer competition using the existing demo wallet. Existing games, chess and 1v1 football rules are unchanged. No real-money provider is connected.

## Player experience

Open `/arena` from the main navigation. Open, Live, Finished and My arenas have separate tabs. Every participant gets the same ordered fixtures and chooses **Win / Draw / Loss** for the clearly named reference team, which may be the away team. Confirmation requires every choice, deducts the entry once and holds it in escrow. Edits are free until closing. Own choices are always visible; other players' choices become public only after locking. Administrators can inspect slips for support.

Participant counts and projected prizes grow with confirmed entries. Socket.IO broadcasts public pool changes without broadcasting private picks; 15-second detail and 20-second lobby polling provide recovery. Leaderboards use bounded 25-player pages and show your position separately. Refreshes preserve the leaderboard page and unsaved choices. Notifications link to results and refunds.

## Rules and accounting

- Defaults: five fixtures in the admin picker, 10% arena fee and 50% / 30% / 20% prizes. Fixture count, entry fee, fee percentage and shares are configurable per draft. Shares must total 100%.
- Publishing freezes all rules and the shared slip, even before anyone joins. To change published rules, cancel before lock and create a new draft.
- Entries close at the earliest fixture kickoff using database UTC time. Earlier reschedules bring closing forward; later reschedules never extend or reopen it. A request queued behind a wallet lock cannot charge after closing.
- At least three confirmed players are required. Fewer players cause full refunds and zero platform fee. Count and prize pool freeze at lock.
- A verified regulation-time result awards one point for a correct choice, zero for an incorrect choice. Cancelled or abandoned matches are void. Unverified or postponed results wait up to 72 hours after the kickoff recorded at publication, then become void. Extra-time-only results are void. All-void arenas refund everyone without a fee.
- Competition ranking uses points only: equal scores have equal ranks. Ties share all prize positions occupied by that group. Two tied first-place players share first and second prizes; the next rank is third. Remainder cents are allocated deterministically by entry ID, without changing anyone's rank.
- Fees, pools and payouts use integer cents; prize slots use largest-remainder rounding. Payouts plus fee exactly equal the frozen gross pool. Arena row locks serialize entry and settlement; wallet movements, audit records, notifications and terminal status commit together. A unique settlement per arena and ledger idempotency keys prevent duplicate refunds or payouts.
- Cancellation is allowed only for drafts and open arenas. Once locked, the declared fixture resolution rules govern settlement.

## Admin setup

### Automatic Big Match arenas

The platform now creates and publishes competitions automatically; an administrator does not need to prepare the normal daily slips. Every 15 minutes, it checks real, recently synced upcoming fixtures and prepares the next two eligible match days. Each slip contains up to five matches (minimum three) featuring a reviewed list of major clubs in the Premier League, Champions League, La Liga, Serie A, Bundesliga and Ligue 1. Big-club versus big-club fixtures receive priority. Calendar dates use Botswana time, with at least two hours before the first kickoff at creation.

Default automatic entry is P20, fee 10%, prizes 50/30/20. Selection requires fixture data synced within six hours. A database lock and unique daily key prevent duplicate arenas across simultaneous sweepers or restarts. Empty or stale schedules do not create fictional matches. Automatic actions are audited as SYSTEM; the existing active admin remains the ownership contact. Existing manual competitions and participants are preserved.

Migration **023_automatic_arenas.sql** adds the unique automatic key. Selection lives in `src/football/automaticArenaService.js`. No additional credentials or scheduler setup is required beyond the running application and existing football feed.

### Optional manual competitions

1. Sign in as an administrator and open `/admin/arenas`.
2. Create a draft, name it and choose a demo entry fee. Select real upcoming fixtures from enabled competitions. Search by team or competition; “Next 5” provides a starting slip.
3. Arrange fixture order and choose the reference team for each fixture. Check fee and prize shares.
4. Save, review the shared slip, then Publish. Players can now join from the public lobby.
5. Monitor counts, predictions, live ranks and completed settlement records. Cancelling an open arena requires a reason and automatically refunds all entries.

No fictional entrant or result is seeded by this feature. Automatic competitions use the existing real football feed; admins can additionally publish special competitions. Existing real football-provider credentials and enabled competitions must supply upcoming fixtures and verified final results. No new environment variables are required. The existing background sweeper advances active arenas; detail reads also advance the selected arena.

## Migration and files

Run the normal deployment migration (`cd backend && npm run migrate`). Migration **022_fantasy_arena.sql** adds arenas, ordered fixtures, entries, predictions and settlement tables; it extends the existing transaction enum and adds an arena ledger link. It does not reset wallets or games.

Backend: `src/football/fantasyArenaService.js`, `src/routes/fantasyArena.js`, wallet service, API/admin mounts and server sweep integration. Public API uses `/api/arenas`; protected administration uses `/api/admin/arenas`.

Frontend: `core/fantasy-arena.ts`, `features/arena/{arena-lobby,arena-detail,admin-arenas}`, shared Arena styles, routes, navigation, realtime updates and notification presentation. Generated icon assets include the new navigation icon.

## Validation

Commands used: `npm run migrate` in an isolated local database; backend `npm test`; frontend `npm run icons`, `npm test -- --watch=false`, and `npm run build`. Existing dependencies were reused. Tests use disposable MySQL databases, never production.

Arena tests cover configuration, privacy, complete slips, duplicate requests, concurrent entrants, insufficient funds, a wallet-lock wait across closing, free edits, minimum-player refunds, reference-team scoring, tied rewards, idempotent settlement, voids/timeouts, earlier and later kickoff changes, cancellation audit links, unverified scores and 101 confirmed entrants with bounded leaderboard pages and exact-cent tied payouts. Frontend tests cover choices, sign-in, confirmation, errors, deadlines, identity changes, pool updates and retained pagination. Existing football, chess, games, wallet and authentication suites are included in the full regression run.

Browser QA used desktop and 320 / 375 / 390 / 768px layouts. All had no horizontal overflow, 58px prediction targets and reachable confirmation controls. Admin creation and publication, player confirmation, real fixture ordering, away-team captions, privacy and saved-entry feedback were exercised locally. Preview fixture records were copies of upcoming public provider data; preview entries exist only in a disposable local database.

## Operational limits

There is no participant cap. The 101-player integration test validates pagination and accounting, but thousands of simultaneous participants still require host-specific load testing. Settlement currently pays all entrants in one atomic transaction, so very large arenas may temporarily contend for wallets. Published/final arenas are immutable; post-settlement provider corrections require operational review rather than automatic clawbacks. Football-provider availability determines how quickly verified scores arrive. Arena fees are recorded separately in settlement audits; older 1v1 dashboard revenue totals retain their existing scope.
