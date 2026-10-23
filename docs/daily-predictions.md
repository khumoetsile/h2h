# Daily Predictions

Daily Predictions is available at `/daily-predictions`; administration is at `/admin/daily-predictions`. It is independent of fixture-level free picks, model forecasts, Fantasy Arena, PvP settlement and wallets.

## Run locally

Use Node 22+ and a **local development MySQL 8 database**. Set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_NAME` in `backend/.env` to that database, then run from the repository root:

```powershell
npm run db:migrate
npm run dev
```

Visit `http://localhost:4200/daily-predictions`. The API also serves an existing production frontend build on its own port (`npm run build`, then `npm run start:api`). These commands do not deploy anything. Do not use `db:reset` on an existing database.

Migration `024_daily_predictions.sql` adds only new tables. Existing data and migrations are preserved. The backend is JavaScript and has no separate compilation step; run its test suite and syntax checks.

Optional configuration in `backend/.env`:

```dotenv
DAILY_PREDICTION_TIMEZONE=Africa/Gaborone
DAILY_PREDICTION_COUNT=1
```

The count accepts 1–10 challenges per day. The timezone must be a valid IANA zone. Calendar dates are fixed when published; do not change the timezone on an established installation without reviewing historical calendar boundaries.

Real fixtures must already be synced by the existing football provider. The mock provider deliberately produces **no Daily Predictions**. No new football API, paid subscription or production test fixtures are introduced. Automatic selection prefers enabled competitions in their configured order, with a recent successful sync (within six hours), and kickoff at least 30 minutes away. The worker fills available date/slot positions within the next 48 hours, defaulting to one fixture per day. Administrators can select a fixture and either participating reference team, or override an open challenge before it has any predictions.

## Integrity and scheduling

The existing server sweeper runs Daily Predictions at most once a minute. A MySQL advisory lock prevents duplicate scheduled runs across server processes. Unique date/slot, fixture and user/challenge constraints are additional backstops.

Submission locks the daily state, challenge and fixture inside a retryable transaction. It checks database UTC time, both the published cutoff and current fixture kickoff, fixture identity and status, and the active human account. Upserts allow an earlier selection to change without creating another contribution. The final write checks database time again. Football sync only moves a published deadline earlier and permanently records observed kickoff/live transitions; subsequent schedule changes cannot reopen it. No grace period applies to predictions.

The daily state row serializes statistics mutations across challenges, preventing a concurrent submission or settlement from overwriting a more recent rebuild. It also means writes queue briefly while a settlement commits. The 1,000-participant integration test exercises bulk settlement; this is not a production capacity benchmark.

Settlement uses the existing provider cache, once per challenge, never once per participant. Only a real `FINISHED` fixture with unchanged teams, nonnegative integer scores, a successful sync timestamp, `research_eligible=1` and explicit `REGULAR` score duration qualifies as a verified final result. Missing evidence, outages and extra-time-only totals stay pending. Postponed, cancelled, abandoned and invalidated fixtures void. There are no invented results or automated timeout losses. If a provider kickoff correction reveals a selection was saved after the actual deadline, the entire challenge is voided to avoid scoring a potentially informed pick.

Each result and all rebuilt summaries, achievements and notification deduplication records commit atomically. Each challenge revision has one audit record containing the provider identity, sync timestamp, score evidence, previous outcome and reason. Repeated settlement does nothing.

## Streak and accuracy rules

Challenge dates, not settlement dates, determine chronological order. Missing calendar dates and void challenges are skipped. An incorrect or missed resolved eligible day resets the winning streak. A submitted prediction awaiting verification creates a chronology barrier: later results may count in accuracy and leaderboard points, but cannot prematurely change the winning streak across that barrier. Verification or reconciliation replays the original dates.

Participation is separate: a submitted prediction for the current challenge day counts immediately. Pre-submitted future challenges count only when their original challenge day arrives; the worker refreshes summaries at the calendar boundary. A missed day breaks participation only after eligibility is established by a verified resolution. With multiple challenges per date, participating in every nonvoid challenge counts as one participation day; correctly predicting every eligible challenge counts as one winning day. The UI labels streaks in days.

Accuracy is correct / submitted, resolved eligible predictions. Pending, void and missed predictions are excluded from its denominator. Overall, last 7 and last 30 eligible accuracies return `null` for zero samples. Full streak history and longest streaks are rebuildable from authoritative challenge and prediction records. Summary rebuilding occurs on writes, not page reads; settlement fetches participant histories in batches and bulk-upserts summaries and awards.

## Leaderboards and achievements

Daily, Monday–Sunday weekly, calendar monthly and all-time rankings use original challenge dates in the configured zone. Correct predictions earn one point; incorrect earn zero; voids are excluded. Ties use points, then accuracy only for participants with at least five eligible predictions. Equal scores share `DENSE_RANK`; username and user ID only stabilize pagination and do not alter rank. The current user's row is returned separately even outside the requested page. Streak columns show current overall streaks.

