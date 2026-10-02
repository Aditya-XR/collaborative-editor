import asyncio
import base64
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pycrdt import Doc, Text

from app.collab.models import SnapshotKind
from app.core.config import Settings
from app.documents.models import DocumentRole
from tests.collab_client import eventually, open_document
from tests.conftest import RegisteredUser, register, reset_state
from tests.test_documents import create_doc, grant
from tests.test_storage import snapshots


def versions_url(doc_id: str, suffix: str = "") -> str:
    return f"/api/documents/{doc_id}/versions{suffix}"


def text_of_state(state: str) -> str:
    doc: Doc[Any] = Doc()
    doc.apply_update(base64.b64decode(state))
    return str(doc.get("text", type=Text))


async def owner_and_doc(client: AsyncClient) -> tuple[RegisteredUser, str]:
    alice = await register(client, email="alice@example.com", name="Alice")
    return alice, (await create_doc(client, alice))["id"]


async def write_session(app: FastAPI, user: RegisteredUser, doc_id: str, text: str) -> None:
    """One editing session: connect, type, leave, and wait for the end-of-session checkpoint."""
    async with open_document(app, user, doc_id) as peer:
        await peer.insert(len(str(peer.text)), text)
        await asyncio.sleep(0.05)
    await eventually(lambda: _room_gone(app, doc_id))


async def _room_gone(app: FastAPI, doc_id: str) -> bool:
    return uuid.UUID(doc_id) not in app.state.rooms.rooms


@asynccontextmanager
async def custom_app(
    settings: Settings, **overrides: Any
) -> AsyncIterator[tuple[FastAPI, AsyncClient]]:
    """An app with different settings, and a client that talks to it (the shared `client`
    fixture talks to the default app)."""
    from app.main import create_app

    app = create_app(settings.model_copy(update=overrides))
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver.local") as client,
    ):
        await reset_state(app)
        yield app, client


# ----- listing and reading --------------------------------------------------------------------


async def test_each_editing_session_becomes_an_automatic_version(
    app: FastAPI, client: AsyncClient
) -> None:
    alice, doc_id = await owner_and_doc(client)
    assert (await client.get(versions_url(doc_id), headers=alice.headers)).json() == []

    await write_session(app, alice, doc_id, "First draft")
    await write_session(app, alice, doc_id, " and more")

    versions = (await client.get(versions_url(doc_id), headers=alice.headers)).json()
    assert [v["kind"] for v in versions] == ["auto", "auto"]
    assert versions[0]["created_by"] is None
    newest = await client.get(versions_url(doc_id, f"/{versions[0]['id']}"), headers=alice.headers)
    oldest = await client.get(versions_url(doc_id, f"/{versions[1]['id']}"), headers=alice.headers)
    assert text_of_state(newest.json()["state"]) == "First draft and more"
    assert text_of_state(oldest.json()["state"]) == "First draft"


async def test_versions_are_for_editors_only(app: FastAPI, client: AsyncClient) -> None:
    alice, doc_id = await owner_and_doc(client)
    commenter = await register(client, email="c@example.com", name="Commenter")
    viewer = await register(client, email="v@example.com", name="Viewer")
    outsider = await register(client, email="o@example.com", name="Outsider")
    editor = await register(client, email="e@example.com", name="Editor")
    await grant(app, doc_id, commenter, DocumentRole.COMMENTER)
    await grant(app, doc_id, viewer, DocumentRole.VIEWER)
    await grant(app, doc_id, editor, DocumentRole.EDITOR)

    statuses = {
        user.name: (await client.get(versions_url(doc_id), headers=user.headers)).status_code
        for user in (alice, editor, commenter, viewer, outsider)
    }

    assert statuses == {
        "Alice": 200,
        "Editor": 200,
        "Commenter": 403,
        "Viewer": 403,
        "Outsider": 404,
    }


async def test_unknown_and_internal_snapshots_are_not_versions(
    app: FastAPI, client: AsyncClient
) -> None:
    alice, doc_id = await owner_and_doc(client)
    await write_session(app, alice, doc_id, "text")
    [compaction] = [
        s for s in await snapshots(app, uuid.UUID(doc_id)) if s.kind is SnapshotKind.COMPACTION
    ]
    other_doc = (await create_doc(client, alice, "Other"))["id"]
    await write_session(app, alice, other_doc, "elsewhere")
    [other_version] = (await client.get(versions_url(other_doc), headers=alice.headers)).json()

    for version_id in (compaction.id, uuid.uuid4(), other_version["id"]):
        response = await client.get(versions_url(doc_id, f"/{version_id}"), headers=alice.headers)
        assert response.status_code == 404
        assert response.json()["code"] == "version_not_found"


# ----- named versions -------------------------------------------------------------------------


async def test_saving_a_version_includes_edits_not_yet_written(settings: Settings) -> None:
    # The saver waits a minute, so only the flush before saving can put the text in the version.
    async with custom_app(settings, collab_flush_interval_seconds=60) as (app, client):
        alice, doc_id = await owner_and_doc(client)
        async with open_document(app, alice, doc_id) as peer:
            await peer.insert(0, "Typed a moment ago")
            await asyncio.sleep(0.05)  # reached the server, not yet the database
            saved = await client.post(
                versions_url(doc_id), json={"label": "  Before review  "}, headers=alice.headers
            )
            detail = await client.get(
                versions_url(doc_id, f"/{saved.json()['id']}"), headers=alice.headers
            )

    assert saved.status_code == 201
    body = saved.json()
    assert body["kind"] == "named"
    assert body["label"] == "Before review"
    assert body["created_by"] == {"id": alice.id, "name": "Alice"}
    assert text_of_state(detail.json()["state"]) == "Typed a moment ago"


