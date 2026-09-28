import asyncio
import random
import uuid
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from pycrdt import Text
from sqlalchemy import func, select, text

from app.collab.models import DocumentUpdate
from app.collab.room import CloseCode, Room
from app.core.config import Settings
from app.documents.models import DocumentRole
from tests.collab_client import Peer, connect, eventually, open_document, ticket_for
from tests.conftest import RegisteredUser, register
from tests.test_documents import create_doc, grant


async def editor_pair(
    client: AsyncClient, app: FastAPI
) -> tuple[RegisteredUser, RegisteredUser, str]:
    alice = await register(client, email="alice@example.com", name="Alice")
    bob = await register(client, email="bob@example.com", name="Bob")
    doc = await create_doc(client, alice)
    await grant(app, doc["id"], bob, DocumentRole.EDITOR)
    return alice, bob, doc["id"]


async def stored_update_count(app: FastAPI, document_id: str) -> int:
    async with app.state.sessionmaker() as session:
        count = await session.scalar(
            select(func.count()).where(DocumentUpdate.document_id == uuid.UUID(document_id))
        )
    return int(count or 0)


# ----- tickets ------------------------------------------------------------------------------


async def test_ticket_requires_access_to_the_document(app: FastAPI, client: AsyncClient) -> None:
    alice, bob, _ = await editor_pair(client, app)
    private = await create_doc(client, alice, "Private")

    unauthenticated = await client.post("/api/collab/tickets", json={"document_id": private["id"]})
    outsider = await client.post(
        "/api/collab/tickets", json={"document_id": private["id"]}, headers=bob.headers
    )
    owner = await client.post(
        "/api/collab/tickets", json={"document_id": private["id"]}, headers=alice.headers
    )

    assert unauthenticated.status_code == 401
    assert outsider.status_code == 404
    assert owner.status_code == 201
    assert owner.json()["role"] == "owner"
    assert owner.json()["expires_in"] == 30
    assert len(owner.json()["ticket"]) >= 32


async def test_missing_invalid_and_reused_tickets_are_refused(
    app: FastAPI, client: AsyncClient
) -> None:
    alice, _, doc_id = await editor_pair(client, app)

    async with connect(app, doc_id, "") as peer:
        assert await peer.closed_with() == CloseCode.INVALID_TICKET
    async with connect(app, doc_id, "made-up-ticket") as peer:
        assert await peer.closed_with() == CloseCode.INVALID_TICKET

    ticket = await ticket_for(app, alice, doc_id)
    async with connect(app, doc_id, ticket) as peer:
        await peer.sync()
    async with connect(app, doc_id, ticket) as peer:  # the same ticket, a second time
        assert await peer.closed_with() == CloseCode.INVALID_TICKET


async def test_ticket_only_opens_the_document_it_was_issued_for(
    app: FastAPI, client: AsyncClient
) -> None:
    alice, _, doc_id = await editor_pair(client, app)
    other = await create_doc(client, alice, "Other")

    ticket = await ticket_for(app, alice, other["id"])
    async with connect(app, doc_id, ticket) as peer:
        assert await peer.closed_with() == CloseCode.INVALID_TICKET


# ----- live editing -------------------------------------------------------------------------


async def test_edits_reach_every_other_editor(app: FastAPI, client: AsyncClient) -> None:
    alice, bob, doc_id = await editor_pair(client, app)

    async with open_document(app, alice, doc_id) as a, open_document(app, bob, doc_id) as b:
        await a.insert(0, "Hello")
        await b.until(lambda: str(b.text) == "Hello")

        await b.insert(5, ", world")
        await a.until(lambda: str(a.text) == "Hello, world")


async def test_late_joiner_receives_the_whole_document(app: FastAPI, client: AsyncClient) -> None:
    alice, bob, doc_id = await editor_pair(client, app)

    async with open_document(app, alice, doc_id) as a:
        await a.insert(0, "Written before Bob arrived")
        async with open_document(app, bob, doc_id) as b:
            assert str(b.text) == "Written before Bob arrived"


async def test_edits_survive_everyone_leaving(app: FastAPI, client: AsyncClient) -> None:
    alice, bob, doc_id = await editor_pair(client, app)
    before = (await client.get(f"/api/documents/{doc_id}", headers=alice.headers)).json()

    async with open_document(app, alice, doc_id) as a:
        await a.insert(0, "Saved to Postgres")
        await eventually(lambda: _has_rows(app, doc_id))

    await eventually(lambda: _room_gone(app, doc_id))
    async with open_document(app, bob, doc_id) as b:
        assert str(b.text) == "Saved to Postgres"

    after = (await client.get(f"/api/documents/{doc_id}", headers=alice.headers)).json()
    assert after["updated_at"] > before["updated_at"]


