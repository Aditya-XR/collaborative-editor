# 0006 · One-time WebSocket tickets

- **Status:** accepted
- **Date:** 2026-09-28

## Context

Browsers cannot set an `Authorization` header on a WebSocket handshake, so the credential has to
travel in the URL or a cookie. URLs end up in proxy logs, server access logs and browser history.
v1 put its long-lived JWT there.

## Options

1. **Access token in the query string.** Simple; the token (valid 15 minutes, usable on every
   endpoint) leaks wherever URLs are logged.
2. **Cookie on the handshake.** Works same-origin, but production serves the page from Vercel and
   the socket from Render, and cookie-authenticated sockets invite cross-site WebSocket hijacking
   unless every handshake checks `Origin`.
3. **One-time ticket.** The client asks the REST API (with its bearer token) for a ticket bound to
   one document, then puts only the ticket in the URL.

## Decision

Option 3. `POST /api/collab/tickets {document_id}` checks access and stores
`collab:ticket:<random>` → user, name, document, role in Redis for 30 seconds. The WebSocket
handler redeems it with `GETDEL`, so it works exactly once, and closes with `4401` when it is
missing, spent, expired or issued for another document.

## Consequences

- A leaked URL is worthless after one use or 30 seconds, and only ever opened one document.
- Obtaining a ticket needs the bearer token, which a hostile site cannot read, so the socket needs
  no `Origin` check.
- The client must fetch a new ticket before every connection attempt, which is why the app uses
  its own provider instead of y-websocket's (that one reconnects with the same URL).
- The role in the ticket is at most 30 seconds old; losing access later is enforced by
  disconnecting the room (trash today, membership changes in phase 4).
