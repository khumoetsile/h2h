# Football research and discovery

The public `/football/research` page compares any two teams in the supported, locally synced directory. It does not require an upcoming fixture or an account. Team search, venue, competition and date filters are shareable through the URL. Fixture search also accepts matchup phrases such as `Liverpool vs Chelsea` in either team order.

## Reading the results

The page shows wins/draws/losses, average total goals, both teams scoring and over 2.5 goals, followed by past scores or each team's recent form. Percentages include their sample counts. Missing scores are excluded, never converted to zero. Regulation scores are used where supplied; otherwise the reported final score can include extra time. Identified awarded/unplayed matches are excluded. Source, update time, cached/partial status and coverage details are visible.

These statistics describe the available history, not a complete all-time record or a prediction. Head-to-head uses up to 50 verified meetings; recent form uses up to 10 matches per team. Provider history is bounded to 500 results per team and supported enabled competitions. Football-data history explicitly requests the past 749 days, within its 750-day request limit, instead of its current-season default. Older synced records can also contribute. Historical coverage and freshness depend on the configured provider and its subscription. Existing settlement scores and challenge rules are unchanged.

## API and loading

- `GET /api/football/teams?q=&competitionId=&limit=` searches the supported synced directory.
- `GET /api/football/research?teamA=&teamB=&venue=all|home|away&competitionId=&dateFrom=&dateTo=` returns verified history, summaries, form and provenance.
- Fixture detail supports `includeInsights=false` for fast initial loading. The browser requests research only when the player opens it.
- Provider requests coalesce by team, with a bounded 15-minute cache, a short failure cooldown, explicit stale fallback and request timeouts. Frontend caches and search requests are bounded and discard stale responses.
- Migration 018 adds research eligibility and score-duration metadata without changing settlement logic.

## Discovery and activity

Landing, Play and Games feature a swipeable carousel with Chess always first and two randomly selected enabled live games. Picks remain stable during background refresh. Previous/next controls and labelled dots support keyboards; offscreen actions leave the tab order. Motion respects reduced-motion preferences and there is no autoplay. The public catalogue exposes only display metadata; playing still uses authenticated setup.

Notifications now support server-side search, categories, unread filtering and pagination. The bell and full inbox share read operations, error recovery and race protection. Messages group into Today/Earlier, and long messages can expand. Escape closes the bell menu and restores focus.

## Validation

The release was checked against an isolated MySQL database and real browser interactions at desktop, 390px and 320px widths. Coverage includes provider provenance, missing scores, team orientation, filter validation, cache coalescing, natural-language fixture search, notification ownership/read races, keyboard team selection and stale UI responses. Production build and icon validation pass.

Provider reference: [Team history](https://docs.football-data.org/general/v4/team.html), [match score fields](https://docs.football-data.org/general/v4/match.html).