Achievement milestones: first prediction, first correct prediction, winning streaks of 3/5/10 days, participation streaks of 7/30 days, and totals of 50/100 correct predictions. Awards are unique per user/code. Reconciliation deactivates awards that no longer qualify and preserves their history; recovering qualification reactivates the same award. There are no monetary awards.

Community totals come from one active row per participant and are returned only to users who submitted to that challenge. Individual selections are never returned for other users. Changing a prediction changes the aggregate. These percentages describe community opinion.

Optional in-app notifications use the existing notification service, are off by default, and can be disabled on the Daily Predictions page. Availability, approaching deadline, result revisions, streak increases and achievements have deduplication keys. No external push service is required or invoked for the new notification type.

## Official result corrections and unavailable results

1. Ensure the existing provider sync has stored the corrected official final score. Do not edit prediction rows or summary totals.
2. Open `/admin/daily-predictions`, find the challenge and enter a specific audit reason of 10–255 characters.
3. Choose **Reconcile cached official result**. The server independently checks cached final evidence. Unverified results leave records unchanged.
4. A changed result creates a new audit revision and atomically rebuilds totals, accuracy, chronological streaks and achievement eligibility. Leaderboards aggregate the new authoritative result immediately.
5. For a permanently unavailable result, choose **Permanently void with this reason**. A void excludes the day from failures, accuracy and scoring. A subsequently verified official result can be reconciled through the same administrator workflow.

Corrections are intentionally explicit administrator actions; a worker never silently revises a previously resolved outcome. Unavailable results can remain pending until verified or explicitly voided.

## API

All paths below are under `/api/daily-predictions`:

| Method | Path                                            | Access                                                  |
| ------ | ----------------------------------------------- | ------------------------------------------------------- |
| GET    | `/`                                             | Public; personal data only with own session             |
| PUT    | `/:id/prediction`                               | Authenticated, `{pick: "WIN"                            | "DRAW" | "LOSS"}` |
| GET    | `/history?filter=all&page=1&pageSize=20`        | Own session; filters all/correct/incorrect/pending/void |
| GET    | `/leaderboard?period=weekly&page=1&pageSize=20` | Public; periods daily/weekly/monthly/all                |
| PUT    | `/preferences`                                  | Own session, `{reminders: boolean}`                     |
| GET    | `/admin/fixtures`                               | Administrator; recent real upcoming fixtures            |
| GET    | `/admin/challenges`                             | Administrator; latest 100 challenges                    |
| POST   | `/admin/challenges`                             | Administrator, `{fixtureId, referenceTeamId, slot}`     |
| PUT    | `/admin/challenges/:id`                         | Administrator; override before any submission           |
| POST   | `/admin/challenges/:id/reconcile`               | Administrator, `{reason}`                               |
| POST   | `/admin/challenges/:id/void`                    | Administrator, `{reason}`                               |

Public responses omit community aggregates until the requesting user has submitted. Dashboard responses use `Cache-Control: no-store`. History and rankings are paginated and capped at 50 rows.

## Automated verification

Pure rules (no database):

```powershell
node --test backend/test/daily-prediction-rules.test.js
```

Database tests **reset the configured test database**. Point `DB_NAME_TEST` at a disposable local schema; never at development or production data. All backend regression files use this variable:

```powershell
$env:DB_HOST='127.0.0.1'
$env:DB_PORT='33307'
$env:DB_USER='root'
$env:DB_PASSWORD='h2h-local-test-only'
$env:DB_NAME_TEST='h2h_daily_test'
npm --prefix backend test
npm --prefix frontend test -- --watch=false
npm --prefix frontend run build
```

The local verification database was provisioned with:

```powershell
docker run --detach --rm --name h2h-daily-predictions-test --publish 127.0.0.1:33307:3306 --env MYSQL_ROOT_PASSWORD=h2h-local-test-only mysql:8.0
```

For real-browser checks, install/use Playwright with Chrome available (or point `PLAYWRIGHT_PACKAGE_PATH` to an existing Playwright package). Build the frontend first. The browser script refuses any host other than `127.0.0.1` or any database name other than `h2h_daily_browser`, and resets only that disposable schema:

```powershell
$env:DB_NAME='h2h_daily_browser'
node backend/scripts/check-daily-predictions-browser.js
```

It starts an isolated API on `127.0.0.1:33308`, seeds explicitly test-only fixtures, verifies guest privacy, real login, submission/update, unchanged wallet, kickoff lock, verified settlement, history, daily rankings and profile achievements, and captures 320/375/390/768/1440px screenshots under the system temporary directory `h2h-daily-browser-results`. This script does not start the fixture provider or background sweeper. Test fixture scores are written exclusively inside this disposable test schema.

Live provider delivery and production load must be verified in the appropriate environment; automated tests use controlled fixture evidence rather than live external results. No deployment or production migration is part of these checks.
