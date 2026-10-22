# Approved PvP experience

The existing Angular/Express/MySQL architecture remains intact. Stakes, picks,
locks, refunds, deadlines, fees and results are still validated by the existing
server services. No payment provider is connected and all balances are simulated.

## Features

- New match codes use `H2H-` plus eight unambiguous characters. Existing `M-`
  invitations still work. Home and Challenges accept a code and open a review
  page; entering a code never commits funds.
- Invitations show a copyable code, WhatsApp link, native sharing where available
  and clipboard fallback. Football invitations lead to the specific public
  challenge's existing pick/stake review sheet. Private addressed challenges
  remain private and cannot be discovered in the public lobby.
- Challenges includes a public game opponent lobby, refreshed every 15 seconds.
  It excludes expired seats, bots, inactive hosts, private invites and your own
  seats. Joining still uses the transactional server join path. Football keeps
  its existing public opponent cards and lock-in review.
- Follow either team or the league on a fixture page, or a team on its own page.
  Home shows upcoming fixtures and open-challenge counts for those favourites.
  Requests include team/competition filters rather than filtering only the first
  global page. Results are deduplicated and sorted by kickoff, with partial-failure
  recovery. Up to 30 preferences are stored in this browser per account; they do
  not sync across devices. Clearing browser storage removes them.
- Existing quick stake tiles, rematches, competitive profile scores,
  head-to-head rivalry records, win streaks and period/game leaderboards are
  retained. Football's existing form, past meetings, statistical estimates and
  research integration remain accessible before creating a challenge. Existing
  supported football picks remain unchanged; no draw market is added to a
  two-sided market.
- Demo wallet keeps its balance breakdown and transaction ledger. The wallet
  explicitly explains that Orange Money, MyZaka and Smega are not connected.

## Verification without Docker

Run `npm --prefix frontend test -- --watch=false`, `npm --prefix frontend run
build`, and `npm --prefix backend test` against an isolated native MySQL 8 test
database. Backend tests rebuild their configured test database; never point
them at a development or production database. The existing CI workflow provides
MySQL 8 and deployment on pushes to main is gated by CI.

New tests cover code normalization and invalid inputs, corrupt preference
recovery and limits, and public-lobby privacy, authentication and expiry.

### Local verification, 22 October 2026

- The exact prepared commit builds successfully and passes all 104 frontend
  tests. The working checkout, including the separate daily-prediction work,
  also passed all 113 frontend tests. A final sharing change passed the seven
  focused match tests and a subsequent production build.
- All four invite/lobby API tests pass against an isolated native database.
- No local MySQL 8 server was available. The full backend suite was attempted
  using the installed MariaDB 10.4 executable in a temporary data directory on
  port 33317. It does not pass: MariaDB rejects the existing MySQL 8
  `FOR UPDATE SKIP LOCKED` queries. Full backend correctness remains unverified
  until the existing MySQL 8 CI job runs. No production query was weakened to
  accommodate this different database engine.
- Docker was not started. Pre-existing daily-prediction changes were excluded
  from this commit.
