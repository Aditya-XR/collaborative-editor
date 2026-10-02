"""Branches and merge requests, end to end: real sockets, real rooms, real Postgres."""

import asyncio
import base64
import uuid
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from pycrdt import Doc

from app.branches.diff import blocks
from app.branches.service import MAX_OPEN_BRANCHES
from app.collab.room import CloseCode
from app.documents.models import DocumentRole
from tests.collab_client import Peer, eventually, open_document
from tests.conftest import RegisteredUser, register
from tests.test_documents import create_doc, grant


def url(doc_id: str, suffix: str = "") -> str:
    return f"/api/documents/{doc_id}/branches{suffix}"


async def setup_doc(
    app: FastAPI, client: AsyncClient, *paragraphs: str
) -> tuple[RegisteredUser, str]:
    """An owner and a document whose main text already holds `paragraphs`."""
    owner = await register(client, email="owner@example.com", name="Owner")
    doc_id = (await create_doc(client, owner))["id"]
    if paragraphs:
        async with open_document(app, owner, doc_id) as peer:
            await peer.write_paragraphs(*paragraphs)
            await asyncio.sleep(0.05)
        await eventually(lambda: _gone(app, doc_id))
    return owner, doc_id


async def _gone(app: FastAPI, stream_id: str) -> bool:
    return uuid.UUID(stream_id) not in app.state.rooms.rooms


async def branch(
    client: AsyncClient, user: RegisteredUser, doc_id: str, name: str = "Draft"
) -> dict[str, Any]:
    response = await client.post(url(doc_id), json={"name": name}, headers=user.headers)
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


async def review(client: AsyncClient, user: RegisteredUser, doc_id: str, branch_id: str) -> Any:
    response = await client.get(url(doc_id, f"/{branch_id}/review"), headers=user.headers)
    assert response.status_code == 200, response.text
    return response.json()


def texts(state: str) -> list[str]:
    doc: Doc[Any] = Doc()
    doc.apply_update(base64.b64decode(state))
    return [block.text for block in blocks(doc)]


async def settle(peer: Peer) -> None:
    """Gives the server a moment to receive and save what the peer sent."""
    await asyncio.sleep(0.05)


# ----- forking ----------------------------------------------------------------------------------


async def test_a_branch_starts_as_a_copy_and_then_lives_apart(
    app: FastAPI, client: AsyncClient
) -> None:
    owner, doc_id = await setup_doc(app, client, "Intro", "Budget")
    created = await branch(client, owner, doc_id, "  Rewrite budget  ")

    assert created["name"] == "Rewrite budget"
    assert created["status"] == "open"
    assert created["created_by"] == {"id": owner.id, "name": "Owner"}
    assert (created["can_edit"], created["can_merge"]) == (True, True)

    async with (
        open_document(app, owner, doc_id) as main,
        open_document(app, owner, doc_id, branch_id=created["id"]) as fork,
    ):
        assert fork.paragraphs() == ["Intro", "Budget"]
        await fork.append_to_paragraph(1, ": 10k")
        await main.write_paragraphs("Main only")
        await settle(fork)
        await asyncio.sleep(0.2)  # long enough for either edit to cross over, were it to
        assert main.paragraphs() == ["Intro", "Budget", "Main only"]
        assert fork.paragraphs() == ["Intro", "Budget: 10k"]

    async with open_document(app, owner, doc_id, branch_id=created["id"]) as reopened:
        assert reopened.paragraphs() == ["Intro", "Budget: 10k"]


async def test_who_may_branch(app: FastAPI, client: AsyncClient) -> None:
    owner, doc_id = await setup_doc(app, client)
    commenter = await register(client, email="c@example.com", name="Commenter")
    viewer = await register(client, email="v@example.com", name="Viewer")
    outsider = await register(client, email="o@example.com", name="Outsider")
    await grant(app, doc_id, commenter, DocumentRole.COMMENTER)
    await grant(app, doc_id, viewer, DocumentRole.VIEWER)

    statuses = {
        user.name: (
            await client.post(url(doc_id), json={"name": user.name}, headers=user.headers)
        ).status_code
        for user in (owner, commenter, viewer, outsider)
    }

    assert statuses == {"Owner": 201, "Commenter": 201, "Viewer": 403, "Outsider": 404}
    listed = (await client.get(url(doc_id), headers=viewer.headers)).json()
    assert sorted(b["name"] for b in listed) == ["Commenter", "Owner"]


