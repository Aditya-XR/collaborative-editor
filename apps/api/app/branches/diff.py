"""What a branch changes, compared block by block with main and their merge base (ADR 0016).

The merge itself is a CRDT merge: it always succeeds, and it combines concurrent edits even
where a person would call them a conflict (both sides rewrote a paragraph: the words interleave;
one side deleted a paragraph the other edited: the edits vanish). So before merging, the three
states are compared the way git compares lines, with diff3, but over blocks: paragraphs,
headings, list and quote blocks. A block changed on both sides since the merge base is a
conflict, and conflicts block the merge.
"""

import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher
from enum import StrEnum
from typing import Any

from pycrdt import Doc, XmlElement, XmlFragment, XmlText

from app.collab.text import EDITOR_ROOT


@dataclass(frozen=True)
class Block:
    # Equal keys mean equal blocks: type, attributes, text and formatting all match.
    key: str
    # What a person reads, for showing the change.
    text: str


Node = XmlElement | XmlText | XmlFragment


def _canonical(node: Node) -> Any:
    """A deterministic description of a node: attributes and formatting are sorted, so equal
    content always serialises to the same string."""
    if isinstance(node, XmlText):
        return [[run, sorted((attrs or {}).items())] for run, attrs in node.diff()]
    children = [_canonical(child) for child in node.children]
    if isinstance(node, XmlFragment):
        return children
    # The attributes view iterates as (name, value) pairs but is not typed as iterable.
    attributes: Iterable[tuple[str, Any]] = node.attributes  # type: ignore[assignment]
    return [node.tag, sorted(attributes), children]


def _text(node: Node) -> str:
    if isinstance(node, XmlText):
        return "".join(run for run, _ in node.diff() if isinstance(run, str))
    return "\n".join(filter(None, (_text(child) for child in node.children)))


def blocks(doc: Doc[Any]) -> list[Block]:
    """The document's top-level blocks, in order."""
    return [
        Block(json.dumps(_canonical(child), ensure_ascii=False, default=str), _text(child))
        for child in doc.get(EDITOR_ROOT, type=XmlFragment).children
    ]


# ----- diff3 ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Chunk:
    """A run of the three sequences. Stable chunks are equal on all sides; the others differ
    somewhere. Concatenating every chunk's parts gives back each whole sequence."""

    stable: bool
    base: tuple[str, ...]
    main: tuple[str, ...]
    branch: tuple[str, ...]


def _matches(base: Sequence[str], other: Sequence[str]) -> dict[int, int]:
    """base index -> other index for a longest common subsequence (monotone in both)."""
    matcher = SequenceMatcher(None, base, other, autojunk=False)
    pairs: dict[int, int] = {}
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            pairs[block.a + offset] = block.b + offset
    return pairs


def diff3(base: Sequence[str], main: Sequence[str], branch: Sequence[str]) -> list[Chunk]:
    """Splits three sequences into stable and unstable chunks (Khanna, Kunal and Pierce, "A
    formal investigation of diff3", 2007): stable where all three agree, unstable between."""
    to_main, to_branch = _matches(base, main), _matches(base, branch)
    chunks: list[Chunk] = []
    o = a = b = 0
    while True:
        # Extend a stable run while base, main and branch advance in lockstep.
        run = 0
        while (
            o + run < len(base)
            and to_main.get(o + run) == a + run
            and to_branch.get(o + run) == b + run
        ):
            run += 1
        if run:
            chunks.append(
                Chunk(
                    True, *(tuple(s[i : i + run]) for s, i in ((base, o), (main, a), (branch, b)))
                )
            )
            o, a, b = o + run, a + run, b + run
            continue
        # The next base element both sides kept closes the unstable run.
        end = o
        while end < len(base) and not (end in to_main and end in to_branch):
            end += 1
        if end == len(base):
            if o < len(base) or a < len(main) or b < len(branch):
                chunks.append(Chunk(False, tuple(base[o:]), tuple(main[a:]), tuple(branch[b:])))
            return chunks
        a_end, b_end = to_main[end], to_branch[end]
        chunks.append(
            Chunk(False, tuple(base[o:end]), tuple(main[a:a_end]), tuple(branch[b:b_end]))
        )
        o, a, b = end, a_end, b_end


# ----- what the review shows --------------------------------------------------------------------


class ChangeKind(StrEnum):
    ADDED = "added"  # the branch adds blocks
    REMOVED = "removed"  # the branch removes blocks
    CHANGED = "changed"  # the branch rewrites blocks
    CONFLICT = "conflict"  # main changed the same blocks since the merge base


@dataclass(frozen=True)
class Change:
    kind: ChangeKind
    # Text of the blocks involved, on each side.
    base: list[str]
    main: list[str]
    branch: list[str]


def compare(base: list[Block], main: list[Block], branch: list[Block]) -> list[Change]:
    """The branch's changes as a reviewer sees them: what merging would do to main."""
    text = {block.key: block.text for block in (*base, *main, *branch)}
    changes = []
    for chunk in diff3(
        [block.key for block in base],
        [block.key for block in main],
        [block.key for block in branch],
    ):
        if chunk.stable or chunk.branch == chunk.base:
            continue  # untouched by the branch; main's own changes are not the branch's
        sides = ([text[k] for k in part] for part in (chunk.base, chunk.main, chunk.branch))
        o, m, b = sides
        if chunk.main == chunk.base:
            kind = (
                ChangeKind.ADDED
                if not chunk.base
                else ChangeKind.REMOVED
                if not chunk.branch
                else ChangeKind.CHANGED
            )
        elif not chunk.base:
            # Both sides added blocks at the same place: the merge keeps both.
            kind = ChangeKind.ADDED
        else:
            # Both sides changed the same blocks, identically or not. Even identical edits
            # count: two people's insertions of the same word are two insertions to a CRDT.
            kind = ChangeKind.CONFLICT
        changes.append(Change(kind, o, m, b))
    return changes
