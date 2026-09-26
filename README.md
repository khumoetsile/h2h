# Head2Head — peer-to-peer competitive gaming (prototype)

> ⚠️ **DEMO MODE — ALL MONEY IS SIMULATED.**
> Deposits, stakes, winnings, fees and withdrawals use **demo funds only**. No payment
> provider (DPO, Orange Money, MyZaka, Mascom, FNB, Visa, Mastercard, PayPal, Stripe or any
> other) is connected, and no real money can enter or leave the platform. All real-money
> functionality remains disabled until the Botswana regulatory/licensing requirements for a
> peer-to-peer competitive gaming platform have been reviewed and addressed — activating it is
> a future code change, not a runtime setting.

Head2Head is a 1v1 competitive gaming platform: two players stake (demo) money, compete —
never against the platform itself, always against each other — and the winner receives the
pool minus a configurable platform fee. There are two competition categories:

- **Head2Head Games** — five playable skill games with server-side scoring (see
  [How the games work](#how-the-games-work)).
- **Head2Head Football** — challenge another player on a real football fixture ("Who will
  win?", "Will both teams score?", …); Head2Head does not create the match, it retrieves
  fixture data from an external provider and settles the challenge once the real match is
  decided (see [Football](#football)).

Every outcome besides a clean win/loss is a **full refund with zero platform fee** — a draw, a
cancellation, or a competition that can no longer be fairly decided (a disconnect, a postponed
or abandoned fixture, missing provider data) never costs a player their stake and never earns
the platform a fee. The prototype is complete end-to-end — accounts, a ledgered demo wallet,
matchmaking, direct challenges, football fixture browsing and settlement, leaderboards,
notifications and an admin panel.

---

## Contents
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation & running](#installation--running)
- [Environment variables](#environment-variables)
- [Database setup, migrations & seed](#database-setup-migrations--seed)
- [Development credentials](#development-credentials)
- [How the demo wallet works](#how-the-demo-wallet-works)
- [How matchmaking & the match lifecycle work](#how-matchmaking--the-match-lifecycle-work)
- [How the games work (Reaction Rush and others)](#how-the-games-work)
- [Challenges](#challenges)
- [Football](#football)
- [Changing the platform fee](#changing-the-platform-fee)
- [API overview](#api-overview)
- [Security](#security)
- [Testing](#testing)
- [Renaming the product](#renaming-the-product)
- [Path to real money](#path-to-real-money)

---

## Architecture

```
┌──────────────────────────┐   /api (REST, JSON)    ┌─────────────────────────────┐     ┌──────────┐
│ Angular 21 SPA (frontend)│ ─────────────────────▶ │ Node.js + Express 5 (backend)│ ──▶ │ MySQL 8  │
│ standalone comps, signals│ ◀── Socket.IO events ─ │ services · game engines      │     └──────────┘
│ Angular Material, SCSS   │     (/socket.io)       │ sweeper (timeouts/expiry)    │
└──────────────────────────┘                        └─────────────────────────────┘
```

| Layer | Details |
|---|---|
| Frontend | Angular 21, standalone components, signals for state, zoneless change detection, Angular Material (forms, menus, snackbars, autocomplete, toggles), mobile-first SCSS design system. Dev server proxies `/api` and `/socket.io` to the backend. |
| Backend | Node.js 22, Express 5 REST API, Zod validation, JWT + server-side sessions, bcrypt password hashing, Helmet, rate-limited auth, Socket.IO for realtime pushes (polling fallback in the UI). |
| Database | MySQL 8 (InnoDB, FKs, CHECK constraints, indexes). SQL migrations in `backend/migrations`, applied by `scripts/migrate.js`. |

```
backend/
  migrations/001_initial_schema.sql   schema (users, sessions, wallets, transactions, games,
                                      matches, match_players, game_results, challenges,
                                      notifications, admin_settings, admin_audit_log)
  scripts/migrate.js, seed.js         migration runner + demo seed data
  src/
    app.js, server.js                 Express app, HTTP + Socket.IO server, sweeper
    services/                         wallet, match, challenge, stats, settings, auth, games…
    games/                            server-side game engines (spec, scoring, bots)
    routes/                           REST endpoints (+ zod schemas)
  test/api.test.js                    end-to-end API tests against MySQL
frontend/src/app/
  core/          auth, API client, interceptor, guards, realtime, config, models, BRAND
  layout/        app shell (desktop top nav, mobile bottom nav, notifications menu)
  features/      auth, dashboard, games, match (lobby + play), matches, challenges,
                 leaderboard, wallet, profile, notifications, admin/*
  games/         the five playable game components
  shared/        UI primitives (demo badge, empty/loading/error states, chips, pipes)
```

## Requirements

- **Node.js 22.12+** (tested with 22.22) and npm 10+
- **MySQL 8.0+** (a local install, or `docker compose up -d` using the included `docker-compose.yml`)

## Installation & running

```bash
# 1. Install everything and create backend/.env from the example
npm run setup

# 2. Make sure MySQL is running and the user in backend/.env exists.
#    Either use Docker:
docker compose up -d
#    …or create the user yourself (as MySQL root):
#    CREATE USER 'rivalis'@'localhost' IDENTIFIED BY 'rivalis_pass';
#    GRANT ALL ON rivalis_dev.* TO 'rivalis'@'localhost';
#    GRANT ALL ON rivalis_test.* TO 'rivalis'@'localhost';

# 3. Create the schema and load demo data
npm run db:reset

# 4. Start API (http://localhost:3000) and web app (http://localhost:4200) together
npm run dev
```

Or start them separately:

| | Command | URL |
|---|---|---|
| Backend | `cd backend && npm run dev` (watch) or `npm start` | http://localhost:3000/api/health |
| Frontend | `cd frontend && npm start` | http://localhost:4200 |

Open **http://localhost:4200** and log in with a [development account](#development-credentials).

> The npm projects include an `.npmrc` with `legacy-peer-deps=true` to avoid an npm 10
> resolver bug with an optional peer of `jsdom`.

## Environment variables

`backend/.env` (copy of `backend/.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `APP_NAME` | `Head2Head` | Product name used in API messages/notifications |
| `NODE_ENV` | `development` | `production` requires `JWT_SECRET` |
| `PORT` | `3000` | API port |
| `CORS_ORIGINS` | `http://localhost:4200` | Comma-separated allowed origins |
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` | MySQL connection |
| `DB_USER` / `DB_PASSWORD` | `rivalis` / `rivalis_pass` | MySQL credentials |
| `DB_NAME` | `rivalis_dev` | Database (created automatically by the migrator if permitted) |
| `DB_NAME_TEST` | `rivalis_test` | Database used by `npm test` (wiped on each run) |
| `JWT_SECRET` | — | Token signing secret — use a long random string |
| `SESSION_TTL_HOURS` | `12` | Session length without "Keep me signed in" |
| `SESSION_REMEMBER_TTL_DAYS` | `30` | Session length with "Keep me signed in" |
| `CURRENCY_SYMBOL` / `CURRENCY_CODE` | `P` / `BWP` | Display currency (Botswana Pula) |
| `DEMO_BOTS_ENABLED` | `true` | Lets a waiting player call in a house-bot opponent |
| `SWEEPER_INTERVAL_SECONDS` | `15` | How often timeouts / challenge expiry are processed |
| `FOOTBALL_PROVIDER` | `mock` | `mock` (deterministic simulated fixtures, no API key needed) or `football-data` (real data from football-data.org) |
| `FOOTBALL_API_KEY` | — | Required when `FOOTBALL_PROVIDER=football-data`; never sent to the browser — the backend is the only thing that ever calls the provider |
| `FOOTBALL_API_BASE_URL` | `https://api.football-data.org/v4` | Provider base URL |
| `FOOTBALL_SYNC_INTERVAL_SECONDS` | `20` | How often the background job pulls competitions/fixtures and checks for results |
| `FOOTBALL_FIXTURE_WINDOW_DAYS` | `21` | How far ahead upcoming fixtures are synced |

Business settings (fee, stakes, bonus, limits, timeouts) live in the `admin_settings` table and
are edited in the admin panel — see [Changing the platform fee](#changing-the-platform-fee).

## Database setup, migrations & seed

```bash
cd backend
npm run migrate     # apply pending migrations (tracked in schema_migrations)
npm run seed        # load demo data (skipped if users already exist)
npm run db:reset    # drop all tables, migrate, seed — a clean slate
```

Seed data (all flagged `is_demo_data = 1`, all balances simulated): an admin, a main demo
player, six opponents (one disabled, to test admin controls), three house bots, five games,
24 historic matches generated by actually running the game engines (22 completed, 2
cancelled) with a consistent ledger, demo deposits/withdrawals, pending/declined/expired
challenges and notifications.

## Development credentials

| Role | Email | Username | Password |
|---|---|---|---|
| **Admin** | `admin@example.com` | `admin` | `Admin123!` |
| **Player** | `player@example.com` | `player` | `Player123!` |
| Opponent | `kabelo@example.com` | `Kabelo` | `Player123!` |
| Opponent | `neo@example.com` | `NeoStrike` | `Player123!` |
| Opponent | `lesedi@example.com` | `LesediK` | `Player123!` |
| Opponent | `tumi@example.com` | `TumiFlash` | `Player123!` |
| Opponent | `ona@example.com` | `OnaPro` | `Player123!` |
| Disabled | `boitumelo@example.com` | `B_Tau` | `Player123!` (login blocked) |

House bots (`RivalBot`, `CircuitAce`, `PixelPro`) cannot log in. The login page has one-click
buttons to fill the main dev accounts.

**Testing a real 1v1 on one machine:** sign in as `player@example.com` in a normal window and
as `kabelo@example.com` in a private window (sessions are per-browser), pick the same game
and stake in both, and press **Find opponent**.

## How the demo wallet works

Every wallet has an **available** and a **locked** balance; **total = available + locked**.
All amounts are shown with a `DEMO` label and wallet screens carry "DEMO WALLET / DEMO FUNDS /
NO REAL MONEY" notices.

| Event | Available | Locked | Ledger row |
|---|---|---|---|
| Sign-up bonus (default P250) | + bonus | | `DEPOSIT` (DEMO_COMPLETED) |
| Demo deposit | + amount | | `DEPOSIT` (DEMO_COMPLETED) |
| Demo withdrawal | − amount | | `WITHDRAWAL` (DEMO_COMPLETED) |
| Enter a match | − stake | + stake | `GAME_ENTRY` |
| Win | + prize | − stake | `GAME_WIN` |
| Lose | | − stake | (stake went to the pool) |
| Draw / cancel before start / timeout | + stake | − stake | `REFUND` |

All money movement happens **on the server**, inside a MySQL transaction that locks the wallet
row (`SELECT … FOR UPDATE`). Negative balances are rejected in code and by `CHECK`
constraints. Each financial event has a unique idempotency key (e.g. `match:42:win`), so the
same entry/win/refund can never be written twice, and match settlement is additionally
guarded by `matches.settled_at`. Transactions store the balance after each movement, shown as
"Balance" in the history, which can be filtered by type and date.

The deposit and withdrawal screens are structured like a real cashier (presets P10 – P1,000,
custom amount, limits, confirmation) so a payment provider could later be slotted in behind
`walletService.demoDeposit` / `demoWithdrawal`. **Nothing in this codebase talks to a payment
provider.**

## How matchmaking & the match lifecycle work

```
WAITING ──(opponent joins)──▶ MATCHED ──(both ready)──▶ READY ──(first player starts)──▶ IN_PROGRESS ──(both submit)──▶ COMPLETED
   └──────────────┴──────────────┴── cancel / timeout (before anyone starts) ──▶ CANCELLED (stakes refunded)
```

1. The player picks a game and a stake and presses **FIND OPPONENT** (`POST /api/matches/find`).
2. Inside one transaction the server looks for the oldest `WAITING` public match with the
   **same game and same stake** from another active player (`FOR UPDATE SKIP LOCKED`, so two
   searchers can't grab the same match). If found, the player joins it and their stake is
   locked → `MATCHED`. Otherwise a new `WAITING` match is created with their stake locked.
3. Both players get a realtime `match:update` (Socket.IO) plus a notification; the lobby also
   polls every few seconds as a fallback.
4. Each player presses **I'm ready**; when both are ready the match is `READY`.
5. **Start game** calls `POST /api/matches/:id/start`, which reveals the game spec (the same
   seeded sequence for both players) and records the server start time. The match becomes
   `IN_PROGRESS`.
6. Each client submits its raw gameplay actions (`POST /api/matches/:id/result`). When both
   are in, the server scores them, decides the winner and settles the wallets atomically.

Timeouts (defaults, configurable in admin): a `WAITING` match auto-cancels after 30 min, a
matched game that nobody starts after 10 min, and once started each player has 10 min to
finish — if only one player submitted, the other forfeits; if neither did, stakes are refunded.

**Demo opponents:** while waiting, a player can press **Play a demo opponent**; a house bot
joins, stakes demo funds like anyone else, and plays using the same engine with human-like
timings. Disable with `DEMO_BOTS_ENABLED=false`.

## How the games work

All five games are playable. Each has a server-side engine in `backend/src/games/`:

- `buildSpec(seed)` — the deterministic challenge (both players receive the identical spec)
- `score(spec, actions)` — scores raw actions on the server
- `minDurationMs(...)` — plausibility check against the server-recorded start time
- `botPlay(...)` — behaviour for house bots

### Reaction Rush (flagship)
10 rounds. After a random delay (0.7 – 2.4 s) a target appears at a seeded position; tap it as
fast as possible. Each hit scores `clamp(1100 − 0.8 × reaction_ms, 100, 1000)`; a miss (1.5 s
window) or a tap before the target appears (false start) scores 0. Reactions under 100 ms are
physiologically implausible and score 0 (four or more invalidate the run). Highest total
wins; ties are broken by lower total reaction time; an exact tie is a draw with full refunds.
The client measures reaction time from the frame the target is painted, but only sends the
per-round results — **the server computes the score and the winner**. Submissions that arrive
faster than the sequence could physically be played are flagged invalid and score 0. The
result screen shows winner/loser, both scores, average/best reaction times, per-round
breakdown, prize and Match ID.

### Other games
- **Penalty Shootout** — 5 shots; stop a sweeping aim marker. The keeper's dive is hidden on
  the server; the ball position is recomputed server-side from the stop time.
- **Word Battle** — unscramble 8 words; answers never leave the server.
- **Memory Battle** — repeat growing tile sequences (3 → 9) on a 4×4 grid.
- **Aim Challenge** — 20 shrinking targets, scoring speed + precision.

> Note on trust: like any browser game, a determined cheater can script inputs. The server
> never accepts a client "I won"/score value, computes everything from raw actions, hides
> information where the game allows (Word Battle answers, keeper dives), and rejects
> impossible timings. Stronger guarantees would need server-driven rounds over WebSockets.

## Challenges

Search a player by username (`@Kabelo`), choose game + stake (+ optional message) and send.
The opponent sees "Kabelo challenged you" (notification + Challenges page) with **Accept /
Decline**. No money moves when a challenge is sent; on **accept**, both stakes are locked in a
single transaction and a real match is created in `MATCHED`. If either player can't cover the
stake, nothing is locked. Duplicate pending challenges (same pair + game) are rejected;
challenges expire after 60 minutes (configurable); the sender can cancel while pending.

## Football

Head2Head Football never creates or predicts the football match — it retrieves fixture data
from an external provider through the backend and lets two players stake demo money on a
question about that real match. The frontend never talks to the football provider directly,
and a provider API key is never exposed to the browser:

```
Football data provider ──▶ Head2Head backend ──▶ Head2Head database ──▶ Competition engine ──▶ Frontend
```

- **Providers** (`backend/src/football/providers/`) implement one small interface —
  `capabilities()`, `listCompetitions()`, `listUpcomingFixtures()`, `getFixture()` — selected at
  runtime via `FOOTBALL_PROVIDER`:
  - `mock` (default) — a fully-featured, deterministic simulated provider. Fixtures, scores,
    shots, corners, cards and goal events are derived from a seeded hash, not stored mutable
    state, so the same fixture always "plays out" the same way and no timers are needed. Every
    mock fixture is flagged `isSimulated: true` in the API and UI.
  - `football-data` — a real implementation against api.football-data.org. Its free tier does
    not provide shot/corner/card/event data, so it honestly reports
    `capabilities() = { statistics: false, events: false }`.
- **Challenge types are capability-gated**: each football challenge type
  (`football_challenge_types.requires_stats`) is only offered to players when the configured
  provider's `capabilities()` can actually supply what settling it requires. A provider that
  can't reliably supply shot/card/corner data never offers "Who will have more corners?" — the
  question simply isn't in `GET /api/football/challenge-types`.
- **A football challenge is a normal Head2Head match underneath** — the same `matches` /
  `match_players` / `wallets` / `transactions` tables as skill games, distinguished by
  `matches.category = 'FOOTBALL'` and a linked `football_challenges` row (fixture, question,
  each player's pick). This means the same wallet locking, idempotent settlement, and refund
  logic already used by skill games applies unchanged.
- **Settlement rules** (`backend/src/football/settlementRules.js`) are explicit per question
  type — e.g. "Who will win?" is a `DRAW` (full refund, no fee) if the real match is level;
  "Who scores first?" is `VOID` (full refund, no fee) if neither team ever scores. The backend
  is the only thing that ever decides an outcome; the frontend never guesses or shows a result
  before the backend has settled it.
- **Cutoff enforcement**: once a fixture is no longer `SCHEDULED`, or its kickoff time has
  passed, the backend rejects new challenges and late acceptances (`CHALLENGE_CLOSED`) — a
  player can never create or join a pick after information relevant to the outcome (a goal, a
  card) is already known.
- **If a result can never be reliably verified** — the fixture is postponed, cancelled or
  abandoned, or a required statistic never arrives from the provider — the match is voided
  with a full refund and zero fee rather than guessed. A background safety net
  (`voidUnresolvedFixtures`, `backend/src/football/footballSyncService.js`) voids any football
  match still unresolved 4 hours after its kickoff, so a stake can never be left in limbo
  forever because of a provider outage.
- **Supported competitions** are configurable (`football_supported_competitions` in
  `admin_settings`; defaults to Premier League, La Liga, Serie A, Bundesliga, Ligue 1 and the
  Champions League), not hardcoded to every league a provider offers.
- **Provider failures never cause an incorrect settlement**: every provider call is wrapped and
  logged to the `system_errors` table (visible at `GET /api/admin/system-errors`) instead of
  silently producing a wrong result.

## Changing the platform fee

The fee is **not hard-coded** — it's the `platform_fee_percent` row in `admin_settings`
(default 10%).

- **Admin panel:** log in as admin → **Settings** → *Platform fee* → Save. It applies to new
  matches immediately; each match snapshots its fee (`matches.fee_percent`) at creation, so
  in-flight matches keep their original terms.
- **API:** `PUT /api/admin/settings` with `{ "platform_fee_percent": 7.5 }` (0 – 50).
- **Default for fresh databases:** `SETTING_DEFAULTS` in
  `backend/src/services/settingsService.js`.

Example at 10%: two P20 stakes → pool P40 → fee P4 → winner receives **P36 DEMO**. Stake
amounts, deposit presets, sign-up bonus, limits and timeouts are edited the same way.

## API overview

All endpoints are under `/api`, JSON in/out. Authenticated endpoints need
`Authorization: Bearer <token>`. Errors look like
`{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "…", "details": { "fields": {…} } } }`.

| Method & path | Description |
|---|---|
| `GET /health`, `GET /config` | Health; public config (name, demo notice, fee, stakes, presets) |
| `POST /auth/register` · `POST /auth/login` · `POST /auth/logout` | Accounts & sessions |
| `GET /me` · `PATCH /me` · `POST /me/password` · `GET /me/stats` | Profile, stats |
| `GET /dashboard` | Wallet, stats, rank, active/recent matches, challenges, games |
| `GET /wallet` · `GET /wallet/transactions?type&from&to&page` | Demo wallet & ledger |
| `POST /wallet/demo-deposit` · `POST /wallet/demo-withdrawal` | `{ amount }` — simulated |
| `GET /games` · `GET /games/:slug` | Catalogue with entry/prize per stake and players waiting |
| `POST /matches/find` | Matchmaking `{ gameId, stake }` |
| `POST /matches` | Create a waiting match directly |
| `GET /matches?filter=all\|wins\|losses\|cancelled` · `GET /matches?status=active` | History |
| `GET /matches/queue` | Waiting counts per game/stake |
| `GET /matches/:id` | Match details (id or code) |
| `POST /matches/:id/join` · `/ready` · `/start` · `/result` · `/cancel` · `/demo-opponent` | Lifecycle |
| `GET /challenges?box&status` · `POST /challenges` · `GET /challenges/:id` | Challenges (skill games and football, dispatched automatically) |
| `POST /challenges/:id/accept` · `/decline` (alias `/reject`) · `/cancel` | Respond / withdraw |
| `GET /football/competitions` · `GET /football/challenge-types` | Enabled leagues; question types the current provider can settle |
| `GET /football/fixtures?competitionId&status` · `GET /football/fixtures/:id` | Upcoming/live fixtures; one fixture with its challenge questions |
| `POST /football/find` | Matchmaking `{ fixtureId, challengeTypeSlug, pick, stake }` |
| `POST /football/challenges` | Direct challenge `{ opponent, fixtureId, challengeTypeSlug, pick, stake, message }` |
| `GET /leaderboard?period=daily\|weekly\|all&gameId` | Leaderboard from real results |
| `GET /users/search?q=` · `GET /users/:username` | Player search, public profile |
| `GET /notifications` · `POST /notifications/:id/read` · `POST /notifications/read-all` | Notifications |
| `GET /admin/stats` | Platform KPIs (all financial values DEMO) |
| `GET /admin/users?q&status` · `GET /admin/users/:id` · `POST /admin/users/:id/status` · `POST /admin/users/:id/notify` | Users |
| `GET /admin/transactions` · `GET /admin/matches` · `GET /admin/matches/:id` · `POST /admin/matches/:id/cancel` · `GET /admin/challenges` | Oversight |
| `GET /admin/settings` · `PUT /admin/settings` · `GET /admin/games` · `PATCH /admin/games/:id` · `GET /admin/audit` | Configuration & audit log |
| `GET/PATCH /admin/football/competitions[/:id]` · `GET/PATCH /admin/football/challenge-types[/:id]` | Enable/disable leagues and question types |
| `GET /admin/football/fixtures` · `GET /admin/football/settlements` · `GET /admin/system-errors` | Fixture status, settlement history, provider/job errors |

Socket.IO events (authenticated with the same token): `wallet:update`, `notification`,
`match:update`, `challenge:update`, `queue:update`, `leaderboard:update`, `config:update`,
`session:revoked`.

## Security

- Passwords hashed with bcrypt; password policy enforced client- and server-side.
- JWTs are bound to a server-side session row, so logout, expiry and **disabling a user**
  revoke access immediately (a disabled user's open sockets are also signed out).
- Every input is validated server-side with Zod; the UI mirrors the rules for fast feedback.
- Wallet and match endpoints take the user from the session, never from the request body —
  a user cannot read or change another user's wallet. Match and challenge endpoints verify
  that the caller is a participant (or the challenged player, for accept/decline).
- Admin routes require the `ADMIN` role; admin actions are written to an audit log.
- Negative balances, double spending, duplicate settlement and duplicate winnings are
  prevented by row locks, CHECK constraints, idempotency keys and the settlement guard.
- Helmet headers, CORS allow-list, request size limit, rate-limited login/registration.

## Testing

```bash
cd backend && npm test      # 45 end-to-end API tests on a real MySQL test database (33 skill-game/wallet/admin + 12 football)
cd frontend && npm test -- --watch=false
cd frontend && npm run build
```

The backend suite (`backend/test/api.test.js`, `backend/test/football.test.js`) rebuilds
the test database and covers
registration/validation/duplicates, login/logout/session revocation, dashboard, demo
deposits & withdrawals (including concurrent withdrawals and parallel match entries that try
to overspend), game catalogue, matchmaking, lifecycle states, the identical spec for both
players, server-side winner calculation (a client claiming a win is ignored), wallet locking
and settlement, single settlement, too-fast submissions, cancellation refunds, timeouts and
forfeits, house bots, challenges (accept/decline/cancel/expiry/duplicates/permissions),
leaderboard periods, notifications, profile, admin access control, disabling users, fee and
stake configuration, game toggles, admin match cancellation, and a ledger-integrity check
that every wallet equals the sum of its ledger. The football suite additionally covers fixture
browsing and capability-gated challenge types, win/draw/void settlement with exact wallet math,
cutoff enforcement, matchmaking on opposite picks, postponed/abandoned-fixture refunds, a
required-stats challenge type that correctly waits (never guesses) until the provider's data
arrives or the unresolved-fixture grace period voids it, and duplicate/validation protection.

The full user journey was also exercised in a real browser (Playwright): register → deposit
→ withdraw → two players matched via matchmaking → Reaction Rush played → winner decided →
wallets settled → history/stats → challenge sent and accepted → leaderboard, notifications,
profile → admin dashboard, disabling a user, fee change.

## Renaming the product

To change the product name: update `BRAND.name` in `frontend/src/app/core/brand.ts`,
`APP_NAME` in `backend/.env`, and the `<title>` in `frontend/src/index.html`.

## Path to real money

This prototype is intentionally demo-only. Turning on real money is a **future code change**,
not a configuration flag, and should only happen after: Botswana gambling/gaming regulatory
and licensing review is complete; a licensed payment provider is integrated behind
`walletService.demoDeposit` / `demoWithdrawal`; age verification/KYC is implemented against the
forward-compatible `users.date_of_birth` / `users.kyc_status` columns and the `player_limits`
table already in the schema (currently unenforced); and responsible-gambling controls
(self-exclusion, deposit/loss limits) are built out. None of this is enabled today — every
balance in this codebase is simulated.