async def _has_rows(app: FastAPI, doc_id: str) -> bool:
    return await stored_update_count(app, doc_id) > 0


async def _room_gone(app: FastAPI, doc_id: str) -> bool:
    return uuid.UUID(doc_id) not in app.state.rooms.rooms


async def test_offline_edits_merge_on_reconnect(app: FastAPI, client: AsyncClient) -> None:
    alice, bob, doc_id = await editor_pair(client, app)

    async with open_document(app, alice, doc_id) as a:
        await a.insert(0, "base")
        offline_doc = None
        async with open_document(app, bob, doc_id) as b:
            await b.until(lambda: str(b.text) == "base")
            offline_doc = b.doc.get_update()

        # Bob is offline now; both sides keep writing.
        await a.insert(4, " +alice")
        async with open_document(app, bob, doc_id, sync=False) as b:
            b.doc.apply_update(offline_doc)
            b.text.insert(0, "bob+ ")  # made while offline, sent in the reconnect handshake
            await b.sync()
            await a.until(lambda: str(a.text) == str(b.text))
            assert str(b.text) == "bob+ base +alice"


async def test_readers_can_follow_but_not_edit(app: FastAPI, client: AsyncClient) -> None:
    alice, _, doc_id = await editor_pair(client, app)
    carol = await register(client, email="carol@example.com", name="Carol")
    await grant(app, doc_id, carol, DocumentRole.VIEWER)

    async with open_document(app, alice, doc_id) as a, open_document(app, carol, doc_id) as c:
        await a.insert(0, "Read me")
        await c.until(lambda: str(c.text) == "Read me")

        await c.insert(0, "Vandalism! ")
        await a.insert(7, ".")  # a later edit proves the viewer's change was never relayed
        await c.until(lambda: str(c.text).endswith("."))
        await asyncio.sleep(0.1)
        room = app.state.rooms.rooms[uuid.UUID(doc_id)]
        assert str(room.doc.get("text", type=Text)) == "Read me."
        assert str(a.text) == "Read me."


async def test_many_concurrent_editors_converge(app: FastAPI, client: AsyncClient) -> None:
    owner = await register(client, email="owner@example.com", name="Owner")
    doc = await create_doc(client, owner)
    users = [owner]
    for i in range(3):
        user = await register(client, email=f"writer{i}@example.com", name=f"Writer {i}")
        await grant(app, doc["id"], user, DocumentRole.EDITOR)
        users.append(user)
    rng = random.Random(20260928)

    async with (
        open_document(app, users[0], doc["id"]) as p0,
        open_document(app, users[1], doc["id"]) as p1,
        open_document(app, users[2], doc["id"]) as p2,
        open_document(app, users[3], doc["id"]) as p3,
    ):
        peers = [p0, p1, p2, p3]
        for _ in range(60):
            peer = rng.choice(peers)
            length = len(str(peer.text))
            if length and rng.random() < 0.3:
                start = rng.randrange(length)
                span = min(rng.randint(1, 3), length - start)
                await peer.delete(start, span)
            else:
                await peer.insert(rng.randint(0, length), rng.choice("abcdef "))
            if rng.random() < 0.3:  # let some messages arrive mid-stream, not all at the end
                await rng.choice(peers).handle_next(timeout=0.5)

        room = app.state.rooms.rooms[uuid.UUID(doc["id"])]
        for peer in peers:
            await peer.until(_matches(peer, room), timeout=5)
        assert len({str(p.text) for p in peers}) == 1


def _matches(peer: Peer, room: Room) -> Callable[[], bool]:
    # Re-read on every poll: edits may still be in flight to the server itself.
    return lambda: str(peer.text) == str(room.doc.get("text", type=Text))


# ----- presence -----------------------------------------------------------------------------


async def test_presence_is_relayed_with_the_real_name_and_removed_on_leave(
    app: FastAPI, client: AsyncClient
) -> None:
    alice, bob, doc_id = await editor_pair(client, app)

    async with open_document(app, bob, doc_id) as b:
        async with open_document(app, alice, doc_id) as a:
            # Alice's client claims to be someone else; the server stamps her real name.
            await a.set_presence({"user": {"name": "Mallory", "color": "#f00"}, "cursor": 3})
            await b.until(lambda: a.doc.client_id in b.awareness)
            state: Any = b.awareness[a.doc.client_id]
            assert state["user"] == {"name": "Alice", "color": "#f00", "id": alice.id}
            assert state["cursor"] == 3

        await b.until(lambda: b.awareness.get(a.doc.client_id, "present") is None)


