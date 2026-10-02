# 0016 · Branches and merge requests

- **Status:** accepted
- **Date:** 2026-10-02

## Context

The signature feature: fork a live document, rework it on the side (alone or with others), and
merge it back after review, the way code moves through a branch and a pull request. Google Docs
has suggestions, which are per-edit and inline; it has no way to rework a whole section in
private and propose it as one change.

Two facts shape the design:

- **A CRDT merge never fails.** Applying the branch's operations to main always succeeds and
  always converges.
- **"Never fails" is not "does what people mean."**
  - If both sides rewrite one paragraph, the words interleave ("Budget is 5k is 10k").
  - If one side deletes a paragraph the other side edited, the edits vanish: in Yjs, a deleted
    parent swallows its children, and pycrdt does the same (checked before building this).

## Decision

**A branch is a separate stream.** Rows in `document_updates` and `document_snapshots` carry a
`branch_id`.

- Each branch has its own edit log, compaction snapshot and live room, keyed by branch id.
- All the phase 2 and 3 machinery works unchanged for branches: rooms, batching, compaction,
  heartbeats and kicks.
- Versions and search stay main's.

**Fork** copies main's current state. That state is both the branch's starting text and its
`base_state`, the merge base.

**Review compares three states at paragraph level with diff3** (Khanna, Kunal and Pierce, 2007):
the merge base, main now, and the branch.

- **Blocks:** the top-level blocks of the editor's XML (paragraphs, headings, lists, quotes).
  Each is serialised canonically, with attributes and formatting sorted.
- **Alignment:** a longest common subsequence aligns each side with the base.
- **What the review lists:**
  - a block only the branch changed is added, removed or changed;
  - a block only main changed is not shown;
  - a block both sides changed is a **conflict**, including one side deleting what the other
    edited, and identical edits, which a CRDT would apply twice;
  - blocks both sides added at the same place are not a conflict: the merge keeps both.
- **Preview:** the review also returns main after the merge (`merge_updates(main, branch)`),
  which the browser renders read-only with the real editor.

**Merge**, by an owner or editor:

1. Lock the branch row and freeze the branch's room, so no edit sneaks in between check and
   merge.
2. Save both rooms' buffered edits, then compare again.
3. Refuse if the branch is not what the reviewer saw. The review returns a digest of the branch's
   state vector, and the merge must send it back.
4. Refuse if anything conflicts.
5. Save main as a `pre_merge` version, so restoring that version undoes the merge.
6. Apply what main lacks from the branch through main's live room, so everyone editing main sees
   it at once.
7. Mark the branch merged and reconnect its editors with read-only tickets (close code 4409).

**Update from main** (`git merge main` on the branch):

- Main's state goes into the branch through the branch's room.
- The merge base moves up to main as it is now. The base moves only after the branch has saved
  main's changes; the other order would make main's changes look like the branch undoing them.
- This is how conflicts are settled: both versions' words land in the branch, the author fixes
  the passage there, and the fix reviews as an ordinary change.
- The confirmation warns that main's deletions win.

**Who may do what:**

- Any member can see a document's branches.
- Commenters can create branches and edit their own, proposing changes without edit rights, like
  a fork and pull request.
- Owners and editors can edit any open branch, and they are the only ones who can merge.
- Merged and closed branches are read-only.
- Limits: at most 10 open branches per document, branch creation rate-limited per user, and
  names unique among open branches.

**One table, no separate merge request.** A branch *is* the merge request once its author asks
for review (`review_requested_at`, with a description). The target is always main, so a second
table would only duplicate the branch's lifecycle.

## Alternatives considered

- **Diff rendered ProseMirror trees in the browser** (the plan's ADR 0009). Equally able to show
  changes. But conflicts must also be checked by the server at merge time, and a client check can
  be skipped. One Python implementation now serves both review and merge.
- **Diff by Yjs item identity** instead of content. Exact, but pycrdt does not expose item ids.
  Content alignment is the well-understood diff3 model, and a type change (paragraph to heading)
  correctly counts as a change.
- **Character-level conflicts.** Finer, but noisy in prose: two edits to different sentences of
  one paragraph are worth a human look before merging anyway.

## Consequences

- **A merge does exactly what its preview showed.** One edge remains: if main changes a passage
  the branch also touched in the moments between the final check and the merge, it is not caught.
  The window is a fraction of a second.
- **Keystrokes typed into the branch during those moments are lost from the branch.** The branch
  is frozen, its editors then reconnect read-only, and those keystrokes stay only in the author's
  browser.
- **Rooms are found by stream id**, so revoking access or trashing a document disconnects its
  branch rooms too. Like everything else, this reaches only this instance until phase 5.
- **Found while building:**
  - The first version locked the branch row `FOR UPDATE`.
  - Every edit saved to that branch checks its foreign key with a `KEY SHARE` lock on that row,
    which `FOR UPDATE` blocks, so a merge that saves the branch's last edits waited on itself.
  - The row is now locked `FOR NO KEY UPDATE`, which still serialises merges, closes and updates
    but lets edits through.
