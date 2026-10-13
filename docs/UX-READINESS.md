# Usability changes and launch follow-up

## Shipped experience

- Landing/dashboard play actions open game setup before any entry is held.
- Setup discloses demo entry, combined pool fee, total prize, practice entry, cancellation and leaving fee. Existing game instructions are expanded.
- Human opponents must explicitly choose readiness; matchmaking does not silently replace them with a bot. Waiting shows the server's actual deadline.
- Mobile navigation includes Challenges. Match filters wrap and football team names can wrap on narrow cards.
- Help explains the first match, football, refunds, practice, connection interruptions and account saving.
- Player search in both skill and football challenges guards against out-of-order responses, distinguishes failures from empty results and offers retry. Game selection and shared invitations offer recovery after loading failures.
- HTTP requests have bounded waiting and timeout guidance warns players to check activity before retrying a committed action.
- Live connections start with polling and try the alternate transport when needed, following [Socket.IO client guidance](https://socket.io/docs/v4/client-options). Reconnection notices show elapsed time rather than implying a local countdown is a server match deadline, and avoid guaranteeing a match cannot be lost during an outage.
- Football section links stay on the current fixture. Confirmation sheets contain keyboard focus, restore it when closed and support Escape.
- Admin search/settings/notification fields have clearer accessible labels; user and match destinations expose keyboard controls. Profile, notification and ranking selections expose state.
- Admin settings use shrinking form columns and single-column phone limits; numeric inputs no longer force horizontal page overflow.
- Production hides the shared demo-account shortcuts unless explicitly enabled with `SHOW_DEMO_ACCOUNTS=true`.

## Football research, discovery and notifications

Public team comparison, searchable fixture filters, goals/scoring samples and recent form are now available, with compact summaries and optional coverage details. Fixture history loads on demand. Featured games rotate two enabled live games alongside permanent Chess, with swipe and keyboard controls. The notification bell and inbox now share reliable read states, search, categories and recovery. See [Football research and discovery](FOOTBALL-RESEARCH.md) for behavior, data limits and validation.

## Account recovery configuration

`/forgot-password` and `/reset-password` use a 30-minute random, single-use token. The database stores its SHA-256 hash, not the emailed token. Tokens are invalidated on use and password change; recovery revokes old sessions and creates an audit event. Requests are rate limited, have an account cooldown and return the same public response for an existing/unknown email. Access logs omit query strings, and pages use a no-referrer policy.

Set these on the cPanel application before enabling delivery:

```text
PUBLIC_BASE_URL=https://h2h.khumo.co.bw
SUPPORT_EMAIL=<the support mailbox you want published>
SMTP_HOST=<your email provider host>
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<mailbox or provider username>
SMTP_PASSWORD=<secret kept only on the server>
SMTP_FROM=<verified sender address>
```

For implicit TLS on port 465 use `SMTP_SECURE=true`. Keep secrets out of Git. Use a provider-authorized sender, restart, then perform one real delivery test to an account you own. Until SMTP is configured, the UI explicitly says recovery is unavailable rather than claiming an email was sent. Saved guest accounts without a registered email require administrator help; this pass does not add an email-verification/account-email-change flow.

## Shipped feature: chess across days

The first Play anytime feature is now correspondence chess. Players do not need to be online together, and each confirmed move is saved. As requested, this mode has a deadline for each turn to prevent abandoned games holding demo entries. The default is 24 hours per move; the full rules and configuration are in [Chess](CHESS.md).

| Location | Player experience |
| --- | --- |
| Public landing, Play and Games | Original chess artwork, clear discovery and a direct route to chess setup. |
| Chess (`/chess`) | Review entry, fee, prize and per-move deadline before sending an invitation. No funds are held yet. |
| Invitation and board (`/chess/:code`) | Review and accept, then choose legal moves, confirm, save, return and see the server deadline. Shared links preserve their destination through sign-in and registration. |
| Challenges and home activity | Your turn, waiting for opponent, invitations and completed games, with deadlines and continuation links. |
| My matches, wallet and admin | Accepted chess games use the existing ledger, result history, statistics and administrative cancellation/refund flow. |

Acceptance holds both demo entries together. Each move starts the next player's full turn window. Missing the deadline, resigning or checkmate awards the winner the pool less the frozen normal platform fee. Agreed and automatic draws refund both entries with zero fee. An active game cannot be cancelled unilaterally to avoid losing. Pending invitations can be withdrawn or declined without a fee. Existing live skill and football rules remain separate.

The browser offers labelled squares, keyboard navigation, a legal-move list, promotion choices, move confirmations and read-only admin boards. Saved server history and transactional version checks protect resumption and duplicate requests. In-app turn notifications and optional push use existing preferences; reminders never replace the player's responsibility to meet the displayed deadline.

Next: observe real players inviting friends, learning the board and returning for turns. Measure invites accepted, first turns completed, games finished and repeat opponents. Add abuse/cheating controls before broad promotion. Audience growth remains a hypothesis to validate.

## Recommended growth feature: weekly friends leagues

Create a private league with a persistent invite link; let friends compete on a weekly skill challenge at different times. Reuse server-side scoring, show a weekly leaderboard, offer opt-in reminders and let players share a result card. Start with demo/free participation and no referral cash incentives. Keep the normal live 1v1 experience alongside it. A weekly leaderboard has a defined reporting period. League scheduling must not shorten the saved per-move deadline of an active chess game.

Why this fits: the app already has games, server scoring, player identities, rivalry records and WhatsApp invitations. A league makes those invitations useful beyond a short-lived match seat, and asynchronous participation avoids requiring everyone to be online together. This is a product hypothesis, not a guarantee of audience growth.

Comparable patterns: [Strava group challenges](https://support.strava.com/en-us/articles/15401736-how-do-group-challenges-work-on-strava) and [clubs/community](https://support.strava.com/en-us/collections/19657598-clubs-challenges-and-community) demonstrate private invitations, shared progress and leaderboards. Their success does not establish demand for Head2Head; test that with real users.

Measure invite-to-join conversion, join-to-first-completed-challenge conversion, participating friends per league, 7-day return rate and weekly repeat participation. Start with a small invited community and user interviews before expanding.

## Coverage and remaining work

Source review covered routing/guards, account creation/saving/login/profile/recovery, dashboard, game catalogue/setup, matchmaking/lobby/play/results, challenge creation/list, football fixtures/teams/match centre, invitations/sharing, wallet/forms/history, rankings, notifications/push, all admin screens, API handlers/configuration and CI/CD. Source review is not full interactive or assistive-technology coverage of every path.

Remaining launch work:

1. Configure SMTP and publish the real support mailbox; verify delivery/spam behavior. Add verified email attachment for saved guest accounts.
2. Conduct observed sessions with new people using their own accounts. No agent review can establish that real users understand or enjoy the app.
3. Complete keyboard/screen-reader coverage of the game arenas, particularly pointer-heavy Aim Challenge and dynamic timed targets. Gameplay/scoring rules were not changed in this pass.
4. Review live football provider freshness and unsupported statistics; avoid promoting unreliable fixture data.
5. Add player blocking/reporting and support moderation before broadly promoting social invitations.
6. Validate correspondence chess with real participants, add abuse/cheating controls and product measurement, then test persistent leagues. Leagues are not implemented. Nothing here claims that real-money functionality is ready.

Security reference: [OWASP password recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
