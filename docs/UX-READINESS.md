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

## Account recovery

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

## Planned feature: Play anytime

Add asynchronous friend challenges that players can join and resume without an invitation deadline or turn countdown. The working interpretation of "non time bound" is an untimed, turn-based game: neither participant needs to be online together, and taking longer does not reduce their score. The first game's rules still need choosing. This is a roadmap item; no asynchronous game engine has shipped in this pass.

Recommended placement in the existing app:

| Location | Player experience |
| --- | --- |
| Play (`/dashboard`) | A visible **Play anytime** card, described as "Take turns whenever you're ready", alongside the existing game discovery. Returning players see **Your turn** and a **Continue game** action. |
| Games (`/games`) and game setup (`/games/:slug`) | Clearly distinguish **Play live** and **Play anytime**. Offer the anytime option only for games designed for saved turns. Explain the rules before creating a challenge. |
| Challenges (`/challenges`) | The permanent home for anytime invitations and games. Separate **Your turn**, **Waiting for friend**, **Invitations** and **Completed**; show opponent and last activity. Reuse the existing mobile Challenges destination. |
| My matches (`/matches`) | Include anytime games in the player's history, identify the mode, and link active games to their saved turn. Avoid duplicate or conflicting status labels across screens. |
| Invitation links and notifications | Persistent links open the exact challenge, preserve the destination through login/account creation, and allow acceptance later. Show an in-app turn indicator; offer optional reminders with frequency controls. |

Start with a free, non-wallet turn-based word or puzzle duel. Choose the game after a small user trial. Existing timed skill scoring and football deadlines stay intact; a dedicated asynchronous lifecycle must save each committed move on the server, validate whose turn it is, reject duplicate moves, and resume correctly after a reload or on another device. A player must be able to leave after a saved turn without forfeiting.

Invitations can be declined or withdrawn, and players can agree to end a game. Old games may be voluntarily archived with clear behavior; do not silently turn inactivity into a loss. Authentication links and sessions can retain their security expiry independently of the game's lifetime. Paid entries require explicit cancellation, inactivity, settlement and refund rules before they can be considered: indefinite challenges must not indefinitely lock wallet balances.

Test discovery, invite acceptance, save-and-resume, cross-device continuation, duplicate submission, withdrawal and reminders with real participants. Measure invites accepted, first turns completed, games finished, time to return for a turn and repeat opponents. Treat audience growth as a hypothesis to validate.

## Recommended growth feature: weekly friends leagues

Create a private league with a persistent invite link; let friends compete on a weekly skill challenge at different times. Reuse server-side scoring, show a weekly leaderboard, offer opt-in reminders and let players share a result card. Start with demo/free participation and no referral cash incentives. Keep the normal live 1v1 experience alongside it. A weekly leaderboard has a defined reporting period; the separate Play anytime mode above has no participation or turn deadline. League scheduling must not impose a deadline on an existing anytime game.

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
6. Validate and build free Play anytime friend challenges, then test persistent leagues and product event measurement. Neither feature is implemented by this UX pass. Nothing here claims that real-money functionality is ready.

Security reference: [OWASP password recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
