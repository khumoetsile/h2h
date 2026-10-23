# Head2Head experience improvement work

## Audit and scope

The existing application is Angular 21 standalone/signal components, Express 5,
Socket.IO and MySQL 8. It already has server-authoritative PvP, turn-based chess,
football research, arenas, public football reads, notifications and demo wallets.
The initial working tree also contains an uncommitted Daily Predictions system,
including migration 024, streak chronology, persisted achievements and opt-in
reminders. This work integrates that system rather than creating a second one.

Observed usability issues: dashboard discovery cards precede urgent activity;
challenge-code entry dominates the first screen; football language assumes every
visitor wants to stake; discovery is concentrated on chess; desktop navigation
crowds at intermediate widths; My Matches uses a reading-column width; arena
empty pools need explanation; prediction calls to action do not reflect locked
or missing challenges; preference setup has no dismissible onboarding path.

## Implementation sequence

1. Core usability: action-first dashboard, adaptive summaries, 1280px discovery
   layout with narrower forms/readers, useful lobby recovery, compact navigation.
2. Connected journeys: football analysis/follows, arena discovery and progress,
   match summaries, existing Daily Predictions and private progress integration.
3. Supported enhancements: optional browser-scoped onboarding, existing rivalry
   history and result sharing, opt-in first-party measurement, notification links.
4. Verification: focused and full tests, build, isolated local database only,
   browser journeys at 320/375/390/768/1024/1440/1920px, screenshots and an honest
   record of any unavailable services or unverified transitions.

No Docker, production migration, push or deployment is part of this request.
Existing uncommitted work is preserved. Match/wallet/arena financial rules remain
owned by the original services. Test fixture evidence, when needed, is confined
to an explicitly created disposable local test schema, never production data.

## A. UX audit findings

- The dashboard led with a challenge-code input, favourites setup and discovery
  rather than a user's active turn or invitation. Several separate components
  competed for the same first screen.
- The public homepage primarily explained chess. Football copy implied that
  research was only preparation for a staked challenge. Rankings required login
  even though the returned records are competitive public information.
- Desktop content was inconsistently constrained, while the desktop navigation
  crowded at intermediate widths. My Matches unnecessarily used a narrow reader
  layout. The profile's action row overflowed by 7px at 320px in browser testing.
- Empty lobbies and zero-entry arenas did not sufficiently explain the next
  useful action. A zero pool is valid and must not be disguised.
- Prediction previews offered the same action even when no challenge existed or
  submissions had locked. Separate discovery reads repeated the same request.
- Match detail's rematch flow could treat football as a skill game; history
  filtering could display a slower earlier response after a newer selection.
- The app already had notification preferences, quiet hours, deep links, rivalries,
  result statistics and a complete local Daily Predictions implementation. Those
  were reused rather than replaced.

## B. Implemented experience

### Core usability

- Home now prioritises a real chess turn, actionable skill match, unexpired
  invitation, eligible free prediction or active arena. Eligibility uses server
  deadlines and the existing shared server clock. The fallback offers games and
  free football exploration without requiring a wallet action.
- Compact activity totals use the existing dashboard aggregation, including the
  full active-match query total rather than the limited preview count. Continue
  Playing appears before discovery. Challenge-code entry is expandable.
- Main discovery pages use a 1280px content width, responsive grids and shrinking
  cells. Reading/form layouts stay intentionally narrower. Authentication retains
  the same controls, recovery, validation, loading and safe local return path.
- Desktop navigation groups Home, Football, Arena, My Activity, Challenges and
  Rankings. Predictions and account actions remain accessible in the account
  menu. The existing mobile bottom navigation remains the only bottom navigation.
- Empty opponents lead to creating a challenge, inviting a friend, choosing a
  different game or trying a free prediction. Failed reads are not presented as
  proof of zero participants. Arena-entry failures have a specific recovery link.

### Connected journeys

- The public homepage explains games, football analysis, free predictions,
  arenas and rankings, with direct public exploration. Rankings now have an
  anonymous read path; private wallet, dashboard and activity routes stay gated.
- Football adds clear Today/Live/Upcoming/Results/Following entry points,
  accessible follow actions, direct full-comparison links, compact past-meeting
  rows, score-null handling and a link when a fixture belongs to Daily Predictions.
  Existing kickoff restrictions and provider freshness notices are preserved.
- Favourite fixtures appear in a personalised feed without repeating those teams
  in the general home list. Recent results are sourced from stored fixture reads.
  The recent-results preview covers the first six favourites; upcoming reads cover
  all saved favourites. These browser preferences do not sync across devices.
- Arena discovery shows real participants, entry fee, current/locked pool,
  published fee and projected payouts. Zero-entry explanations and free
  alternatives remain truthful. Personal entries are available from home and
  My Activity. The Mine sign-in link preserves its destination. A discovery
  effect no longer causes an extra request merely when a tab changes.
- My Matches has verified completed record, decisive win rate and actual active
  count, plus routes to My Arenas, prediction history and profile progress.
  Filters remain bookmarkable. Request ordering and pagination error recovery
  preserve the selected view and already-loaded rows.