async def test_naming_and_unnaming_a_version(app: FastAPI, client: AsyncClient) -> None:
    alice, doc_id = await owner_and_doc(client)
    await write_session(app, alice, doc_id, "draft")
    [auto] = (await client.get(versions_url(doc_id), headers=alice.headers)).json()

    named = await client.patch(
        versions_url(doc_id, f"/{auto['id']}"), json={"label": "Sent to Bob"}, headers=alice.headers
    )
    unnamed = await client.patch(
        versions_url(doc_id, f"/{auto['id']}"), json={"label": None}, headers=alice.headers
    )
    blank = await client.patch(
        versions_url(doc_id, f"/{auto['id']}"), json={"label": "   "}, headers=alice.headers
    )

    assert (named.json()["kind"], named.json()["label"]) == ("named", "Sent to Bob")
    assert (unnamed.json()["kind"], unnamed.json()["label"]) == ("auto", None)
    assert blank.status_code == 422


async def test_named_versions_are_capped(settings: Settings) -> None:
    async with custom_app(settings, versions_named_max=2) as (app, client):
        alice, doc_id = await owner_and_doc(client)
        await write_session(app, alice, doc_id, "draft")
        [auto] = (await client.get(versions_url(doc_id), headers=alice.headers)).json()
        for label in ("one", "two"):
            response = await client.post(
                versions_url(doc_id), json={"label": label}, headers=alice.headers
            )
            assert response.status_code == 201

        third = await client.post(versions_url(doc_id), json={"label": "3"}, headers=alice.headers)
        promote = await client.patch(
            versions_url(doc_id, f"/{auto['id']}"), json={"label": "3"}, headers=alice.headers
        )

    assert third.status_code == promote.status_code == 409
    assert third.json()["code"] == "too_many_versions"


async def test_only_the_newest_automatic_versions_are_kept(settings: Settings) -> None:
    async with custom_app(settings, versions_auto_kept=2) as (app, client):
        alice, doc_id = await owner_and_doc(client)
        await write_session(app, alice, doc_id, "a")
        await client.post(versions_url(doc_id), json={"label": "Keep me"}, headers=alice.headers)
        for text in ("b", "c", "d"):
            await write_session(app, alice, doc_id, text)
        versions = (await client.get(versions_url(doc_id), headers=alice.headers)).json()
        newest = await client.get(
            versions_url(doc_id, f"/{versions[0]['id']}"), headers=alice.headers
        )

    assert [(v["kind"], v["label"]) for v in versions] == [
        ("auto", None),
        ("auto", None),
        ("named", "Keep me"),
    ]
    assert text_of_state(newest.json()["state"]) == "abcd"


async def test_long_sessions_get_versions_along_the_way(settings: Settings) -> None:
    async with custom_app(settings, versions_auto_interval_seconds=0) as (app, client):
        alice, doc_id = await owner_and_doc(client)
        async with open_document(app, alice, doc_id) as peer:
            await peer.insert(0, "still typing")
            await eventually(lambda: _has_auto_version(app, doc_id))


async def _has_auto_version(app: FastAPI, doc_id: str) -> bool:
    return any(s.kind is SnapshotKind.AUTO for s in await snapshots(app, uuid.UUID(doc_id)))


# ----- restore --------------------------------------------------------------------------------


async def test_restore_first_saves_the_current_state(app: FastAPI, client: AsyncClient) -> None:
    alice, doc_id = await owner_and_doc(client)
    await write_session(app, alice, doc_id, "good")
    await client.post(versions_url(doc_id), json={"label": "Good one"}, headers=alice.headers)
    await write_session(app, alice, doc_id, " then bad")
    good = next(
        v
        for v in (await client.get(versions_url(doc_id), headers=alice.headers)).json()
        if v["label"] == "Good one"
    )

    prepared = await client.post(
        versions_url(doc_id, f"/{good['id']}/restore"), headers=alice.headers
    )

    assert prepared.status_code == 201
    safety = prepared.json()
    assert safety["kind"] == "pre_restore"
    assert safety["created_by"] == {"id": alice.id, "name": "Alice"}
    assert safety["restored_from"]["id"] == good["id"]
    assert safety["restored_from"]["label"] == "Good one"
    detail = await client.get(versions_url(doc_id, f"/{safety['id']}"), headers=alice.headers)
    assert text_of_state(detail.json()["state"]) == "good then bad"


async def test_restore_needs_a_version_of_this_document(app: FastAPI, client: AsyncClient) -> None:
    alice, doc_id = await owner_and_doc(client)
    viewer = await register(client, email="v@example.com", name="Viewer")
    await grant(app, doc_id, viewer, DocumentRole.VIEWER)
    await write_session(app, alice, doc_id, "text")
    [version] = (await client.get(versions_url(doc_id), headers=alice.headers)).json()

    missing = await client.post(
        versions_url(doc_id, f"/{uuid.uuid4()}/restore"), headers=alice.headers
    )
    by_viewer = await client.post(
        versions_url(doc_id, f"/{version['id']}/restore"), headers=viewer.headers
    )

    assert missing.status_code == 404
    assert by_viewer.status_code == 403
    kinds = [
        v["kind"] for v in (await client.get(versions_url(doc_id), headers=alice.headers)).json()
    ]
    assert kinds == ["auto"]  # neither attempt left a pre-restore version behind


async def test_versions_require_authentication(app: FastAPI) -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as anonymous:
        response = await anonymous.get(versions_url(str(uuid.uuid4())))
    assert response.status_code == 401
