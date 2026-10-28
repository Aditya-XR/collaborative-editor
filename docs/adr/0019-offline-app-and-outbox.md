# 0019 · The offline app: app shell, outbox and idempotent replays

- **Status:** accepted
- **Date:** 2026-10-29

## Context

Since phase 2 an open document keeps a Yjs copy in IndexedDB: the text survives a lost
connection, and the CRDT merges it on reconnect. Everything around the text still needed the
server. Without a network the app did not load, the dashboard was empty, and creating a document,
renaming one or writing a comment failed.

Phase 9 makes the rest work offline, within limits the server sets:

- **Creates, renames, stars and comments** can be made offline: they only add or set something.
- **Sharing, roles, merges, trash and version history** stay online-only. They depend on what
  the server decides at that moment, such as who has access or what changed on main.

## Decision

**The app shell is cached by a service worker.** `vite-plugin-pwa` (Workbox, `generateSW`) builds
the service worker:

- **Precache:** every file the build emits, including the lazily loaded editor and Word export
  chunks (29 files, about 1.5 MB).
- **Navigation:** any page address answers with the cached `index.html`.
- **Never touched:** `/api` and the WebSocket. The worker never intercepts or caches them, so a
  stale API answer can never be served.
- **Updates:** a new version waits until the person clicks Reload in a banner
  (`registerType: 'prompt'`). Reloading under someone typing would lose nothing, but it would be
  rude.
- **Install:** the web manifest and icons make the app installable.

**Saved lists.** Document lists, document summaries and comment threads are saved to
localStorage as TanStack Query state (`lib/queryPersistence.ts`):

- **When:** at most once a second, under `collabedit:<user>:queries`.
- **Lifetime:** 30 days, with a version number so an old copy is ignored rather than misread.
- **Not saved:** search results, which are useless without the server.
- **On the page:** a list that fails to refresh stays on screen, and the page says it is offline.

**Opening offline signed in.** The access token lives only in memory (ADR 0011), and the refresh
cookie cannot be used without the API. So the profile of whoever signed in last is kept under
`collabedit:last-user`. It is a profile, never a credential.

- **Offline start:** if the boot-time refresh cannot reach the API, the app opens as that person,
  with their offline copies.
- **Requests:** none carry a token until a real refresh succeeds. `api()` tries one first.
- **Signing out** removes the profile, so the next visitor cannot open the app as them.

**Offline changes go into an outbox** (`lib/outbox.ts`): an IndexedDB store, one per user, of
requests kept in the order they were made.

- **When a change queues:** it is tried directly first. It is queued if the API cannot be reached,
  or if the document it touches is itself still waiting to be created.
- **What counts as unreachable:** `fetch` throws, or the hosting edge answers 502, 503 or 504 for
  a sleeping or restarting server. A refusal from the API itself (403, 404, 422) is shown at once
  instead.
- **When it sends:** on the browser's `online` event, whenever any request gets an answer again,
  and on a retry timer (2 s doubling to 60 s). While the API is unreachable, `/api/healthz` is
  asked every 20 s, since a server that comes back says nothing.
- **One sender:** a Web Lock makes tabs take turns, and a BroadcastChannel tells the others to
  reload the queue.
- **Order:** entries go oldest first, so a document's creation always precedes its renames and
  comments.
- **Superseded entries:** an entry with a `supersedes` key (`rename:<id>`, `star:<id>`) is
  skipped when a later one has the same key. Only the last title is sent.

**Every queued request is safe to repeat.** A reply can be lost on its way back, and two tabs can
race. So no request may create something twice.

| Change | Request | Why repeating it is harmless |
| --- | --- | --- |
| New document | `PUT /documents/{id}` with a UUIDv7 minted by the browser | The second PUT finds the document and returns it (200, not 201). An id owned by someone else is a 409, never a way into their document |
| Rename | `PATCH /documents/{id}` `{title}` | Sets a value |
| Star | `PUT` or `DELETE /documents/{id}/star` | Sets a value; stars are personal (`document_members.starred_at`) |
| Comment | `POST …/threads` with `client_id` | A repeated `client_id` from the same author returns the thread it created, and notifies nobody again |
| Reply | `POST …/threads/{id}/comments` with `client_id` | The same, per comment |

