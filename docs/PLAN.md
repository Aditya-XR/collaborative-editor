# CollabEdit v2 plan

The full plan (architecture, data model, protocol, rate limiter, services, diagrams) lives in the
"CollabEdit v2 Plan" doc. This file tracks progress against its phases.

**Goal:** a Google Docs–style editor built on FastAPI, Yjs/pycrdt, PostgreSQL and Redis, whose
signature feature is Git-style document branches with merge requests. A live MVP ships at the end
of week 6 (Gate 1) and the full v2 at the end of week 14 (Gate 2), on $0/month hosting.

## Phases

- [x] **0 · Setup and CI** (week 1)
  - [x] Monorepo layout: `apps/api`, `apps/web`, `infra`, `docs`
  - [x] FastAPI skeleton: settings, async Postgres engine, Redis client, JSON logs with request ids
  - [x] `/api/healthz` (liveness) and `/api/readyz` (dependency checks with timeouts)
  - [x] Alembic wired to app settings
  - [x] React + TypeScript + Vite skeleton with Tailwind, TanStack Query, React Router
  - [x] Docker Compose for Postgres and Redis; API Dockerfile
  - [x] GitHub Actions: lint, types, tests, build, real-service readiness, Docker image
  - [x] ADRs 0001–0003
  - [x] Verified locally in Docker: migrations, readiness 200, API image builds and runs
  - [x] First green CI run on GitHub ([run 36440356607](https://github.com/Aditya-XR/collaborative-editor/actions/runs/36440356607))
- [x] **1 · Accounts and rate limiter** (week 2)
  - [x] Register, login, refresh, logout, logout-all, `/me` (Argon2id, 15-minute JWT)
  - [x] Rotating refresh tokens in an httpOnly cookie, reuse detection, two-tab grace window
  - [x] Token-bucket rate limiter in Redis (Lua), fail open/closed per policy, local fallback
  - [x] Documents: create, idempotent `PUT` with client ids, list by scope, rename, trash, restore
  - [x] Roles enforced server-side; outsiders get 404, too-low roles get 403
  - [x] Web: sign-in, registration, silent session restore, dashboard, cross-tab sign-out
  - [x] 67 API tests on real Postgres and Redis; 35 web tests with MSW; checked in a real browser
- [x] **2 · Live editing, offline core** (weeks 3–4)
  - [x] Sync server on pycrdt: one room per open document, Yjs sync protocol, per-connection
        send queues, awareness relay that stamps the authenticated name on every cursor
  - [x] One-time 30-second WebSocket tickets (Redis `GETDEL`); close codes the client acts on
  - [x] Viewers and commenters can follow live but their edits are refused server-side
  - [x] Per-connection message budget, 10 connections per user, slow clients dropped
  - [x] Edits saved to an append-only log in Postgres, batched every 500 ms or 50 updates, and
        flushed on room eviction and on shutdown (pulled forward from phase 3; compaction stays
        in phase 3)
  - [x] Moving a document to trash disconnects everyone editing it
  - [x] Web: Tiptap editor, live cursors and presence avatars, per-user undo, own provider with
        fresh tickets per attempt and exponential backoff, IndexedDB offline copy, sync badge,
        offline copies wiped on sign-out and when access is lost
  - [x] 97 API tests (incl. a 150-case Hypothesis convergence property), 53 web tests; checked in
        a real browser with two accounts, including killing the API mid-edit
  - Found upstream: pycrdt/yrs 0.27 drops some out-of-order updates (Yjs does not); see ADR 0012
- [ ] **3 · Storage, versions, search** (week 5)
- [ ] **4 · Sharing and roles** (week 6) → **Gate 1: MVP live on the web**
  - [x] Members: list, invite by email with a role, change role, remove, leave, transfer ownership
  - [x] Share links: role, expiry, turn off; token shown once and stored hashed; accept never
        lowers access; token sent in the body so it stays out of logs
  - [x] Access changes close open editors instantly (4403 removed, 4409 reconnect with new role)
  - [x] Web: Share dialog, `/share/:token` page (sign-in first when needed), provider handles 4409
  - [x] Deploy prep: `render.yaml`, `vercel.json`, `docs/DEPLOY.md`; Neon URLs adapted for
        asyncpg; migrations at container start; production refuses a dev secret or insecure
        cookies; config errors never echo secrets
  - [x] 121 API tests, 64 web tests; production image rehearsed locally against a fresh database
  - [ ] Accounts on Neon, Redis Cloud, Render and Vercel, then deploy (see docs/DEPLOY.md)
  - [ ] Merge `v2` into `main` (the deploy branch) and run the smoke test
- [ ] **5 · Multi-instance Redis** (week 7)
- [ ] **6 · Comments** (week 8)
- [ ] **7 · Branches and merge requests** (weeks 9–10)
- [ ] **8 · Google sign-in and email** (week 11)
- [ ] **9 · Export, offline app, polish** (week 12)
- [ ] **10 · AI assistant** (week 13)
- [ ] **11 · Hardening and launch** (week 14) → **Gate 2: v2 release**

If a phase slips, cut in this order: AI, then export, then Google sign-in. Never branches or tests.

## Architecture decisions

| ADR | Decision |
| --- | --- |
| [0001](adr/0001-crdt-for-collaborative-editing.md) | Yjs CRDT for merging concurrent edits |
| [0002](adr/0002-postgresql.md) | PostgreSQL as the system of record |
| [0003](adr/0003-edit-log-and-snapshots.md) | Append-only edit log plus snapshots |
| [0005](adr/0005-token-bucket-rate-limiter.md) | Token bucket in a Redis Lua script, fail open or closed per policy |
| [0006](adr/0006-websocket-tickets.md) | One-time WebSocket tickets instead of tokens in URLs |
| [0011](adr/0011-sessions-and-refresh-rotation.md) | In-memory access tokens, rotating refresh cookie with reuse detection |
| [0012](adr/0012-sync-server-on-pycrdt.md) | Own sync server and client provider on pycrdt/Yjs, and the pycrdt pitfalls |
| [0013](adr/0013-sharing-model.md) | Membership-only access, hashed share links, instant revocation |
