# 0011 · Sessions: in-memory access tokens, rotating refresh cookie

- **Status:** accepted
- **Date:** 2026-09-28

## Context

The web app needs sessions that survive reloads, can be revoked, and are hard to steal. v1 kept a
long-lived JWT where page scripts could read it and put it in WebSocket URLs.

## Decision

- **Access token:** a 15-minute HS256 JWT (`sub`, `typ=access`, `iat`, `exp`), held only in memory
  by the web app, never in `localStorage` where injected script could read it. Expiry returns
  `401 token_expired`; the client refreshes once and retries.
- **Refresh token:** 32 random bytes in an `HttpOnly`, `SameSite=Lax` cookie scoped to
  `Path=/api/auth`, so it is never sent to the rest of the API. The server stores only its
  SHA-256; a fast hash suffices because the token is random, unlike a password.
- **Rotation:** every refresh issues a new token and revokes the old one, linking them through
  `replaced_by_id`. Tokens from one login share a `family_id`.
- **Reuse detection:** a rotated token presented again means it was copied, so the whole family is
  revoked and every device in that session must sign in again.
- **Two tabs:** the browser takes a Web Lock around refresh so tabs take turns, and the server
  treats reuse within 10 seconds of rotation as a race (`401 refresh_race`, retried once), not theft.
- **Row lock:** refresh reads the token `FOR UPDATE`, so concurrent refreshes serialise.
- **Logout** revokes the family; **logout-all** revokes every family for the user. Signing out
  in one tab signs out the others through a `BroadcastChannel`.
- **Passwords:** Argon2id, hashed in a worker thread to keep the event loop free, with automatic
  re-hashing when parameters change. Unknown emails are verified against a dummy hash, so timing
  does not reveal which emails exist.
- **CSRF:** `SameSite=Lax` plus an `Origin` check on the cookie-authenticated endpoints.

## Consequences

- A stolen access token works for at most 15 minutes; a stolen refresh token is detected on its
  first reuse after the real user refreshes.
- Revocation is immediate for refresh tokens but not for access tokens (up to 15 minutes), the
  usual trade-off for stateless access tokens.
- Expired and revoked rows accumulate; a cleanup job arrives with phase 11 hardening.
