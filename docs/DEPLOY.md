# Deploying CollabEdit ($0/month)

| Piece | Host | Free tier notes |
| --- | --- | --- |
| Web app | Vercel (Hobby) | Serves the React build; rewrites `/api/*` to Render |
| API | Render (free web service) | Docker; sleeps after ~15 idle minutes, ~30–60 s to wake |
| Postgres | Neon (free) | 0.5 GB |
| Redis | Redis Cloud (free, 30 MB) | No per-command billing, unlike Upstash |

Pick one region for all three data-path services (the Blueprint uses Singapore). Deploys come
from the `main` branch.

## Why the traffic is split this way

- **REST goes through Vercel** (`/api/*` rewrite), so the browser sees one site: the refresh cookie
  is first-party (`SameSite=Lax`) and needs no CORS.
- **The WebSocket goes straight to Render** (`VITE_WS_URL`), because Vercel rewrites cannot carry
  WebSockets. The socket authenticates with a one-time ticket, not a cookie (ADR 0006).

## Steps

### 1. Postgres on Neon
1. Create a project at <https://neon.tech> in **AWS Asia Pacific (Singapore)**.
2. Copy the connection string for the **direct** endpoint (host without `-pooler`). The pooled
   endpoint runs PgBouncer in transaction mode, which breaks asyncpg's prepared statements.
3. Paste it as-is later; the API converts `postgresql://…?sslmode=require&channel_binding=…` into
   the form asyncpg needs.

### 2. Redis on Redis Cloud
1. Create a free database at <https://redis.io/cloud> in **AWS ap-southeast-1**.
2. Build `REDIS_URL=redis://default:<password>@<public endpoint host>:<port>`.

### 3. API on Render
1. Dashboard → **New → Blueprint** → select this repository. Render reads `render.yaml`.
2. Enter `DATABASE_URL` and `REDIS_URL`. For `FRONTEND_URL`, enter a placeholder for now
   (`https://example.com`); it is fixed in step 5. `JWT_SECRET` is generated for you.
3. Deploy. The container runs migrations, then starts. Check
   `https://<service>.onrender.com/api/readyz` shows database and redis `ok`.
4. If the service URL is not `collabedit-api.onrender.com`, update the rewrite destination in
   `apps/web/vercel.json` to match and push.

### 4. Web app on Vercel
1. <https://vercel.com> → **Add New → Project** → import this repository.
2. **Root Directory:** `apps/web`. Framework preset: **Vite** (build `npm run build`, output `dist`).
3. Environment variable: `VITE_WS_URL=wss://<service>.onrender.com`.
4. Deploy and note the URL, e.g. `https://collabedit.vercel.app`.

### 5. Connect them
1. On Render, set `FRONTEND_URL` to the exact Vercel URL (no trailing slash) and redeploy. It is
   used for CORS and for the `Origin` check on the cookie endpoints; a mismatch makes the silent
   refresh fail with `untrusted_origin` after every reload.

### 6. Keep the API awake during the day
The free service sleeps after ~15 idle minutes, and the first request then waits ~30–60 s. Keep it
awake from 08:00 to 23:59 IST with a ping to `/api/healthz` every 5 minutes, and let it sleep
overnight (~500 of the 750 free hours a month).

