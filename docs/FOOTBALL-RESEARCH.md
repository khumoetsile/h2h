# Historical football research

October 2026 reliability update: real fixture detail and `/fixtures/:id/insights` now read the same verified local archive as research, without live history, form or standings requests. Missing history no longer depends on a vendor returning HTTP 429. The old fixture insights response uses a conservative cutoff before the fixture day; the full comparison shows completed matches and supports pagination. Upcoming/default fixture lists exclude past scheduled kickoffs.

Football-data polling now caches the competition catalogue for six hours, refreshes the full fixture window every ten minutes, and uses one current/recent score batch for live and final results. Cached fixture-window responses are not repeatedly written over newer live scores. HTTP 429 activates a bounded cooldown; known competitions remain available during catalogue failures. API-Football remains the budget-limited history supplement, with strict reviewed name/country aliases for additional major clubs. Missing coverage is not represented as a zero score or a claim that two clubs have never met.

`/football/research` is public. Select two teams to compare, or open a fixture's preselected comparison. Team, competition, season, venue, date and sample selections survive refresh and are shareable. No registration is required.

## Dashboard

A balanced comparison shows the selected sample, wins/draws/losses and percentages, goals for both teams, average goals, both teams scoring and over 2.5. Overview adds over 1.5/3.5 frequencies, clean sheets and a few deterministic insights. Meetings show dates, competition, venue, scores, outcomes, half-time scores and expandable optional statistics. Team form supports last 5/10, home/away samples and lightweight goals charts with readable values. All meetings are paginated in groups of 20 while the summary covers the full selected sample.

Unknown values remain unavailable; genuine zeros remain zero. Unverified, awarded/unplayed, conflicting scores and detected inconsistent season dates are excluded. Archive date-only values are displayed as calendar dates, without inventing kickoff times. These frequencies describe stored history and are not forecasts or betting advice. Completed seasons and recent form may have gaps; Sources & coverage explains provenance and the latest result/import dates.

## Source decision

