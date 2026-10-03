# 0017 · Comments anchored with Yjs relative positions

- **Status:** accepted
- **Date:** 2026-10-03

## Context

People discuss a document by commenting on passages of it. A comment has to stay on its words
while everyone keeps editing: text typed before the passage, inside it, by someone offline, or
arriving out of order. Two more facts shape the design:

- **Commenters cannot edit the text.** The sync server refuses their updates (ADR 0012). So a
  comment cannot be stored as a mark inside the document, the way many editors do it.
- **A comment is not part of the text's history.** Restoring a version, or merging a branch,
  should not create, delete or move discussions.

## Decision

**Anchors are Yjs relative positions, stored beside the document, not in it.** A thread keeps two
encoded `Y.RelativePosition` values (`anchor_start`, `anchor_end`) plus the quoted text.

- A relative position names a character by its CRDT id (client, clock) instead of an offset. The
  CRDT already moves that id correctly through every concurrent, offline or out-of-order edit, so
  the anchor inherits convergence for free.
- The browser creates the anchors from the selection (`absolutePositionToRelativePosition` from
  y-tiptap) and resolves them back. The server stores them as opaque bytes, at most 256 each.
- If every character of the passage is deleted, the anchor resolves to an empty range. The thread
  stays and shows its quoted text with "the text this was about was deleted."

**Highlights are ProseMirror decorations**, drawn over the text, never saved in it.

- Remote changes, undo and new threads: positions are worked out again from the anchors.
- Local typing: ProseMirror applies the edit before y-prosemirror writes it into Yjs, so resolving
  then would read the old text. The known ranges are mapped through the edit instead, with text
  typed at either edge kept outside. A test removes this mapping and fails.

**Live updates reuse the document's WebSocket.** After any comment change, the server sends one
byte (message type 121) to the stream's room. Clients refetch over REST; the REST API stays the
only source of comment data, and a client that was offline refetches after its next sync. Older
clients ignore the unknown message type.

**Data model.** `comment_threads` (document, optional branch, anchors, quote, resolved by and
when) and `comments` (thread, author, body, edited at). Ids are UUIDv7, so ordering by id is
ordering by time. A thread on a branch belongs to that branch's stream. It is not carried into
main on merge: the branch's ids are kept by the merge, but the review discussion is about the
proposal, not about main.

**Permissions.**

| Action | Who |
| --- | --- |
| Read threads | Anyone who can open the document (viewers too) |
| Open a thread, reply, resolve, reopen | Commenters, editors, owners |
| Edit a comment | Its author |
| Delete a comment | Its author, or an editor or owner (moderation) |
| Anything on a merged or closed branch | Nobody; it is read-only, discussion included |

Deleting a thread's first comment deletes the thread. Replying to a resolved thread reopens it.

**Notifications.** A new thread emails the document's owner. A reply emails everyone who wrote in
the thread. Never the author, and only people who are still members. Emails are plain text, built
after the comment is saved and sent after the response (FastAPI background task). A mail failure
is logged and never fails the request. Without `SMTP_HOST` the mailer only logs what it would
send.

**Limits.** Writes have their own budget (60 per 10 minutes per user), because each can send
email. At most 1,000 threads per stream and 200 comments per thread, checked before inserting.

## Consequences

- Comments survive every edit the text survives, including offline edits merged later, with no
  server-side position bookkeeping.
- The server cannot tell where a thread is; only browsers can resolve anchors. Search over comment
  text, or an email that quotes the current text, would need the server to resolve them too
  (pycrdt has no relative-position API today).
- The comment signal reaches only rooms on the same API instance until phase 5 adds Redis
  pub/sub, the same as kicks after an access change.
- Email addresses are not verified until phase 8, so for now someone could make a document owned
  by an address they do not control and trigger mail to it. The per-user write limit bounds this.
  Phase 8 should send notifications only to verified addresses.
