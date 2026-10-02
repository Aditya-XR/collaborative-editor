# CollabEdit

Real-time collaborative documents, in the spirit of Google Docs, with offline editing and
Git-style branches: fork a live document, work on it privately, and open a merge request.

> **Status:** v2 rebuild in progress — phase 4 built (sharing and roles); deployment next,
> see [docs/DEPLOY.md](docs/DEPLOY.md).
> See [docs/PLAN.md](docs/PLAN.md).
> The original MERN version is preserved under the `v1` tag.

## Stack

| Layer | Technology |
| --- | --- |
| Web | React 19, TypeScript, Vite, TanStack Query, React Router, Tailwind CSS |
| Editing | Tiptap (ProseMirror) + Yjs in the browser, pycrdt sync server over WebSockets |
| API | Python 3.13, FastAPI, SQLAlchemy 2 (async), Alembic |
| Data | PostgreSQL, Redis |
| Tooling | uv, ruff, mypy, pytest, oxlint, Prettier, Vitest, GitHub Actions, Docker Compose |

## Local development

Prerequisites: [Docker Desktop](https://www.docker.com/products/docker-desktop/),
Python 3.13 with [uv](https://docs.astral.sh/uv/), and Node.js 22+.

```bash
# 1. Postgres and Redis
docker compose -f infra/docker-compose.yml up -d

# 2. API on http://localhost:8000 (docs at /api/docs)
cd apps/api
cp .env.example .env
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --no-access-log

# 3. Web app on http://localhost:5173 (proxies /api to the API)
cd apps/web
npm install
npm run dev
```

Open http://localhost:5173, create an account, and create a document. Open it in a second
window to watch edits and cursors sync live; stop the API to try offline editing. The dashboard footer
shows the API's readiness: green when Postgres and Redis both answer.

## Checks

Run the same checks CI runs before pushing. API tests need the Docker services from step 1;
they build a separate `collabedit_test` database from the migrations and use Redis database 15.

```bash
# apps/api
uv run ruff check . && uv run ruff format --check . && uv run mypy app tests && uv run pytest

# apps/web
npm run lint && npm run typecheck && npm run format:check && npm test && npm run build
```

If CI's `npm ci` fails with `Missing: … from lock file`, the lockfile was written by an npm that
dropped an entry (npm 11.6 can omit transitive dependencies of optional packages). Rebuild it
with the npm CI uses: `npx npm@10 install --package-lock-only`.

## Benchmarks

How much compaction speeds up opening a document (ADR 0003 has the results):

```bash
# apps/api, with the Docker services running and migrations applied
uv run python -m benchmarks.load_document             # 10,000 keystrokes
uv run python -m benchmarks.load_document --edits 50000
```

## Layout

```text
apps/api/     FastAPI service (app/core, app/<domain>, alembic, tests)
apps/web/     React app (src/app, src/lib, src/features)
infra/        docker-compose.yml for local Postgres and Redis
docs/         PLAN.md and architecture decision records (docs/adr)
```