async def test_presence_carries_non_ascii_names_intact(app: FastAPI, client: AsyncClient) -> None:
    josé = await register(client, email="jose@example.com", name="José Ñúñez 😀")
    doc = await create_doc(client, josé)
    viewer = await register(client, email="v@example.com", name="Viewer")
    await grant(app, doc["id"], viewer, DocumentRole.VIEWER)

    async with open_document(app, viewer, doc["id"]) as v, open_document(app, josé, doc["id"]) as j:
        await j.set_presence({"user": {"color": "#0a0"}, "note": "naïve café"})
        await v.until(lambda: j.doc.client_id in v.awareness)
        state: Any = v.awareness[j.doc.client_id]
        assert state["user"]["name"] == "José Ñúñez 😀"
        assert state["note"] == "naïve café"


async def test_late_joiner_sees_existing_cursors(app: FastAPI, client: AsyncClient) -> None:
    alice, bob, doc_id = await editor_pair(client, app)

    async with open_document(app, alice, doc_id) as a:
        await a.set_presence({"cursor": 1})
        await asyncio.sleep(0.05)
        async with open_document(app, bob, doc_id) as b:
            await b.until(lambda: a.doc.client_id in b.awareness)


# ----- protection ---------------------------------------------------------------------------


async def test_malformed_messages_close_the_connection(app: FastAPI, client: AsyncClient) -> None:
    alice, _, doc_id = await editor_pair(client, app)

    for bad in [b"\x07junk", b"\x00\x02\x05garbage-not-an-update", b"\x01\x05\x01"]:
        async with open_document(app, alice, doc_id) as peer:
            await peer.ws.send_bytes(bad)
            assert await peer.closed_with() == CloseCode.BAD_MESSAGE, bad


async def test_text_frames_are_refused(app: FastAPI, client: AsyncClient) -> None:
    alice, _, doc_id = await editor_pair(client, app)

    async with open_document(app, alice, doc_id) as peer:
        await peer.ws.send_text("hello")
        assert await peer.closed_with() == CloseCode.BAD_MESSAGE


async def test_trashing_a_document_disconnects_its_editors(
    app: FastAPI, client: AsyncClient
) -> None:
    alice, bob, doc_id = await editor_pair(client, app)

    async with open_document(app, bob, doc_id) as b:
        response = await client.delete(f"/api/documents/{doc_id}", headers=alice.headers)
        assert response.status_code == 204
        assert await b.closed_with() == CloseCode.NOT_FOUND


async def test_shutdown_saves_open_documents(settings: Settings, client: AsyncClient) -> None:
    from app.main import create_app  # a second app, so this test controls its lifespan

    # Long delays: without the shutdown flush nothing would be saved in time.
    slow = settings.model_copy(
        update={"collab_flush_interval_seconds": 60, "collab_room_grace_seconds": 60}
    )
    app = create_app(slow)
    async with app.router.lifespan_context(app):
        alice = await register(client, email="shutdown@example.com")
        doc = await create_doc(client, alice)
        async with open_document(app, alice, doc["id"]) as peer:
            await peer.insert(0, "unsaved")
            await asyncio.sleep(0.05)
        assert await stored_update_count(app, doc["id"]) == 0
    # Lifespan exit ran RoomManager.shutdown(); check through a fresh connection.
    async with app.router.lifespan_context(app):
        assert await stored_update_count(app, doc["id"]) == 1


async def test_unused_rooms_keep_no_rows(app: FastAPI, client: AsyncClient) -> None:
    alice, _, doc_id = await editor_pair(client, app)

    async with open_document(app, alice, doc_id):
        pass

    async with app.state.db_engine.connect() as conn:
        rows = (await conn.execute(text("SELECT count(*) FROM document_updates"))).scalar_one()
    assert rows == 0


async def test_room_loads_a_log_stored_out_of_order(app: FastAPI, client: AsyncClient) -> None:
    from pycrdt import Doc as YDoc

    alice, _, doc_id = await editor_pair(client, app)
    source: YDoc[Any] = YDoc()
    source_text = source.get("text", type=Text)
    updates = []
    for i in range(6):
        before = source.get_state()
        source_text.insert(0 if i < 5 else 5, "a")
        updates.append(source.get_update(before))
    async with app.state.sessionmaker() as session:
        session.add_all(
            DocumentUpdate(document_id=uuid.UUID(doc_id), update=updates[i], user_id=None)
            for i in (0, 1, 2, 4, 5, 3)  # an order yrs cannot replay one by one
        )
        await session.commit()

    async with open_document(app, alice, doc_id) as peer:
        assert str(peer.text) == "aaaaaa"