async def test_open_branches_are_capped_and_their_names_unique(
    app: FastAPI, client: AsyncClient
) -> None:
    owner, doc_id = await setup_doc(app, client)
    for i in range(MAX_OPEN_BRANCHES):
        await branch(client, owner, doc_id, f"b{i}")

    eleventh = await client.post(url(doc_id), json={"name": "one more"}, headers=owner.headers)
    assert eleventh.status_code == 409
    assert eleventh.json()["code"] == "too_many_branches"

    listed = (await client.get(url(doc_id), headers=owner.headers)).json()
    await client.post(url(doc_id, f"/{listed[0]['id']}/close"), headers=owner.headers)
    taken = await client.post(url(doc_id), json={"name": "b1"}, headers=owner.headers)
    freed = await client.post(url(doc_id), json={"name": listed[0]["name"]}, headers=owner.headers)
    assert taken.json()["code"] == "branch_name_taken"
    assert freed.status_code == 201  # a closed branch's name can be used again


# ----- reviewing and merging --------------------------------------------------------------------


async def test_review_then_merge_reaches_everyone_on_main(
    app: FastAPI, client: AsyncClient
) -> None:
    owner, doc_id = await setup_doc(app, client, "Intro", "Budget", "Risks")
    created = await branch(client, owner, doc_id)
    async with open_document(app, owner, doc_id, branch_id=created["id"]) as fork:
        await fork.append_to_paragraph(1, ": 10k")
        await fork.write_paragraphs("Timeline")
        await settle(fork)

    found = await review(client, owner, doc_id, created["id"])
    assert found["conflicts"] == 0
    assert [(c["kind"], c["base"], c["branch"]) for c in found["changes"]] == [
        ("changed", ["Budget", "Risks"], ["Budget: 10k", "Risks", "Timeline"]),
    ] or [(c["kind"], c["base"], c["branch"]) for c in found["changes"]] == [
        ("changed", ["Budget"], ["Budget: 10k"]),
        ("added", [], ["Timeline"]),
    ]
    assert texts(found["preview"]) == ["Intro", "Budget: 10k", "Risks", "Timeline"]

    async with open_document(app, owner, doc_id) as reader:
        merged = await client.post(
            url(doc_id, f"/{created['id']}/merge"),
            json={"head": found["head"]},
            headers=owner.headers,
        )
        assert merged.status_code == 200, merged.text
        assert merged.json()["status"] == "merged"
        assert merged.json()["merged_by"] == {"id": owner.id, "name": "Owner"}
        await reader.until(
            lambda: reader.paragraphs() == ["Intro", "Budget: 10k", "Risks", "Timeline"]
        )

    versions = (await client.get(f"/api/documents/{doc_id}/versions", headers=owner.headers)).json()
    before = next(v for v in versions if v["kind"] == "pre_merge")
    assert before["label"] == "Draft"
    detail = await client.get(
        f"/api/documents/{doc_id}/versions/{before['id']}", headers=owner.headers
    )
    assert texts(detail.json()["state"]) == ["Intro", "Budget", "Risks"]  # restoring undoes it

    again = await client.post(
        url(doc_id, f"/{created['id']}/merge"), json={"head": found["head"]}, headers=owner.headers
    )
    assert again.status_code == 409
    assert again.json()["code"] == "branch_not_open"


async def test_main_moving_on_meanwhile_merges_cleanly(app: FastAPI, client: AsyncClient) -> None:
    owner, doc_id = await setup_doc(app, client, "Intro", "Budget", "Risks")
    created = await branch(client, owner, doc_id)
    async with (
        open_document(app, owner, doc_id) as main,
        open_document(app, owner, doc_id, branch_id=created["id"]) as fork,
    ):
        await main.append_to_paragraph(0, " (updated)")
        await fork.append_to_paragraph(2, " and mitigations")
        await settle(main)

        found = await review(client, owner, doc_id, created["id"])
        assert found["conflicts"] == 0
        merged = await client.post(
            url(doc_id, f"/{created['id']}/merge"),
            json={"head": found["head"]},
            headers=owner.headers,
        )
        assert merged.status_code == 200
        await main.until(
            lambda: main.paragraphs() == ["Intro (updated)", "Budget", "Risks and mitigations"]
        )


@pytest.mark.parametrize("main_deletes", [False, True], ids=["both-edit", "main-deletes"])
async def test_conflicts_block_the_merge(
    app: FastAPI, client: AsyncClient, main_deletes: bool
) -> None:
    owner, doc_id = await setup_doc(app, client, "Intro", "Budget", "Risks")
    created = await branch(client, owner, doc_id)
    async with (
        open_document(app, owner, doc_id) as main,
        open_document(app, owner, doc_id, branch_id=created["id"]) as fork,
    ):
        await fork.append_to_paragraph(1, " is 10k")
        if main_deletes:
            await main.delete_paragraph(1)
        else:
            await main.append_to_paragraph(1, " is 5k")
        await settle(main)

        found = await review(client, owner, doc_id, created["id"])
        assert found["conflicts"] == 1
        conflict = found["changes"][0]
        assert conflict["kind"] == "conflict"
        assert conflict["branch"] == ["Budget is 10k"]
        assert conflict["main"] == ([] if main_deletes else ["Budget is 5k"])

        refused = await client.post(
            url(doc_id, f"/{created['id']}/merge"),
            json={"head": found["head"]},
            headers=owner.headers,
        )
        assert refused.status_code == 409
        assert refused.json()["code"] == "merge_conflicts"
        await asyncio.sleep(0.1)
        assert main.paragraphs() == (
            ["Intro", "Risks"] if main_deletes else ["Intro", "Budget is 5k", "Risks"]
        )

        # The branch is still editable: the merge attempt did not leave it frozen.
        await fork.write_paragraphs("Still writing")
        await settle(fork)
    async with open_document(app, owner, doc_id, branch_id=created["id"]) as reopened:
        assert reopened.paragraphs()[-1] == "Still writing"