- Football rematches select a new fixture with the opponent carried forward;
  chess rematches return to setup with the opponent filled in. Unresolved matches
  cannot launch the result rematch action. Verified results can be copied/shared
  without exposing a private match URL, wallet details or a session token.
- Player rivalry views show recent actual encounters with dates/results and
  participant-authorised links. Existing daily achievements and the two distinct
  streaks remain backed by the existing stored settlement system.

### Supported engagement improvements

- Optional setup selects football, live games or chess interests, can be skipped,
  and does not reappear after saved dismissal. A football preference changes
  narrow-screen discovery order. Active obligations always remain above discovery.
  Settings can be changed under Profile → Preferences & privacy.
- Prediction previews share a short-lived, account-scoped discovery read and are
  refreshed from the actual prediction page after updates. Compact football
  previews avoid repeating the full progress card everywhere. Empty/locked
  challenges offer appropriate discovery or results actions.
- First-party usage measurement is OFF by default. An explicit account/browser
  preference enables category-only page views and selected UX actions. It sends
  no raw URLs, search strings, form contents, wallet amounts, IP address fields,
  user-agent fields or third-party tracking requests. Stored fields are account
  ID, event UUID, visit UUID, allowlisted event/category and server timestamp.
- Turning measurement off stops new client events. Deleting it waits for current
  client submissions before deleting the account's events. Only administrators
  can see aggregate cohorts. This is observational instrumentation, not proof
  that retention improved and not an authoritative source of match outcomes.

## C. Relevant files

Frontend:

- `frontend/src/styles.scss`, `frontend/src/app/layout/shell.{ts,html,scss}`
- `frontend/src/app/features/dashboard/dashboard.{ts,html,scss,spec.ts}`
- `frontend/src/app/features/landing/landing.ts`, `features/auth/auth-layout.scss`
- `frontend/src/app/features/football/football-list.ts`, `football-fixture.{ts,html,scss}`,
  `football-research-results.scss`
- `frontend/src/app/features/arena/arena-lobby.ts`, `arena-detail.html`, `arena.scss`
- `frontend/src/app/features/matches/match-history.ts`, `match-detail.{ts,html}`
- `frontend/src/app/features/profile/profile.ts`, `player-profile.ts`,
  `features/chess/chess-home.ts`
- `frontend/src/app/core/{next-action,daily-experience,experience-preferences,experience-measurement}.ts`
- `frontend/src/app/shared/{experience-setup,measurement-settings,experience-metrics,result-share}.ts`,
  `opponent-lobby.ts`, `personalized-feed.ts`
- Existing `features/daily-predictions/*` and `core/daily-predictions.ts` were
  integrated, including previews and discovery-cache refresh after submissions.
- Targeted `.spec.ts` files cover prioritisation, account isolation, measurement
  consent, discovery requests, response ordering and rematch destinations.
- The existing Material icon subset and its cache version were regenerated.

Backend:

- `backend/src/routes/{me,leaderboard,experience}.js`, `backend/src/app.js`
- `backend/src/football/dailyPredictionService.js` adds the public fixture identity
  to daily overview records for the contextual fixture action.
- `backend/migrations/025_experience_measurement.sql`, `backend/test/experience.test.js`
- `backend/scripts/{check-experience-browser,experience-baseline}.js`
- Daily Predictions migration 024, services, routes and regression tests were
  already present locally and remain part of the current working-tree feature.

## D. Backend and database changes

- `GET /api/dashboard` adds `activeMatchCount` from the existing match-list total.
- `GET /api/leaderboard` permits anonymous reads, rate-limits requests, returns
  only existing competitive fields and returns `me: null` without a session.
  Responses are private/non-cacheable so personalised position is never shared.
- `POST /api/experience/events` requires authentication, validates a strict
  allowlist and UUIDs, rate-limits writes and deduplicates by event ID.
- `DELETE /api/experience/events` removes only the authenticated account's rows.
- `GET /api/experience/summary` requires an administrator and returns aggregates
  only: opt-in daily/weekly activity, selected actions, recovery clicks and
  exact UTC-day 1/7/30 return cohorts with eligible denominators.
- Migration 025 creates only the optional measurement table and time/user
  indexes. It was applied ONLY to newly created local test databases. Migration
  024 remains the existing daily-prediction migration. Neither was applied to
  the user's configured development database or to production during this work.
- No match/arena payout, prize share, lock, refund, tie, ledger, authentication
  credential or real-money payment rule was changed.

## E. Executed checks

| Check | Result |
| --- | --- |
| Full backend suite on native MySQL 8.0.46 | **275 passed; 0 failed** |
| Final frontend suite | **127 passed across 33 files** |
| Angular production build | **Passed** |
| New public-read, activity and measurement API regressions | **4 passed**, included in full backend run |
| Main real-browser route/viewport checks | **112 passed**, no horizontal overflow |
| Main browser exceptions / failed API responses | **0 / 0** |
| Daily Predictions browser workflow | **Passed**, including actual API writes and verified-result test evidence in its isolated schema |
| Daily selection targets and widths | **>=44px**; 320/375/390/768/1440px passed |
| Read-only aggregate baseline script | Executed successfully against a local test schema; not production retention evidence |

