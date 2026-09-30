# 0013 · Sharing: members, links, and instant revocation

- **Status:** accepted
- **Date:** 2026-09-29

## Context

Documents are private by default (v1 made every document editable by every user). People need
to invite collaborators, share a link, change or remove access, and hand a document over, and a
removal must take effect in editors that are already open.

## Decision

- **Membership is the only source of access.** `document_members(document_id, user_id, role)`;
  no row means no access, and the API answers 404 rather than 403 so existence is not leaked.
- **Who can do what.** Any member sees who has access. Owners and editors invite by email and
  create links. Only the owner changes roles, removes others and transfers ownership. Anyone
  but the owner can leave. The owner's role changes only through a transfer, after which the
  previous owner stays on as an editor.
- **Invites need an existing account.** Unknown emails get `404 user_not_found` with a pointer to
  links; email invitations arrive with email delivery in phase 8. Revealing that an email has an
  account is accepted here, as in most sharing UIs, and invites are rate-limited per user.
- **Links.** A random 192-bit token, shown once; only its SHA-256 is stored. Each link has a role
  and an expiry (1, 7 or 30 days, or never) and can be turned off. Accepting a link never lowers
  access: an editor who opens a view link stays an editor. The token is sent in the request body,
  so it never appears in request logs.
- **Instant enforcement.** After a change, the API tells the room manager to close that user's
  sockets on that document: `4403` for removal (the client stops and deletes its offline copy)
  and `4409` for a role change (the client reconnects at once and its fresh ticket carries the new
  role).

## Consequences

- Revocation is immediate for open editors on this instance. With several instances (phase 5)
  the same disconnect request travels over Redis pub/sub.
- A viewer holding offline edits made before a demotion has them ignored on reconnect, which is
  the intended outcome for access that was withdrawn.