async def test_a_branch_that_changed_since_review_is_not_merged(
    app: FastAPI, client: AsyncClient
) -> None:
    owner, doc_id = await setup_doc(app, client, "Intro")
    created = await branch(client, owner, doc_id)
    async with open_document(app, owner, doc_id, branch_id=created["id"]) as fork:
        await fork.write_paragraphs("Reviewed")
        await settle(fork)
        found = await review(client, owner, doc_id, created["id"])
        await fork.write_paragraphs("Typed after the review")
        await settle(fork)

        stale = await client.post(
            url(doc_id, f"/{created['id']}/merge"),
            json={"head": found["head"]},
            headers=owner.headers,
        )

    assert stale.status_code == 409
    assert stale.json()["code"] == "branch_changed"


async def test_updating_from_main_resolves_a_conflict(app: FastAPI, client: AsyncClient) -> None:
    """Git's workflow: merge main into the branch, fix the passage there, review again."""
    owner, doc_id = await setup_doc(app, client, "Intro", "Budget")
    created = await branch(client, owner, doc_id)
    async with (
        open_document(app, owner, doc_id) as main,
        open_document(app, owner, doc_id, branch_id=created["id"]) as fork,
    ):
        await main.append_to_paragraph(0, " v2")
        await main.append_to_paragraph(1, " is 5k")
        await fork.append_to_paragraph(1, " is 10k")
        await settle(main)
        assert (await review(client, owner, doc_id, created["id"]))["conflicts"] == 1

        updated = await client.post(
            url(doc_id, f"/{created['id']}/update-from-main"), headers=owner.headers
        )
        assert updated.status_code == 200, updated.text
        await fork.until(lambda: fork.paragraphs()[0] == "Intro v2")  # main's change arrived live
        # Both sides' words are now in the branch's budget line; the author settles it there.
        await fork.edit_body(lambda body: _replace_paragraph(body, 1, "Budget is 8k"))
        await settle(fork)

        found = await review(client, owner, doc_id, created["id"])
        assert found["conflicts"] == 0
        assert [(c["kind"], c["main"], c["branch"]) for c in found["changes"]] == [
            ("changed", ["Budget is 5k"], ["Budget is 8k"]),
        ]
        merged = await client.post(
            url(doc_id, f"/{created['id']}/merge"),
            json={"head": found["head"]},
            headers=owner.headers,
        )
        assert merged.status_code == 200
        await main.until(lambda: main.paragraphs() == ["Intro v2", "Budget is 8k"])


def _replace_paragraph(body: Any, index: int, text: str) -> None:
    from pycrdt import XmlElement, XmlText

    del body.children[index]
    body.children.insert(index, XmlElement("paragraph")).children.append(XmlText(text))


# ----- who may do what --------------------------------------------------------------------------


async def test_commenters_propose_but_only_editors_merge(app: FastAPI, client: AsyncClient) -> None:
    owner, doc_id = await setup_doc(app, client, "Intro")
    commenter = await register(client, email="c@example.com", name="Commenter")
    other = await register(client, email="c2@example.com", name="Other commenter")
    await grant(app, doc_id, commenter, DocumentRole.COMMENTER)
    await grant(app, doc_id, other, DocumentRole.COMMENTER)
    proposal = await branch(client, commenter, doc_id, "Suggestion")
    assert (proposal["can_edit"], proposal["can_merge"]) == (True, False)

    async with open_document(app, commenter, doc_id, branch_id=proposal["id"]) as own:
        await own.write_paragraphs("Proposed")
        await settle(own)
    async with open_document(app, other, doc_id, branch_id=proposal["id"]) as theirs:
        await theirs.write_paragraphs("Vandalism")  # read-only for them: ignored
        await settle(theirs)
    requested = await client.patch(
        url(doc_id, f"/{proposal['id']}"),
        json={"review_requested": True, "description": "Adds a line"},
        headers=commenter.headers,
    )
    assert requested.json()["review_requested_at"] is not None

    found = await review(client, commenter, doc_id, proposal["id"])
    assert [c["branch"] for c in found["changes"]] == [["Proposed"]]
    by_commenter = await client.post(
        url(doc_id, f"/{proposal['id']}/merge"),
        json={"head": found["head"]},
        headers=commenter.headers,
    )
    renamed_by_other = await client.patch(
        url(doc_id, f"/{proposal['id']}"), json={"name": "Mine now"}, headers=other.headers
    )
    by_owner = await client.post(
        url(doc_id, f"/{proposal['id']}/merge"), json={"head": found["head"]}, headers=owner.headers
    )

    assert by_commenter.status_code == 403
    assert renamed_by_other.status_code == 403
    assert by_owner.status_code == 200


