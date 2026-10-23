# Daily Predictions verification report

Verified locally on 21 October 2026 using Node 24.18.0, MySQL 8.0.46 in a disposable Docker container, Angular's production build, Vitest, Node's test runner, Supertest and headless installed Chrome through Playwright.

## Completed implementation

- Migration `024_daily_predictions.sql`: daily challenge snapshots, unique date/slot and fixture identities, unique per-user predictions, rebuildable statistics, unique achievement awards, audited result revisions, opt-in notification preferences/deduplication and a statistics serialization/calendar state row.
- Backend: `dailyPredictionService.js`, `dailyPredictionRules.js` and authenticated/administrator endpoints under `/api/daily-predictions`. Existing football sync preserves earlier deadlines and permanent locks. The existing server sweeper selects real cached fixtures and settles verified results once per minute.
- Streaks: chronological original challenge dates; distinct winning and participation counts, best streaks and history; misses and incorrect results break eligible days; voids and unpublished days do not; pending results protect chronology. Future challenge dates cannot earn streak days early. Configurable timezone defaults to Africa/Gaborone.
- Accuracy and scoring: overall and last 7/30 eligible predictions, zero-sample empty states, one point for correct and zero for incorrect, voids excluded. Daily/weekly/monthly/all-time SQL leaderboards use shared ranks, pagination and a separate current-user position.
- Achievements and community: persistent milestone awards with correction-aware eligibility, real aggregate selections disclosed only after personal submission, and opt-in in-app availability/deadline/result/streak/achievement notifications.
- Angular: `DailyPredictionsPage`, `DailyPreview`, `AdminDailyPredictionsPage` and typed API models. Integrated routes, navigation/account menu, Football, dashboard and profile. Includes history filters/pagination, state feedback, submission editing, deadline locking, reminders, leaderboards and profile achievements.
- Administration: real fixture and reference-team selection, immutable challenges after submission, explicitly reasoned official-result reconciliation and permanent voiding. Both replay derived statistics and leave audit revisions.

## Results

| Check                                                   | Result                                                  |
| ------------------------------------------------------- | ------------------------------------------------------- |
| Full backend regression run                             | 265 tests passed, 52 suites, no failures                |
| Final expanded pure rule tests                          | 15 passed                                               |
| Final expanded database/API integration tests           | 15 passed                                               |
| Final frontend suite                                    | 109 passed across 24 files                              |
| Final production frontend build                         | Passed                                                  |
| Changed backend JavaScript syntax checks                | Passed                                                  |
| Git whitespace check                                    | Passed                                                  |
| Fresh migration through 024 on isolated MySQL 8 schemas | Passed                                                  |
| Real-browser user journey                               | Passed                                                  |
| Real-browser administrator publication and audited void | Passed                                                  |
| 320, 375, 390, 768 and 1440px checks                    | No horizontal overflow; selection targets at least 44px |

The final targeted backend reruns cover the final feature changes made after the full regression run, including future-date streak protection and daily summary rollover. The full regression result and expanded targeted counts are separate runs, not an inflated combined test count.

Integration checks include concurrent prediction updates, one-row uniqueness, invalid selections/reference teams, fixture coverage validation, cutoff rejection, permanently retained locks after rescheduling, private community aggregates, unchanged wallet data, idempotent result processing/awards/notices, historical corrections, administrator authorisation, postponed/unverified fixtures, explicit permanent voiding, corrected-kickoff timing invalidation, transaction rollback during submission and settlement, shared leaderboard ranks, own-rank lookup, pagination and bulk settlement for 1,000 participants.

The browser journey covers real login, Win/Draw/Loss selection, submission/update, community visibility, wallet isolation, live-match locking, verified settlement, refreshed statistics, history filtering, daily leaderboard position, profile achievements, administrator login/publication with an away reference team, and an audited void action. No browser exceptions were recorded.

Browser screenshots are in `%TEMP%\h2h-daily-browser-results`. Run logs are `%TEMP%\h2h-daily-backend-tests.log`, `%TEMP%\h2h-daily-current-tests.log`, `%TEMP%\h2h-daily-frontend-tests.log`, `%TEMP%\h2h-daily-build.log` and `%TEMP%\h2h-daily-browser.log`.

## Limits and environment

- External live provider delivery/credentials were not exercised. Settlement was verified with controlled provider-shaped evidence exclusively in isolated test databases. Production challenges still require real fixtures from the existing configured provider; the mock provider does not produce daily challenges.
- The installed runtime is Node 24. Node 22 was not available for a separate compatibility run.
- The 1,000-participant check verifies functional bulk settlement; it is not a production throughput benchmark. The daily state row intentionally serializes statistics writes for consistency.
- Results without explicit trustworthy regular-time final evidence remain pending until verified or explicitly voided by an administrator.
- The original development database was not migrated because its configured local MySQL service was unavailable. Migrations and all database tests ran on separate disposable MySQL 8 schemas instead.
- The temporary test container was stopped after verification. No production data was changed, no deployment was made, and no repository changes were committed.
- Pre-existing `.gitignore`, `.claude/`, `.vscode/` and `docker` work was left intact.

See [the implementation and local run guide](daily-predictions.md) for configuration, endpoint details, reconciliation rules and exact commands.