The first in-progress backend run encountered an incomplete development version
of migration 025. Its foreign-key type was corrected to match `users.id`, then
the final full run above passed. The metrics test also caught an SQL grouping
error; the corrected query passed the administrator and privacy regression.

Browser testing found and repaired the 320px profile overflow and a dashboard
personal-arena URL mismatch. Request monitoring was added so silent API failures
cannot be mistaken for a successful browser run.

Production build: about 711kB initial raw JavaScript/CSS, about 186kB estimated
transfer. The earlier feature build was about 709kB/185kB. No heavy UI library or
production dependency was added. These bundle figures are not a controlled
network-speed or retention benchmark.

## F. Verified journeys and their limits

| Journey | Evidence |
| --- | --- |
| First-time visitor | Browser: homepage → public football → fixture analysis → protected action → sign-in → original fixture |
| New player | Browser: real local account → action-first home → game setup → reviewed demo entry → invitation → second account joins |
| Returning player | Browser: existing accepted chess game → home next-action → legal e2/e4 move with confirmation → verified completion after opponent resigns → updated home results |
| Football researcher | Browser: real public fixture snapshot → analysis reads → follow team → personalised home; backend research regressions cover historical samples |
| Arena participant | Browser: real-fixture local competition → Win/Draw/Loss selections → existing wallet entry → My Arenas → saved entry. Backend and frontend regressions cover locking, live/final standings, ties, actual rewards and refunds; the browser did not wait for future real matches to finish |
| Empty opponent lobby | Browser: truthful empty state → invite setup → copy-code control → second-account invitation review and join |
| Returning prediction player | Existing real-browser runner: sign-in, submit/update before kickoff, private/community state, wallet unchanged, server locking, verified-result settlement, history, leaderboard, achievements and administrator reconciliation/void. Controlled provider-shaped result evidence is confined to that disposable test schema |
| Preferences/privacy | Browser: setup skip persists; consent starts measurement; deletion clears the account's events; administrator reads aggregates |

All seven requested widths were checked for the main pages: landing, public
football, analysis, dashboard, empty Challenges, empty/active Matches, Arena,
My Arenas, arena entry, Rankings, Profile, Daily Predictions, Login, returning
player home and administrator metrics. Not every possible screen-reader/browser
combination or every game-engine interaction was manually audited.

## G. Measurement and remaining work

For a baseline, deliberately configure a read-only production connection and run
`node backend/scripts/experience-baseline.js` only when authorised. It reports
rolling 30-day persisted participation and 24-hour activation, excludes immature
activation cohorts and excludes seeded/bot accounts. It does not change data.
Capture the same window after release. Use the existing audit/match/prediction/
arena tables for verified creation, acceptance, completion and entry counts.

Use `/api/experience/summary` or the administrator overview for opt-in visit and
return cohorts. A Day 30 return rate needs a mature 30-day cohort. Empty-state
recovery is a click count, not proof that a game subsequently completed. A
first-observed visit is not guaranteed to be the person's first-ever visit.
Anonymous visitors and users who decline measurement are deliberately absent.
Core Web Vitals and end-to-end load times need controlled before/after field
measurements; no improvement percentage is claimed here.

Remaining release work: review the local changes, authorise any development or
production migrations, then separately authorise committing/pushing/deployment.
No push or deployment was performed. Optional future enhancements include
cross-device game-interest preferences and a broader set of verified-event
achievements; existing daily achievements were reused instead of introducing
a parallel rewards system. Real provider delivery, paid credentials and actual
future live-match results were not exercised or changed by this work.

## H. Screenshots and repeatable browser verification

Desktop/mobile screenshots and a machine-readable check report are in
`artifacts/ux-review/`, including:

- `landing-{320,1440}.png`
- `dashboard-{320,1440}.png`, `returning-player-{320,1440}.png`
- `football-public-{320,1440}.png`, `analysis-public-{320,1440}.png`
- `arena-{320,1440}.png`, `arena-entry-{320,1440}.png`
- `matches-active-{320,1440}.png`, `challenges-empty-{320,1440}.png`
- `profile-{320,1440}.png`, `admin-metrics-{320,1440}.png`
- `browser-report.json`

These are LOCAL QA screenshots, not screenshots of a deployment. Main football
screens use read-only snapshots from the deployed public fixture API. Only
explicit local QA accounts create entries; no public activity or prize totals
were fabricated. Daily Predictions' separate controlled-test screenshots remain
in `%TEMP%/h2h-daily-browser-results` and are not marketing evidence of live games.

`check-experience-browser.js` refuses any existing database and requires an
explicit new `h2h_ux_browser_<8 hex>` schema on `127.0.0.1:33318`. It copies only
catalogue metadata from the separate `h2h_ux_targeted` test schema and reads
public fixture snapshots. It does not start background sync/sweeper jobs or write
to the reference deployment. The native MySQL runtime and all schemas used in
this task were temporary; no Docker service was started or used.
