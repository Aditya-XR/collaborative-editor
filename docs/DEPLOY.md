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
The free service sleeps after ~15 idle minutes, and the first request then waits ~30–60 s. The
`Keep API awake` workflow (`.github/workflows/keep-awake.yml`) pings `/api/healthz` every
5 minutes from 08:00 to 23:59 IST and lets the service sleep overnight (~500 of the 750 free
hours a month). Notes:

- Scheduled workflows run only from the default branch (`main`), and GitHub pauses them after
  60 days without commits; re-enable it from the Actions tab if that happens.
- GitHub can start scheduled runs late or skip one under load, so the service may still
  occasionally fall asleep. For a hard guarantee before an interview or demo, run the workflow by
  hand (**Actions → Keep API awake → Run workflow**) or open the app a minute early.
- To change the hours, edit the three `cron` lines; they are in UTC (IST − 5:30).

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
| Editors reconnect ~35 s after a deploy, not instantly | Expected: Render's edge does not forward the server's WebSocket close frame, so clients notice through the heartbeat (ADR 0012) |
| Startup fails: `REDIS_URL must start with redis://` | Pasted the whole `redis-cli -u …` command, or added quotes; paste only the `redis://…` URL |