The plan named an `Idempotency-Key` header. A field in the body does the same job with a unique
column and no extra table of seen keys. Only creating requests need one, and each already has a
natural place for an id.

**A document created offline** exists only on this device until its PUT is sent.

- **Offline:** its summary is placed in the cached lists, and its editor opens on a local Yjs copy.
- **Back online:** the ticket request, the summary fetch and the comments fetch first send the
  pending creation (`whenOnServer`). If that cannot happen yet, they fail as if offline (a
  `TypeError`). Otherwise a ticket's "not found" would stop the editor and delete the only copy of
  the text.

**Comments written offline** are shown from the outbox, not added to the query cache:

- **Why:** a refetch, such as the server's "comments changed" signal, would otherwise drop them
  before they are sent.
- **On screen:** they are marked "Not sent yet". Nobody can reply to such a thread, because the
  server has not given it an id.
- **When sent:** the server's answer replaces the queued copy in the same moment it leaves the
  outbox, so the panel does not flicker.

**Refused later.** An entry the server refuses once it is reachable again cannot succeed by
retrying. Examples: access removed meanwhile, a document deleted, an invalid title. It is dropped,
and a banner lists it with the server's reason. A 401 keeps the queue for the next sign-in.

**Text edited offline reaches the server even if its editor is closed.** The Yjs copy holds the
edits, but only a connection sends them, and before this phase only an open editor connected. A
document edited offline and closed before reconnecting would keep its text on this device. Signing
out would then delete it.

- **Marking:** each stream (a document or a branch) with edits the server has not acknowledged is
  listed under `collabedit:<user>:unsynced`. The list survives a reload made offline.
- **On reconnect:** listed streams are synced first, by a connection with no editor, before pinned
  documents. Each is removed once the server has its edits.
- **Refused:** if the server refuses a listed stream (access removed, document deleted), its copy
  is deleted, as an open editor would do, and the banner says those edits could not be saved.
- **Counted:** the header badge and the sign-out warning count these documents along with the
  outbox.

**Kept available offline.** Opening a document gives it an offline copy. The "make available
offline" toggle also downloads pinned documents ahead of time and keeps them fresh while online:

- **Text:** a hidden, invisible connection syncs it into IndexedDB, then closes.
- **Around it:** the summary and comments go into the saved lists.
- **Loading:** this code brings Yjs with it, so it loads only once something is pinned. The
  dashboard's first load stays free of the editor's libraries.

**What the person sees:**

- **Header badge:** "Offline · 3 changes not synced · last online 2 minutes ago", or
  "Sending 3 changes…". It hides once everything is sent. Each document still shows its own text's
  state beside its title (phase 2).
- **Online-only actions:** Share, History, Branches, Delete and Restore are disabled, with the
  reason. Search says it needs a connection.
- **Signing out:** the menu warns when signing out would delete changes not yet sent.

**Signing out wipes the device.** It deletes every database under the `collabedit:` prefix (the
document copies and the outbox) and every localStorage key under it (saved lists, pins, the last
profile). A shared computer keeps nothing. The colour theme is kept under `collabedit-theme`,
outside that prefix: it says nothing about anyone.

## Alternatives considered

- **Background Sync API for the outbox:** Chromium only, and it would move the queue into the
  service worker, away from the session and its token. The page's own retry loop works everywhere
  and is testable with plain Vitest.
- **Caching API GETs in the service worker:** simpler, but it serves stale answers to whatever
  asks, permissions included. TanStack Query's saved state is explicit about what is kept and for
  whom.
- **Optimistic comments in the query cache:** wiped by the first refetch, as above.

## Consequences

- The first visit downloads about 1.5 MB, so the editor and export work offline later. Repeat
  visits download only what changed.
- A deploy reaches an open tab when the person clicks Reload, or on their next visit after every
  tab closed.
- Changes made offline can be refused once the server sees them. The banner says which ones and
  why; nothing is dropped silently.
- Tests: the outbox (order, supersede, retry, refusals, cross-visit), `sendOrQueue` and
  `whenOnServer`, saved queries, the offline session and the pending-comment merge are Vitest unit
  tests. The dashboard and comments tests create a document and write a comment with the API down,
  then check each is sent exactly once when it returns. A browser run covers the service worker,
  which jsdom has none of.
