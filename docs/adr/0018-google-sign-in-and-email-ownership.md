# 0018 · Google sign-in, password reset and verified email addresses

- **Status:** accepted
- **Date:** 2026-10-19

## Context

Phase 8 adds three things that all turn on one question: whether a person controls an email
address.

- **Sign in with Google**, so people need no new password.
- **Password reset** by emailed link.
- **Verified addresses**, so comment notifications (ADR 0017) go only to inboxes whose owners
  asked for them. Until now anyone could register with someone else's address and aim our email
  at it.

## Decision

**Google: OpenID Connect's authorization code flow with PKCE, done by the server.**

1. `GET /api/auth/google/start` creates a random `state`, `nonce` and PKCE verifier. They are kept
   in Redis for 10 minutes, the state is also set as an httpOnly cookie, and the browser is
   redirected to Google with `scope=openid email profile` (no app review needed).
2. Google sends the browser back to `GET /api/auth/google/callback?code&state`. The server checks
   the state against the cookie, takes the attempt out of Redis with `GETDEL`, and exchanges the
   code. The exchange sends the client secret and the PKCE verifier.
3. The ID token's signature is checked against Google's published keys, cached for an hour and
   fetched again for an unknown key id. So are its issuer, audience, expiry and nonce.
4. The callback starts a session (the usual refresh cookie) and redirects to the page the person
   was going to.

| Attack | What stops it |
| --- | --- |
| Login CSRF: the attacker's callback URL opened in the victim's browser | The state must match a cookie only the starting browser has |
| A callback URL captured and replayed | `GETDEL`: each attempt is good for one callback |
| A stolen authorization code | PKCE: the verifier never leaves the server |
| An ID token from another sign-in, or made for another app | Nonce, and audience = our client id |
| A forged ID token | RS256 signature against Google's keys |
| `next=//evil.example` | Only paths on this site are followed |

The redirect URI is `{FRONTEND_URL}/api/auth/google/callback`, on the web app's origin. Vercel
rewrites it to the API, so the session cookie set there is first-party, like every other auth
response's.

**Accounts are matched by Google's subject id, not by email.** An `oauth_accounts` row links
`(provider, subject)` to a user. A returning person is found by subject even if their Google
address changed.

**On first sign-in:**

- **No account with that address:** a new account, already verified, with no password.
- **An account with that address, verified:** Google is linked to it.
- **An account with that address, never verified:** someone registered it with a password and
  never proved it was theirs. That password may be an attacker's, waiting for the real owner to
  move in (account pre-hijacking). So it is removed and that account's sessions end, before
  Google is linked.
- **Google says the address is not verified:** refused. Matching or creating accounts by an
  unproven address would let anyone claim it.

**Emailed links.** One table, `account_tokens`, holds both kinds:

- **Storage:** only the SHA-256 of a 256-bit random token is stored, with an expiry and a used
  time.
- **Single use:** issuing a new token retires older unused ones for the same purpose, so only the
  latest email's link works.
- **Out of logs:** links carry the token after `#`, which browsers never send to a server, so it
  stays out of access logs and Referer headers. The page reads it and posts it.

**Password reset:**

- **No account enumeration:** `POST /api/auth/password/forgot` answers the same whether or not an
  account uses the address.
- **Limits:** 3 requests per address and 5 per IP per hour, failing closed, since each sends
  email.
- **Short life:** a link works once, for 30 minutes.
- **Effect:** resetting sets the password, marks the address verified (the link reached it), and
  ends every session.
- **No password yet:** an account without a password (Google only) can add one this way.

**Verification:**

- **Sending:** registering sends a link that works for 48 hours. `POST /api/auth/email/resend`
  sends a new one, 3 times an hour.
- **Confirming:** `POST /api/auth/email/verify` needs no session, because the link often opens in
  another browser. A repeated click still succeeds.
- **Consequences:** comment notifications now go only to verified addresses. Unverified people
  see a banner with a resend button.

**Email without SMTP.** If no SMTP server is set, emails are logged instead of sent. Outside
production the log includes the text, so a developer can follow its links. In production it never
does, because a reset link works like a password.

## Consequences

- Google sign-in needs a Google Cloud OAuth client (`docs/DEPLOY.md`, step 9). Without one, the
  button is hidden and `/auth/google/*` answers 404.
- Without SMTP in production, verification and reset links go nowhere: people stay unverified (no
  comment emails) and cannot reset a password. Gmail SMTP is free (`docs/DEPLOY.md`, step 7).
- Accounts created before this phase start unverified. Their owners verify from the banner.
- Google is tested against a fake provider with a real RSA key and a token endpoint that enforces
  PKCE, the secret and the redirect URI, both in pytest and in a browser run. The real Google is
  exercised only once credentials exist.
