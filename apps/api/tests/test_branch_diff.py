"""The three-way comparison behind branch review (app.branches.diff, ADR 0016)."""

from typing import Any

from hypothesis import given
from hypothesis import settings as hypothesis_settings
from hypothesis import strategies as st
from pycrdt import Doc, XmlElement, XmlFragment, XmlText

from app.branches.diff import ChangeKind, blocks, compare, diff3
from app.collab.text import EDITOR_ROOT

# Few distinct values, so sequences share elements and diff3 has real work to do.
sequences = st.lists(st.sampled_from("abcde"), max_size=12)


@given(sequences, sequences, sequences)
@hypothesis_settings(max_examples=400, deadline=None)
def test_chunks_partition_all_three_sequences(
    base: list[str], main: list[str], branch: list[str]
) -> None:
    chunks = diff3(base, main, branch)

    for side in ("base", "main", "branch"):
        joined = [x for chunk in chunks for x in getattr(chunk, side)]
        assert joined == {"base": base, "main": main, "branch": branch}[side]
    for chunk in chunks:
        if chunk.stable:
            assert chunk.base == chunk.main == chunk.branch
        else:
            assert not (chunk.base == chunk.main == chunk.branch)


@given(sequences, sequences)
@hypothesis_settings(max_examples=300, deadline=None)
def test_a_branch_off_an_unchanged_main_never_conflicts(base: list[str], branch: list[str]) -> None:
    def as_blocks(keys: list[str]) -> list[Any]:
        return blocks(document(*keys))

    changes = compare(as_blocks(base), as_blocks(base), as_blocks(branch))

    assert all(change.kind is not ChangeKind.CONFLICT for change in changes)
    if base == branch:
        assert changes == []


@given(sequences, sequences)
@hypothesis_settings(max_examples=300, deadline=None)
def test_changes_made_only_on_main_are_not_the_branchs(base: list[str], main: list[str]) -> None:
    def as_blocks(keys: list[str]) -> list[Any]:
        return blocks(document(*keys))

    assert compare(as_blocks(base), as_blocks(main), as_blocks(base)) == []


# ----- what a reviewer sees ---------------------------------------------------------------------


def document(*paragraphs: str) -> Doc[Any]:
    doc: Doc[Any] = Doc()
    body = doc.get(EDITOR_ROOT, type=XmlFragment)
    for text in paragraphs:
        body.children.append(XmlElement("paragraph")).children.append(XmlText(text))
    return doc


def review(
    base: list[str], main: list[str], branch: list[str]
) -> list[tuple[str, list[str], list[str], list[str]]]:
    changes = compare(blocks(document(*base)), blocks(document(*main)), blocks(document(*branch)))
    return [(change.kind.value, change.base, change.main, change.branch) for change in changes]


def test_additions_removals_and_rewrites_on_the_branch() -> None:
    base = ["Intro", "Budget", "Risks"]
    branch = ["Intro", "Budget: 10k", "Timeline"]

    assert review(base, base, branch) == [
        ("changed", ["Budget", "Risks"], ["Budget", "Risks"], ["Budget: 10k", "Timeline"]),
    ]
    assert review(base, base, ["Intro", "Budget", "Risks", "Next steps"]) == [
        ("added", [], [], ["Next steps"]),
    ]
    assert review(base, base, ["Intro", "Risks"]) == [("removed", ["Budget"], ["Budget"], [])]


def test_a_passage_changed_on_both_sides_is_a_conflict() -> None:
    base = ["Intro", "Budget", "Risks"]

    assert review(
        base, ["Intro", "Budget is 5k", "Risks"], ["Intro", "Budget is 10k", "Risks"]
    ) == [
        ("conflict", ["Budget"], ["Budget is 5k"], ["Budget is 10k"]),
    ]


def test_deleting_what_the_other_side_edited_is_a_conflict() -> None:
    """The merge itself would silently drop the edit (delete wins in a CRDT): review must not."""
    base = ["Intro", "Budget", "Risks"]

    main_deleted = review(base, ["Intro", "Risks"], ["Intro", "Budget, revised", "Risks"])
    branch_deleted = review(base, ["Intro", "Budget, revised", "Risks"], ["Intro", "Risks"])

    assert [change[0] for change in main_deleted + branch_deleted] == ["conflict", "conflict"]


def test_main_changes_elsewhere_do_not_get_in_the_way() -> None:
    base = ["Intro", "Budget", "Risks"]

    assert review(
        base, ["Intro, updated", "Budget", "Risks"], ["Intro", "Budget", "Risks", "Plan"]
    ) == [
        ("added", [], [], ["Plan"]),
    ]


def test_both_sides_adding_at_the_same_place_keeps_both() -> None:
    base = ["Intro"]

    assert review(base, ["Intro", "From main"], ["Intro", "From branch"]) == [
        ("added", [], ["From main"], ["From branch"]),
    ]


def test_formatting_and_block_type_count_as_changes() -> None:
    plain = document("Budget")
    bold: Doc[Any] = Doc()
    text = bold.get(EDITOR_ROOT, type=XmlFragment).children.append(XmlElement("paragraph"))
    text.children.append(XmlText()).insert(0, "Budget", {"bold": {}})
    heading: Doc[Any] = Doc()
    element = heading.get(EDITOR_ROOT, type=XmlFragment).children.append(
        XmlElement("heading", {"level": "2"})
    )
    element.children.append(XmlText("Budget"))

    keys = {blocks(doc)[0].key for doc in (plain, bold, heading)}
    texts = {blocks(doc)[0].text for doc in (plain, bold, heading)}

    assert len(keys) == 3
    assert texts == {"Budget"}


def test_equal_blocks_compare_equal_whatever_order_their_attributes_were_set_in() -> None:
    first: Doc[Any] = Doc()
    first.get(EDITOR_ROOT, type=XmlFragment).children.append(
        XmlElement("heading", {"level": "2", "id": "x"})
    )
    second: Doc[Any] = Doc()
    second.get(EDITOR_ROOT, type=XmlFragment).children.append(
        XmlElement("heading", {"id": "x", "level": "2"})
    )

    assert blocks(first) == blocks(second)


def test_list_blocks_show_their_items_text() -> None:
    doc: Doc[Any] = Doc()
    items = doc.get(EDITOR_ROOT, type=XmlFragment).children.append(XmlElement("bulletList"))
    for text in ("one", "two"):
        item = items.children.append(XmlElement("listItem"))
        item.children.append(XmlElement("paragraph")).children.append(XmlText(text))

    assert blocks(doc)[0].text == "one\ntwo"
