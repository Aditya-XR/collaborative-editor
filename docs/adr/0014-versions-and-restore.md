# 0014 · Version history, and restore as an ordinary edit

- **Status:** accepted
- **Date:** 2026-10-02

## Context

Editors need to see earlier states of a document and go back to one. In a CRDT there is no
"rewind": every replica holds the full history of operations, and anything sent later merges
with whatever others are doing at that moment.

## Decision

- **Versions are snapshots** in `document_snapshots` (ADR 0003), each the whole document state:
  - `auto`: when an editing session ends, and every 10 minutes during long sessions;
  - `named`: saved or named by a person;
  - `pre_restore`: the state just before a restore, pointing at the version restored.
- **Bounded storage.** The newest 50 automatic and pre-restore versions are kept; named ones stay
  until unnamed, at most 100 per document.
- **Editors only.** Version history can show deliberately deleted text, so viewers and
  commenters get 403, as in Google Docs.
- **Saving flushes first.** "Save version" writes the room's buffered edits before reading the
  state, so it includes what was typed a moment ago.
- **Preview in the browser.** The API returns the state as a base64 Yjs update. The browser
  loads it into a private Y.Doc and renders it with the same editor, read-only, so formatting
  looks exactly as it was.
- **Restore is an edit made by the browser.**
  1. The server saves the current state as a `pre_restore` version.
  2. The browser sets the preview's content on the live editor (`setContent`).
  3. y-prosemirror turns that into the smallest Yjs change that makes the live document equal
     the version, sent like any typing.

## Alternatives considered

- **Server-side restore** (pycrdt rewrites the document). Rejected:
  - pycrdt counts text positions in UTF-8 bytes where browsers use UTF-16 (ADR 0012).
  - It turned the numeric heading attribute `2` into `2.0` when copying XML in a quick test.
  - It needs a new protocol event to tell open editors what happened.
- **Replacing the whole document** (delete everything, insert the version). Rejected: it
  discards concurrent edits even to paragraphs the version did not change, and every cursor
  jumps.

## Consequences

- Concurrent edits survive a restore wherever they do not overlap what it changes.
- The person who restored can press Undo, which reverts the restore like any edit.
- Restore needs the editor open. That is the only place it is offered, and if the browser is
  offline the edit syncs on reconnect like any other.
- Tests cover the real path in jsdom: a Tiptap editor bound to a Yjs doc, restore, then Undo.
  It was also checked in a real browser with a second tab watching.