The initial provider downloads [OpenFootball JSON](https://github.com/openfootball/football.json), whose [CC0-1.0 dedication](https://github.com/openfootball/football.json/blob/master/LICENSE.md) permits reuse and redistribution. The project explicitly provides raw download links. This uses published JSON datasets; HTML scraping, browser automation, CAPTCHA bypass and paywall/authentication bypass are unnecessary. The files do not contain shots, possession, corners, fouls or disciplinary cards. Badges continue using already configured team reference data, not scraped images.

Football-Data.co.uk was evaluated for its richer downloadable statistics. Free download availability and a copyright notice do not establish permission to republish the required statistics in this product, so it is not imported without clearer permission. The existing free football-data.org integration continues syncing operational fixtures. Research requests read only stored records and make no provider calls.

OpenFootball updates its generated JSON daily, but upstream contributions are not guaranteed daily or complete. Coverage is reported as the available archive, never an all-time database. Selected source records contain inconsistent years in late-season rounds; they are retained raw and excluded rather than silently redated.

## Supported archives and commands

Migration `019_historical_football.sql` adds imports/raw snapshots, explicit team aliases, normalized research matches and revision records. It adds date/pair/season indexes. Existing fixtures, challenges, settlements, timers and wallets are not populated or changed by historical imports.

Run from `backend` after migration and initial normal fixture synchronization:

```text
npm run migrate
npm run history:import -- --list
npm run history:import -- --leagues=PL --seasons=all
npm run history:import -- --leagues=PL,BL1,PD,SA,FL1 --seasons=all
npm run history:import -- --leagues=PL --seasons=2024-25 --force
```

League codes: `PL` Premier League; `BL1` Bundesliga; `PD` Primera Division; `SA` Serie A; `FL1` Ligue 1. Supported seasons are 2015-16 through 2026-27. Counts reflect available verified results, including incomplete current seasons.

Imports are sequential, limited to 60 allowlisted files per run, 2 MB per file, 15-second request timeouts and three HTTP attempts. They respect retry cooldowns and fail closed on access denials. A run stops after three file failures. Each season has a database advisory lock. Stored completed seasons skip downloads; current seasons check at most daily. `--force` conditionally rechecks archives for corrections using ETags. Failed updates retain the previous good data and log the error. A one-hour failure cooldown applies to ordinary retries.

Hashes and stable club/season pairing keys prevent duplicates. Changed results preserve their previous raw record in revisions. Removed records become withdrawn. Raw snapshot, source URL, license, ETag, content hash and import times remain traceable. Team identity compares exact UTF-8 code points in the same league, including older latin1-hosted tables, or uses a reviewed explicit alias map; approximate name matching never merges clubs. Ambiguous cross-source identities stop an import. Unmatched names keep separate source identities rather than being fuzzy-merged. Rechecking an archive can repair a source-only duplicate when one exact existing reference club is available; old comparison IDs resolve through the repaired alias.

The `Update football history` GitHub workflow updates the latest supported season daily with existing deployment SSH credentials. Manual dispatch can select leagues/seasons and recheck archives. It runs independently of page requests and deployment. Adding later seasons requires an explicit catalogue update.

## Replace or supplement the provider later

`FootballDataProvider` now has optional offline `historicalSeasons`, `historicalLicense`, `historicalUrl` and `loadHistoricalSeason` methods. The OpenFootball adapter returns a normalized snapshot (season, competition, exact team identities, dates, verification status, full/half-time scores, optional statistic pairs, raw records and hashes).

A paid adapter can implement the same contract, declare its permitted license/use, resolve source identities through explicit aliases to existing internal team IDs, and pass snapshots to `storeHistoricalSeason`. Register that adapter in the importer CLI after reviewing its permitted usage and source limits. The Angular page and analytics continue reading the same normalized tables; provider-specific fields do not enter the UI. Archive results remain separate from the operational settlement source. This release purchases or activates no paid API.

## Related discovery

Featured games retain permanent Chess plus two random enabled live games, swipe/keyboard controls and reduced-motion support. Notifications retain server search, unread/category filters, paging and shared read-state recovery.


### Simpler fixture browsing (14 October 2026)

The football list now uses one search field and compact match rows. Competition/date dropdowns and day filter controls are removed from this page. Past results retain their own section. Opening a fixture automatically loads the stored head-to-head history on that same page, defaulting to past meetings. Recent form and goal trends are available beside it without navigating to a separate research page. The comparison tool remains available for arbitrary pairs of teams.

Fixture history uses all available meetings and the last ten team results. Missing historical coverage is stated explicitly. The supplied key belongs to API-Football, which is connected separately for historical research as described below.


### API-Football supplementary history

`API_FOOTBALL_KEY` is stored only in the server environment. It uses the direct API-Sports host and `x-apisports-key` header, never frontend code or public query parameters. `FOOTBALL_PROVIDER` continues to select the operational fixture/settlement provider; this addition does not replace it. The account status was verified as active Free, 100 requests per day.

Migration `020_api_football_history.sql` adds provider team links and persistent daily request accounting. No operational fixtures are created by this importer. Club links require reviewed exact name/country matching, or an unambiguous exact name. Women's/youth/other-country identities cannot match approximately. Unresolved identities remain pending review rather than receiving invented histories.

Commands on the configured server:

```
npm run migrate
npm run history:api-football -- --fixture=31
npm run history:api-football -- --limit=8
```

A fixture pair is checked at most once per 24 hours; `--force` is available for a deliberate correction check. The daily history workflow rotates through up to eight uncached/oldest upcoming pairs in the next 21 days. A persistent budget defaults to 40 outbound requests/day (`API_FOOTBALL_HISTORY_DAILY_REQUESTS`, maximum 80), with 6.5-second spacing and a further ten-request provider reserve when quota headers are supplied. Every attempted call is reserved before sending, including failed calls. No vendor HTTP requests are made by public research page requests.

Completed regulation-time (FT) matches are imported with original provider fixture IDs, actual competition and season, real final/half-time scores. Future, awarded, AET/PEN and unfinished matches are excluded from this analysis. Up to two newest completed meetings are enriched with statistics when supplied; missing values stay unavailable. Corrections are audited. An empty or restricted response never removes previously stored scores, and outages keep existing results with a stale-data notice. A returned match that is no longer FT stops contributing until verified again.

API-Football is a commercial API source, not CC0; source attribution says “API-Football terms”. Its terms allow application development but do not grant third-party competition publication rights and prohibit direct data resale: https://www.api-football.com/terms . Plan coverage and any applicable publication rights remain the operator's responsibility. No paid subscription or additional commercial rights were purchased.

Shared cPanel hosting: set DB_POOL_CONNECTION_LIMIT below the account's MySQL connection cap. Production uses six app connections; excess idle connections expire after 30 seconds to leave room for research imports. CI also runs the backend suite with a six-connection pool.

API-Football team search only permits ASCII alphanumeric text and spaces. Discovery queries strip diacritics/punctuation, but returned identities are still checked against the exact reviewed name and country. Expected search/plan coverage gaps are logged for review; exhausted quotas stop a run without erasing existing data. Authentication, network and database failures still fail the job.