async def test_merging_or_closing_makes_open_editors_read_only(
    app: FastAPI, client: AsyncClient
) -> None:
    owner, doc_id = await setup_doc(app, client, "Intro")
    editor = await register(client, email="e@example.com", name="Editor")
    await grant(app, doc_id, editor, DocumentRole.EDITOR)
    created = await branch(client, owner, doc_id)

    async with open_document(app, editor, doc_id, branch_id=created["id"]) as fork:
        closed = await client.post(url(doc_id, f"/{created['id']}/close"), headers=owner.headers)
        assert closed.json()["status"] == "closed"
        assert await fork.closed_with() == CloseCode.ROLE_CHANGED

    ticket = await client.post(
        "/api/collab/tickets",
        json={"document_id": doc_id, "branch_id": created["id"]},
        headers=editor.headers,
    )
    assert ticket.json()["role"] == "viewer"
    reopened = await client.post(
        url(doc_id, f"/{created['id']}/update-from-main"), headers=owner.headers
    )
    assert reopened.status_code == 409


async def test_losing_access_disconnects_branch_editors_too(
    app: FastAPI, client: AsyncClient
) -> None:
    owner, doc_id = await setup_doc(app, client, "Intro")
    editor = await register(client, email="e@example.com", name="Editor")
    await grant(app, doc_id, editor, DocumentRole.EDITOR)
    created = await branch(client, editor, doc_id)

    async with open_document(app, editor, doc_id, branch_id=created["id"]) as fork:
        await client.delete(f"/api/documents/{doc_id}/members/{editor.id}", headers=owner.headers)
        assert await fork.closed_with() == CloseCode.FORBIDDEN

    async with open_document(app, owner, doc_id, branch_id=created["id"]) as fork:
        await client.delete(f"/api/documents/{doc_id}", headers=owner.headers)
        assert await fork.closed_with() == CloseCode.NOT_FOUND


async def test_branches_of_other_documents_are_not_reachable(
    app: FastAPI, client: AsyncClient
) -> None:
    owner, doc_id = await setup_doc(app, client)
    other_doc = (await create_doc(client, owner, "Other"))["id"]
    foreign = await branch(client, owner, other_doc)

    for response in (
        await client.get(url(doc_id, f"/{foreign['id']}"), headers=owner.headers),
        await client.get(url(doc_id, f"/{foreign['id']}/review"), headers=owner.headers),
        await client.post(
            "/api/collab/tickets",
            json={"document_id": doc_id, "branch_id": foreign["id"]},
            headers=owner.headers,
        ),
    ):
        assert response.status_code == 404
        assert response.json()["code"] == "branch_not_found"


# ----- storage ----------------------------------------------------------------------------------


async def test_branch_edits_are_compacted_in_their_own_stream(
    app: FastAPI, client: AsyncClient
) -> None:
    owner, doc_id = await setup_doc(app, client, "Intro")
    created = await branch(client, owner, doc_id)
    async with open_document(app, owner, doc_id, branch_id=created["id"]) as fork:
        for word in ("one", "two", "three"):
            await fork.write_paragraphs(word)
        await settle(fork)
    await eventually(lambda: _gone(app, created["id"]))

    store = app.state.rooms.store
    branch_stream = await store.load(uuid.UUID(doc_id), uuid.UUID(created["id"]))
    main_stream = await store.load(uuid.UUID(doc_id))
    assert branch_stream.log_rows == 0  # folded when the session ended
    assert [b.text for b in blocks(_doc(branch_stream.updates))] == ["Intro", "one", "two", "three"]
    assert [b.text for b in blocks(_doc(main_stream.updates))] == ["Intro"]
    versions = (await client.get(f"/api/documents/{doc_id}/versions", headers=owner.headers)).json()
    assert all(v["kind"] != "pre_merge" for v in versions)
    hits = (
        await client.get("/api/documents/search", params={"q": "three"}, headers=owner.headers)
    ).json()
    assert hits == []  # search covers main only


def _doc(updates: list[bytes]) -> Doc[Any]:
    from pycrdt import merge_updates

    doc: Doc[Any] = Doc()
    doc.apply_update(merge_updates(*updates))
    return doc
