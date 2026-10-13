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

## Recommended growth feature: weekly friends leagues

Create a private league with a persistent invite link; let friends compete on a weekly skill challenge at different times. Reuse server-side scoring, show a weekly leaderboard, offer opt-in reminders and let players share a result card. Start with demo/free participation and no referral cash incentives. Keep the normal live 1v1 experience alongside it.

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
6. Add product event measurement and persistent leagues only after the core journey is validated. Nothing here claims that real-money functionality is ready.

Security reference: [OWASP password recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
