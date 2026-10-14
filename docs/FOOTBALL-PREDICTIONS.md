# Football analysis and free predictions

This extends the existing Angular football pages, Express API, MySQL fixture lifecycle and authentication. Free picks never call wallet, stake, fee or challenge settlement services. PvP navigation remains optional.

## User experience

- `/football/research`: search two stable internal team IDs, swap them, and copy a shareable URL with the selected filters. Compare teams without an upcoming fixture. Separate recent form and direct meetings, 5/10/20 samples, all available meetings, competition, season and venue filters. Changing filters retains the current analysis section.
- `/football/:id`: history, form, venue breakdowns and responsive goal charts remain on the match page. Meeting sample controls are collapsed. Upcoming real fixtures also show Statistical Model, up to four real observations under “Why this prediction?”, Community Picks and a model/community comparison. Charts show scored, conceded and total goals; readable values are available without interpreting bars.
- `/football/predictions`: private personal history and separate public free-pick rankings. Guests can view analysis/community counts and sign in to save. Empty counts and rankings are real empty states.
- `/football/predictions/methodology`: public method, coverage limitations and chronological validation reports.

## Data and model

Reuses permitted OpenFootball CC0 JSON imports, verified stored football-data.org regulation-time results, and previously imported API-Football FT history. No HTML scraping, paid API call or AI service is required by prediction generation. Detailed shots, corners, possession and cards remain unavailable when the source did not supply them. Archive inconsistencies and conflicting duplicate scores are excluded, rather than guessed. Form samples use each team's own records; meeting percentages use the selected meeting sample and display denominators.

`poisson-strength-v1` estimates independent home/away goal counts with league home advantage, opponent-adjusted attack/defence strengths, exponential recency weighting (180-day half-life), a three-year lookback, and ten prior match equivalents shrinking sparse teams towards league strength. Existing H2H records are included once in team strength, without a second arbitrary H2H multiplier. Expected goals produce home/draw/away probabilities, normalised to one; displayed percentages use largest-remainder rounding and sum to 100%.

Training and each historical test exclude the target date **and the preceding calendar day**, because date-only archives cannot establish when results became known. Minimums: 200 league matches, 10 matches per team, four relevant home/away matches, six effective weighted observations, recent league/team evidence, and expected goals within the supported range. Insufficient, stale or unsupported data produces an unavailable state. Coverage labels depend on sample/venue/effective counts, never the largest probability.

Numerical publication requires at least 200 chronological evaluations, coverage of at least 70% of attempted fixtures, log loss and Brier no worse than the smoothed recency-weighted league-frequency baseline, and pooled classwise ten-bin calibration error at most 0.10. The most recent 400 fixtures are evaluated using rolling earlier-date fits. Over/under 2.5 and BTTS are derived from the same goal distribution and independently gated against their binary league baselines. Failed markets remain hidden.

Supported numerical models: Premier League (PL), Bundesliga (BL1), La Liga (PD), Serie A (SA), Ligue 1 (FL1). Cups and other competitions can still offer historical analysis and free picks; no unsupported league forecast is substituted.

### Real-data local validation, 14 October 2026

Four seasons per league (2023–24 through available 2026–27), plus verified copied public fixture records, were imported into an isolated local MySQL database. Each league attempted 400 later fixtures. These are retrospective backtests, **not live accuracy claims**.

| League | Evaluated / attempted | Model / baseline log loss | Model / baseline Brier | Model calibration error | Core gate | Published goal markets |
|---|---:|---:|---:|---:|---|---|
| PL | 364 / 400 | 1.007940 / 1.068211 | 0.602268 / 0.646873 | 0.022649 | Passed | BTTS |
| BL1 | 369 / 400 | 0.978506 / 1.072317 | 0.580320 / 0.649525 | 0.036555 | Passed | Over/under 2.5 |
| PD | 359 / 400 | 0.967796 / 1.028833 | 0.573002 / 0.618838 | 0.034821 | Passed | Both |
| SA | 364 / 400 | 0.963448 / 1.049824 | 0.570943 / 0.636283 | 0.061476 | Passed | BTTS |
| FL1 | 372 / 400 | 0.972730 / 1.026214 | 0.578631 / 0.619406 | 0.036708 | Passed | Both |

