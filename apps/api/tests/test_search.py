import uuid
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient

from app.documents.models import DocumentRole
from tests.collab_client import eventually, open_document
from tests.conftest import RegisteredUser, register
from tests.test_documents import create_doc, grant


async def write_body(app: FastAPI, user: RegisteredUser, doc_id: str, *paragraphs: str) -> None:
    """Types paragraphs in the editor's format and ends the session, which indexes the text."""
    async with open_document(app, user, doc_id) as peer:
        await peer.write_paragraphs(*paragraphs)
        await eventually(lambda: _has_rows(app, doc_id))
    await eventually(lambda: _room_gone(app, doc_id))


async def _has_rows(app: FastAPI, doc_id: str) -> bool:
    from tests.test_collab import stored_update_count

    return await stored_update_count(app, doc_id) > 0


async def _room_gone(app: FastAPI, doc_id: str) -> bool:
    return uuid.UUID(doc_id) not in app.state.rooms.rooms


async def search(client: AsyncClient, user: RegisteredUser, q: str) -> list[dict[str, Any]]:
    response = await client.get("/api/documents/search", params={"q": q}, headers=user.headers)
    assert response.status_code == 200, response.text
    hits: list[dict[str, Any]] = response.json()
    return hits


def titles(hits: list[dict[str, Any]]) -> list[str]:
    return [hit["document"]["title"] for hit in hits]


async def test_finds_documents_by_what_their_body_says(app: FastAPI, client: AsyncClient) -> None:
    alice = await register(client, email="alice@example.com", name="Alice")
    roadmap = await create_doc(client, alice, "Roadmap")
    await create_doc(client, alice, "Groceries")
    await write_body(
        app, alice, roadmap["id"], "We ship the collaborative editor in October.", "Then search."
    )

    hits = await search(client, alice, "collaborative october")

    assert titles(hits) == ["Roadmap"]
    assert hits[0]["document"]["role"] == "owner"
    snippet = hits[0]["snippet"]
    assert [part["text"] for part in snippet if part["match"]] == ["collaborative", "October"]
    assert "ship the collaborative editor in October" in "".join(p["text"] for p in snippet)


@pytest.mark.parametrize(
    ("typed", "found"),
    [
        ("collab", True),  # a word still being typed: prefix of what was written
        ("runn", True),  # prefix of "running", which stemming alone would miss
        ("runs", True),  # another form of "running", found through stemming
        ("RUNNING Editors", True),  # case does not matter
        ("collab zebra", False),  # every word must match
    ],
)
async def test_matches_words_while_they_are_typed(
    app: FastAPI, client: AsyncClient, typed: str, found: bool
) -> None:
    alice = await register(client, email="alice@example.com", name="Alice")
    doc = await create_doc(client, alice, "Notes")
    await write_body(app, alice, doc["id"], "Collaborative editors keep running smoothly.")

    assert titles(await search(client, alice, typed)) == (["Notes"] if found else [])


async def test_title_matches_rank_above_body_matches(app: FastAPI, client: AsyncClient) -> None:
    alice = await register(client, email="alice@example.com", name="Alice")
    in_body = await create_doc(client, alice, "Weekly notes")
    await write_body(app, alice, in_body["id"], "Remember the budget review.")
    await create_doc(client, alice, "Budget 2027")

    hits = await search(client, alice, "budget")

    assert titles(hits) == ["Budget 2027", "Weekly notes"]
    assert hits[0]["snippet"] == []  # the title matched; the body is empty


async def test_only_documents_the_user_can_open_are_found(
    app: FastAPI, client: AsyncClient
) -> None:
    alice = await register(client, email="alice@example.com", name="Alice")
    bob = await register(client, email="bob@example.com", name="Bob")
    private = await create_doc(client, alice, "Secret plan")
    shared = await create_doc(client, alice, "Shared plan")
    trashed = await create_doc(client, bob, "Old plan")
    await grant(app, shared["id"], bob, DocumentRole.VIEWER)
    await client.delete(f"/api/documents/{trashed['id']}", headers=bob.headers)

    assert titles(await search(client, alice, "plan")) == ["Shared plan", "Secret plan"]
    hits = await search(client, bob, "plan")
    assert titles(hits) == ["Shared plan"]
    assert private["id"] not in {hit["document"]["id"] for hit in hits}
    assert hits[0]["document"]["role"] == "viewer"


@pytest.mark.parametrize(
    "typed",
    [
        "'",
        "&",
        ":*",
        "!!",
        "()",
        "a:*b",
        "\\",
        "<->",
        "x & y | !z",
        "' OR 1=1 --",
        "😀",
        "the",  # a stop word only
        "naïve café",
        "\x00",
    ],
)
async def test_any_input_is_a_search_never_an_error(client: AsyncClient, typed: str) -> None:
    alice = await register(client, email="alice@example.com", name="Alice")
    await create_doc(client, alice, "Plan")

    response = await client.get("/api/documents/search", params={"q": typed}, headers=alice.headers)

    assert response.status_code == 200, response.text


async def test_query_is_validated(client: AsyncClient) -> None:
    alice = await register(client, email="alice@example.com", name="Alice")

    invalid: list[dict[str, str | int]] = [{}, {"q": ""}, {"q": "x" * 201}, {"q": "a", "limit": 0}]
    for params in invalid:
        response = await client.get("/api/documents/search", params=params, headers=alice.headers)
        assert response.status_code == 422, params


async def test_search_requires_authentication(client: AsyncClient) -> None:
    response = await client.get("/api/documents/search", params={"q": "plan"})
    assert response.status_code == 401
