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
  - [ ] First green CI run on GitHub
- [x] **1 · Accounts and rate limiter** (week 2)
  - [x] Register, login, refresh, logout, logout-all, `/me` (Argon2id, 15-minute JWT)
  - [x] Rotating refresh tokens in an httpOnly cookie, reuse detection, two-tab grace window
  - [x] Token-bucket rate limiter in Redis (Lua), fail open/closed per policy, local fallback
  - [x] Documents: create, idempotent `PUT` with client ids, list by scope, rename, trash, restore
  - [x] Roles enforced server-side; outsiders get 404, too-low roles get 403
  - [x] Web: sign-in, registration, silent session restore, dashboard, cross-tab sign-out
  - [x] 67 API tests on real Postgres and Redis; 35 web tests with MSW; checked in a real browser
- [ ] **2 · Live editing, offline core** (weeks 3–4)
- [ ] **3 · Storage, versions, search** (week 5)
- [ ] **4 · Sharing and roles** (week 6) → **Gate 1: MVP live on the web**
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
| [0011](adr/0011-sessions-and-refresh-rotation.md) | In-memory access tokens, rotating refresh cookie with reuse detection |