Production training independently recalculates these gates from production records; its current reports are available on the methodology page. Brier here sums squared errors across three outcomes; binary market Brier uses the conventional single-event score. Calibration is pooled over all outcome classes, with bin counts retained for inspection. No statistical-significance claim is made. Model parameters and thresholds are fixed; this initial evaluation is not an independent prospective trial.

### Production verification, 14 October 2026

[Deployment](https://github.com/khumoetsile/h2h/actions/runs/38532993029) and the [first production validation job](https://github.com/khumoetsile/h2h/actions/runs/38533354573) succeeded. Migration 021 is installed. Five stored league runs produced **126 immutable upcoming forecasts**; the database contained **zero community picks** and no completed forward evaluations at verification. Live fixture 14 returned a real forecast with percentages summing to 100%; fixture 31 retained its imported LASK–Liverpool meetings and the unsupported-competition model state.

Production evaluates a different canonical set of stored archive/provider records than the isolated local dataset. Each league attempted 400 fixtures, with 1,844 eligible evaluations in total:

| League | Evaluated | Model / baseline log loss | Model / baseline Brier | Calibration error | Published goal markets |
|---|---:|---:|---:|---:|---|
| Premier League | 373 | 1.005493 / 1.064447 | 0.600712 / 0.644247 | 0.025748 | BTTS |
| Bundesliga | 366 | 0.982244 / 1.074698 | 0.583013 / 0.651026 | 0.031118 | Over/under 2.5 |
| La Liga | 363 | 0.960950 / 1.026605 | 0.568138 / 0.617106 | 0.035378 | Over/under 2.5 |
| Serie A | 372 | 0.960760 / 1.052293 | 0.568883 / 0.637748 | 0.063102 | BTTS |
| Ligue 1 | 370 | 0.973448 / 1.025378 | 0.579033 / 0.618668 | 0.040114 | Both |

All core league gates passed. In particular, La Liga BTTS passes in the local dataset but fails in production and remains hidden there. Live reports always govern publication. No production vote or challenge was submitted for QA.

Limitations: retrospectively corrected source records rather than historical feed vintages; incomplete seasons and conditional coverage; no injuries, lineups, player strength, low-score correlation correction or guaranteed results. New/promoted teams may abstain. A pre-match league fit expires after seven days. The independent Poisson baseline is not a reproduction of [Dixon–Coles](https://doi.org/10.1111/1467-9876.00065). Predictions are statistical estimates, not betting advice.

## Persistence and API

Migration **021_football_predictions.sql** adds:

- `football_prediction_model_runs`: append-only fitted parameters, input hash, model version, data cutoff, baseline and calibration/backtest report.
- `football_model_predictions`: immutable probabilities/supporting inputs per fixture/run/kickoff/team identity. New runs append snapshots; finishing a match never recalculates or overwrites old probabilities. Reschedules preserve original snapshots. Only eligible pre-match snapshots are evaluated.
- `football_community_predictions`: unique `(user_id, fixture_id)`, current pick, original and updated submission times, frozen team IDs and verified final outcome.

Saving locks the fixture row, reads the database clock after acquiring the lock, and performs a conditional write before kickoff. This rejects a queued request that crosses kickoff, protects duplicate submissions and allows changes while open. Simulated fixtures and bot/inactive accounts cannot submit free picks. Authenticated personal selections are not exposed in guest responses. Result reconciliation uses verified regulation-time finals. Cancelled, abandoned, simulated, extra-time/unverified outcomes or invalid pre-match identities are void; postponed/live/pending fixtures do not count as incorrect. Rankings require 20 verified results and use a 95% Wilson lower bound of accuracy, rather than balances or submission volume.

Endpoints:

| Method and path | Access |
|---|---|
| `GET /api/football/fixtures/:id/predictions` | Public; current user's selection only with valid authentication |
| `PUT /api/football/fixtures/:id/prediction` | Authenticated human, body `{ "pick": "HOME" \| "DRAW" \| "AWAY" }`; 30 changes/minute |
| `GET /api/football/predictions/mine?page=1&pageSize=20` | Private |
| `GET /api/football/predictions/rankings` | Public |
| `GET /api/football/prediction-methodology` | Public |
| `GET /api/admin/football/predictions/evaluation` | Existing admin authentication; latest eligible snapshot per fixture/version, actual forward log loss/Brier/calibration/accuracy |

Forward accuracy starts empty and accumulates real completed fixtures. No production votes, predictions made after kickoff, or fabricated results are seeded.

## Operation and verification

No new environment variable or secret is required. Existing MySQL, JWT/session and fixture-provider settings continue to apply. Existing optional `API_FOOTBALL_KEY` supplements history; the model itself uses stored scores. Keep keys on the server. Hosting keeps the existing `DB_POOL_CONNECTION_LIMIT=6` override. Configure a live operational fixture provider for real upcoming fixtures; demo fixtures are explicitly ineligible.

From `backend`:

```text
npm ci
npm run migrate
npm run history:import -- --leagues=PL,BL1,PD,SA,FL1 --seasons=all
npm run predictions:train
npm start
```

`predictions:train -- --leagues=PL` limits training. It backtests stored results, saves each league run, records up to 200 upcoming fixtures within 21 days, reconciles outcomes and uses a MySQL advisory lock against duplicate jobs. The new GitHub workflow runs daily at 08:17 UTC and can be dispatched manually using existing cPanel SSH secrets/variables. Existing import runs remain separate. Never execute `db:reset` on production.

From `frontend`: `npm ci`, `npm start`, `npm test -- --watch=false`, `npm run build`. Backend: `npm test` against a disposable `DB_NAME_TEST` database (the suite rebuilds it).

Verified during implementation: 224 backend tests, 87 frontend tests and production build passed; new tests cover probability rounding, future/embargo leakage, sparse-team abstention, chronological metrics, public/private access, duplicate concurrent writes, changing picks, a request blocked until after kickoff, void/postponed results, accuracy/ranking minimums, snapshot immutability, user identity races and retaining the analysis section across filters. Existing PvP/wallet end-to-end tests remain included. Browser QA covers 320, 375, 390, 768 and 1440 px; search, swapping, season filters, twenty-match charts, real-model and unsupported-cup states, guest sign-in, saving/changing a local-only free pick, history and zero-rankings. No horizontal overflow; pick targets 70 px and sample controls at least 44 px. Warm local prediction responses measured 9–11 ms with a roughly 1.5 KB payload; production latency depends on hosting.

Model training does not run in page requests. Forecast fits cache for 60 seconds; an existing snapshot from the current validated run is reused without another write; historical analysis reuses the existing research cache. Upcoming community counts refresh every 30 seconds only while visible. New pages load through existing lazy routes; no chart library, AI SDK or extra package was added.

## Changed implementation files

Backend: migration 021; `footballPredictionModel.js`, `footballPredictionService.js`, `communityPredictionService.js`; training script/package command; football/admin routes; server result heartbeat; existing research service upcoming-fixture linkage; prediction tests. Automation: `.github/workflows/football-predictions.yml`.

Frontend: prediction types, `FootballPredictions` component, private history/rankings and methodology pages; routes; existing fixture/research/list pages, research result sample/venue controls, goal trend chart and research types; prediction/analysis tests. Existing authentication, team picker, history provider adapters, source importer, design tokens and challenge forms are reused.

## Later paid-provider integration

Implement the existing historical provider interface, map vendor team IDs to stable internal IDs, retain source/license/cutoff provenance, validate FT/regulation-time eligibility, and upsert canonical stored matches through the existing import layer. Keep quotas/caching/credentials server-side and enable the adapter by configuration. The frontend and prediction model continue to consume the same stored schema. Re-run chronological gates and inspect prospective snapshot performance before publishing new coverage or changing model versions. A paid provider is optional and is not enabled by this change.
