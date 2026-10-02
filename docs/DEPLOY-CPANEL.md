# Deploying Head2Head to cPanel (step by step)

One Node.js app serves the API and the Angular site on a single domain.
GitHub Actions tests, builds and deploys it over SSH on every push to `main`.

Replace `USER` with your cPanel username and `yourdomain.com` with your domain throughout.

---

## Part 1: cPanel (do once)

### 1. Create the database
1. cPanel → **MySQL® Databases**.
2. **Create New Database**: name it `head2head`. cPanel prefixes it, so the real name is `USER_head2head`.
3. **Add New User**: username `h2h` (real name `USER_h2h`) and a strong password. **Save this password.**
4. **Add User To Database**: pick that user and that database → tick **ALL PRIVILEGES** → Make Changes.

Write down the three values you need later: database `USER_head2head`, user `USER_h2h`, the password.

> The app needs MySQL 8. In **MySQL® Databases** or **phpMyAdmin** the server version is shown; if it says MariaDB, tell me, as a few things may need adjusting.

### 2. Create the Node.js app
1. cPanel → **Setup Node.js App** → **Create Application**.
2. Node.js version: **20** or newer. Mode: **Production**.
3. Application root: `head2head` (this becomes `/home/USER/head2head`).
4. Application URL: your domain or subdomain.
5. Application startup file: `passenger.js`.
6. **Create.**
7. Copy the line it shows: *"Enter to the virtual environment"* → `source /home/USER/nodevenv/head2head/20/bin/activate`. You need the path after `source` in Part 3.

### 3. Set the environment variables
On the same Node.js App screen → **Environment variables** → **Add Variable** for each row below → **Save**.

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_NAME` | `Head2Head` |
| `JWT_SECRET` | a long random string (e.g. 64 characters from a password generator). Never reuse your local one |
| `CORS_ORIGINS` | `https://yourdomain.com` |
| `DB_HOST` | `localhost` |
| `DB_PORT` | `3306` |
| `DB_USER` | `USER_h2h` |
| `DB_PASSWORD` | the password from step 1 |
| `DB_NAME` | `USER_head2head` |
| `AUTO_MIGRATE` | `true` (creates/updates tables on every start) |
| `FOOTBALL_PROVIDER` | `football-data` |
| `FOOTBALL_API_KEY` | **your football-data.org key** (the same one in your local `backend/.env`) |
| `FOOTBALL_API_BASE_URL` | `https://api.football-data.org/v4` |
| `FOOTBALL_SYNC_INTERVAL_SECONDS` | `60` (free plan allows ~10 calls/min; one sync costs 7) |
| `FOOTBALL_FIXTURE_WINDOW_DAYS` | `21` |
| `DEMO_BOTS_ENABLED` | `true` |

Anything else in `backend/.env.example` (timers, fees, currency) has a sensible default; add it here only if you want a different value.

> The key lives only in cPanel's environment variables. It is deliberately **not** in the repo or in GitHub, so it is never uploaded by the pipeline. If you leave it out, football runs on the simulated provider or fails to fetch fixtures.

### 4. Enable SSH and create a deploy key
1. cPanel → **SSH Access** → **Manage SSH Keys** → **Generate a New Key**.
   - Key name: `github-deploy`. **Leave the passphrase empty.** Generate.
2. Back in Manage SSH Keys → find `github-deploy` → **Manage** → **Authorize**.
3. For the **private** key → **View/Download** → copy the whole text, including the `BEGIN` and `END` lines.

If there is no **SSH Access** icon, ask your host to enable shell access, or tell me and we use FTP instead.

---

## Part 2: GitHub (do once)

Repo → **Settings → Secrets and variables → Actions**.

**Secrets** tab → *New repository secret*:

| Name | Value |
|---|---|
| `CPANEL_SSH_HOST` | your server hostname or IP (shown in cPanel's right-hand sidebar, "Server Information") |
| `CPANEL_SSH_USER` | your cPanel username (`USER`) |
| `CPANEL_SSH_KEY` | the private key text from Part 1 step 4 |
| `CPANEL_SSH_PORT` | only if your host doesn't use 22 |

**Variables** tab → *New repository variable*:

| Name | Value |
|---|---|
| `CPANEL_APP_DIR` | `/home/USER/head2head` (absolute, no trailing slash) |
| `CPANEL_NODE_ACTIVATE` | `/home/USER/nodevenv/head2head/20/bin/activate` (from Part 1 step 2) |
| `CPANEL_SITE_URL` | `https://yourdomain.com` (the deploy fails if `/api/health` doesn't respond) |

You do **not** put the database details or football key in GitHub. Those stay in cPanel.

---

## Part 3: First deploy

1. Push to `main` (or Actions → **Deploy to cPanel** → **Run workflow**).
2. The pipeline runs the tests, builds the site, uploads it, runs `npm ci`, restarts the app and checks `/api/health`.
3. Open `https://yourdomain.com`. Tables are created automatically on startup.
4. Optional demo data: cPanel → **Terminal**:
   ```bash
   source /home/USER/nodevenv/head2head/20/bin/activate
   cd ~/head2head
   npm run seed
   ```
   (The seed needs the DB values; the Node.js App screen's variables aren't loaded in Terminal, so run
   `export DB_HOST=localhost DB_USER=USER_h2h DB_PASSWORD='...' DB_NAME=USER_head2head` first.)

From now on, every push to `main` redeploys automatically. Nothing to upload by hand.

---

## How it works
- `ci.yml`: backend tests (MySQL 8 service) + frontend tests/build on PRs and non-main pushes.
- `deploy.yml`: on `main`, runs CI, builds the frontend, rsyncs `src/`, `migrations/`, `scripts/`,
  `package*.json`, `passenger.js` and the site (as `public/`), runs `npm ci --omit=dev`, touches
  `tmp/restart.txt`, then health-checks. `node_modules` and cPanel's own files are never overwritten.
- Without `CPANEL_SSH_KEY` the workflow falls back to FTPS (secrets `CPANEL_FTP_HOST`/`USER`/`PASSWORD`,
  variable `CPANEL_APP_DIR` relative to the FTP home); FTP can't run `npm install`, so click **Run NPM Install** in cPanel when dependencies change.

## Troubleshooting
- **Site shows an error / won't start**: Setup Node.js App → open the app → check `stderr.log` in `~/head2head`. The usual cause is a wrong `DB_*` value.
- **Realtime**: Passenger may not upgrade WebSockets; the client falls back to long-polling automatically.
- **Timers and football sync stop when idle**: Passenger can sleep an app with no traffic. Add a free uptime monitor (e.g. UptimeRobot) pinging `https://yourdomain.com/api/health` every 5 minutes.
- **Football data empty**: confirm `FOOTBALL_API_KEY` is set in cPanel and the sync interval is 60 or more.