**Use an external cron service** such as [cron-job.org](https://cron-job.org) (free):

1. Create a cron job for `https://collabedit-api.onrender.com/api/healthz`.
2. Schedule: every 5 minutes, hours 8–23 only, time zone Asia/Kolkata.
3. Turn on failure notifications if you want an email when the API is down.

**GitHub Actions is only a fallback.** `.github/workflows/keep-awake.yml` runs the same schedule,
but GitHub delays and drops frequent scheduled runs: on 2026-10-02 it fired twice between
08:00 and 14:30 IST instead of ~75 times, so the API slept most of the morning. It is still useful
to wake the API by hand before a demo (**Actions → Keep API awake → Run workflow**).
GitHub also pauses scheduled workflows after 60 days without commits.

### 7. Email (recommended)
Sign-up verification links, password resets and comment notifications are emailed. Without SMTP
the API only logs that it would have sent them: nobody can verify an address or reset a password.
To send through Gmail for free (up to ~500 a day):

1. Turn on 2-Step Verification for the Google account, then create an **app password**
   (Google Account → Security → App passwords).
2. On Render, set `SMTP_HOST=smtp.gmail.com`, `SMTP_USERNAME=<the Gmail address>` and
   `SMTP_PASSWORD=<the app password>`. The port defaults to 465 (TLS); `MAIL_FROM` defaults to the
   username.
3. Register a new account: the verification email arrives within a minute (check spam the
   first time).

### 8. More than one instance (optional, paid plans)
The API runs as any number of instances: they share live documents through Redis pub/sub
(ADR 0004), and migrations take turns on a Postgres lock. Things to know before scaling:

- **Redis connections:** each instance uses a small pool plus one subscriber connection. Redis
  Cloud's free plan allows 30 connections.
- **No sticky sessions needed:** any instance can redeem any WebSocket ticket.
- **Readiness:** `/api/readyz` reports `pubsub`. An instance whose subscriber is down still
  serves its own clients, and catches up when it reconnects.

`docker compose --profile full` runs two instances behind nginx locally (README).

### 9. Sign in with Google (optional)
Without it the Google button is hidden. With it (ADR 0018):

1. <https://console.cloud.google.com> → project picker (top left) → **New project**, name it
   `CollabEdit` → **Create**, and select it.
2. Search bar: **OAuth consent screen** → **Get started**.
   - **App information:** app name `CollabEdit`, user support email: your address.
   - **Audience:** **External**.
   - **Contact information:** your address. Agree to the policy → **Create**.
3. **Data access** → **Add or remove scopes** → tick `openid`, `.../auth/userinfo.email` and
   `.../auth/userinfo.profile` → **Update** → **Save**. These are non-sensitive: no review.
4. **Branding** (Google requires these before publishing):
   - **Application home page:** `https://collaborative-editor-flax.vercel.app`
   - **Application privacy policy link:** `https://collaborative-editor-flax.vercel.app/privacy`
   - **Authorized domains** → **Add domain** → `collaborative-editor-flax.vercel.app` → **Save**.
5. **Audience** → under *Publishing status*, **Publish app** → **Confirm**, so any Google account can
   sign in. (Left in *Testing*, only the accounts listed under *Test users* can.)
6. **Clients** → **Create client**:
   - **Application type:** Web application. **Name:** `CollabEdit web`.
   - **Authorized redirect URIs**, both exactly:
     `https://collaborative-editor-flax.vercel.app/api/auth/google/callback` and
     `http://localhost:5173/api/auth/google/callback`.
   - **Create**. The dialog shows the client ID and the **client secret, which Google never shows
     again**: copy both, or **Download JSON**, now.
7. Render → the API service → **Environment** → add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
   → **Save changes** (it redeploys).
8. Check: <https://collabedit-api.onrender.com/api/auth/options> answers `{"google":true}`, and the
   sign-in page shows **Continue with Google**.

The redirect URI is always `FRONTEND_URL` + `/api/auth/google/callback`. If the Vercel address
changes, add the new one in step 6 and update step 4. For local testing, put the same two variables in
`apps/api/.env`.

## Smoke test after deploying

1. `/api/readyz` → `{"status":"ok"}` with both checks `ok`.
2. Register, reload the page: still signed in (refresh cookie works through the rewrite).
3. Create a document, type, reload: text is still there (Postgres).
4. Share → create a link → open it in a private window as a second account: both cursors show
   and edits appear live (WebSocket to Render).
5. Remove that account in the Share dialog: its editor closes with "access removed".

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Signed out after every reload | `FRONTEND_URL` on Render does not exactly match the Vercel URL |
| Editor stuck on "Syncing…" | `VITE_WS_URL` missing or wrong (must be `wss://…onrender.com`), or the API is waking |
| `readyz` shows database `error` | Pooled Neon URL used, or wrong password |
| Rate-limit 503 on login | Redis unreachable; login fails closed by design |
| No **Continue with Google** button | `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` missing on Render (`/api/auth/options` says `"google":false`) |
| Google: "invalid_client: The OAuth client was not found" | `GOOGLE_CLIENT_ID` is cut short: it starts with the project number and a dash (`123…-abc….apps.googleusercontent.com`). Copy it with the copy button, not by double-clicking |
| Google: "redirect_uri_mismatch" | The client's redirect URI is not exactly `FRONTEND_URL` + `/api/auth/google/callback` |
| **Publish app** greyed out on Google's Audience page | Home page and privacy policy links missing on the Branding page (step 9.4) |
| No verification or reset email | SMTP variables missing or misnamed (`SMTP_USERNAME`, not `SMTP_USER`), or a normal password used instead of a Gmail app password |
| Editors reconnect ~35 s after a deploy, not instantly | Expected: Render's edge does not forward the server's WebSocket close frame, so clients notice through the heartbeat (ADR 0012) |
| Startup fails: `REDIS_URL must start with redis://` | Pasted the whole `redis-cli -u …` command, or added quotes; paste only the `redis://…` URL |
