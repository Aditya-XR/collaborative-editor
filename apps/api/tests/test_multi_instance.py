"""Two API instances sharing one Postgres and one Redis, as behind a load balancer (ADR 0004).

Every test runs two real apps in this process. Clients connect to one or the other; anything one
of them sees, the other must see too.
"""

import asyncio
import random
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pycrdt import Text
from sqlalchemy import func, select

from app.collab import room as room_module
from app.collab.bus import Kind
from app.collab.models import DocumentUpdate
from app.collab.room import CloseCode, Room
from app.core.config import Settings
from app.documents.models import DocumentRole
from app.main import create_app
from tests.collab_client import Peer, eventually, open_document
from tests.conftest import RegisteredUser, register, reset_state
from tests.test_documents import create_doc, grant


@asynccontextmanager
async def instance(settings: Settings) -> AsyncIterator[FastAPI]:
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        await asyncio.wait_for(app.state.rooms.bus.check(), 5)
        yield app


@asynccontextmanager
async def cluster(settings: Settings, **overrides: Any) -> AsyncIterator[tuple[FastAPI, FastAPI]]:
    configured = settings.model_copy(update=overrides)
    async with instance(configured) as one, instance(configured) as two:
        await reset_state(one)
        yield one, two


@asynccontextmanager
async def rest(app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test.local") as c:
        yield c


async def shared_doc(
    one: FastAPI, client: AsyncClient, *editors: str
) -> tuple[RegisteredUser, list[RegisteredUser], str]:
    """An owner's document, with each named person added as an editor."""
    owner = await register(client, email="owner@example.com", name="Owner")
    doc_id = (await create_doc(client, owner))["id"]
    people = []
    for name in editors:
        person = await register(client, email=f"{name.lower()}@example.com", name=name)
        await grant(one, doc_id, person, DocumentRole.EDITOR)
        people.append(person)
    return owner, people, doc_id


def room_of(app: FastAPI, stream_id: str) -> Room:
    room: Room = app.state.rooms.rooms[uuid.UUID(stream_id)]
    return room


async def saved_rows(app: FastAPI, doc_id: str) -> int:
    async with app.state.sessionmaker() as session:
        count = await session.scalar(
            select(func.count()).where(DocumentUpdate.document_id == uuid.UUID(doc_id))
        )
    return count or 0


# ----- edits ------------------------------------------------------------------------------------


async def test_edits_cross_instances_and_are_saved_once(settings: Settings) -> None:
    async with cluster(settings) as (one, two), rest(one) as client:
        owner, [bea], doc_id = await shared_doc(one, client, "Bea")

        async with open_document(one, owner, doc_id) as a, open_document(two, bea, doc_id) as b:
            await a.insert(0, "Hello")
            await b.until(lambda: str(b.text) == "Hello")
            await b.insert(5, " world")
            await a.until(lambda: str(a.text) == "Hello world")
            # The instance that received an edit saved it; the other only relayed it. (Counted
            # while connected: closing a room folds the log into a snapshot.)
            await eventually(lambda: _rows_are(one, doc_id, 2))
            await asyncio.sleep(0.1)
            assert await saved_rows(one, doc_id) == 2


async def _rows_are(app: FastAPI, doc_id: str, expected: int) -> bool:
    return await saved_rows(app, doc_id) == expected


async def test_a_room_opened_later_gets_edits_not_saved_yet(settings: Settings) -> None:
    # Nothing is saved during the test: the edits exist only in instance one's memory.
    async with (
        cluster(settings, collab_flush_interval_seconds=60, collab_flush_max_updates=1000) as (
            one,
            two,
        ),
        rest(one) as client,
    ):
        owner, [bea], doc_id = await shared_doc(one, client, "Bea")

        async with open_document(one, owner, doc_id) as a:
            await a.insert(0, "typed a moment ago")
            await eventually(lambda: _room_has(one, doc_id, "typed a moment ago"))
            assert await saved_rows(one, doc_id) == 0

            # Instance two loads the document from Postgres, which has none of it, and gets the
            # rest from instance one in reply to its HELLO.
            async with open_document(two, bea, doc_id) as b:
                await b.until(lambda: str(b.text) == "typed a moment ago")


async def _room_has(app: FastAPI, doc_id: str, text: str) -> bool:
    room = app.state.rooms.rooms.get(uuid.UUID(doc_id))
    return room is not None and str(room.doc.get("text", type=Text)) == text


async def test_edits_are_batched_into_few_publishes(settings: Settings) -> None:
    async with cluster(settings) as (one, two), rest(one) as client:
        owner, [bea], doc_id = await shared_doc(one, client, "Bea")

        async with open_document(one, owner, doc_id) as a, open_document(two, bea, doc_id) as b:
            room = room_of(one, doc_id)
            # Measured once instance one knows instance two is there (before, it keeps edits to
            # itself, and instance two gets them in the reply to its HELLO).
            await eventually(lambda: _alone(room, False))
            for i in range(50):
                await a.insert(i, "x")
            await b.until(lambda: str(b.text) == "x" * 50)
            assert room.updates_out == 50
            # One message per 50 ms window, not one per keystroke.
            assert room.publishes < 10, room.publishes


@pytest.mark.parametrize("seed", range(5))
async def test_random_edits_on_both_instances_converge(settings: Settings, seed: int) -> None:
    async with cluster(settings) as (one, two), rest(one) as client:
        owner, people, doc_id = await shared_doc(one, client, "Bea", "Cal", "Dee")
        rng = random.Random(20261011 + seed)

        async with (
            open_document(one, owner, doc_id) as p0,
            open_document(two, people[0], doc_id) as p1,
            open_document(one, people[1], doc_id) as p2,
            open_document(two, people[2], doc_id) as p3,
        ):
            peers = [p0, p1, p2, p3]
            for _ in range(80):
                peer = rng.choice(peers)
                length = len(str(peer.text))
                if length and rng.random() < 0.3:
                    start = rng.randrange(length)
                    await peer.delete(start, min(rng.randint(1, 3), length - start))
                else:
                    await peer.insert(rng.randint(0, length), rng.choice("abcdef "))
                if rng.random() < 0.3:
                    await rng.choice(peers).handle_next(timeout=0.5)

            rooms = {one: room_of(one, doc_id), two: room_of(two, doc_id)}
            await eventually(lambda: _rooms_agree(*rooms.values()), timeout=5)
            for peer, app in zip(peers, [one, two, one, two], strict=True):
                await peer.until(_matches(peer, rooms[app]), timeout=5)
            assert len({str(peer.text) for peer in peers}) == 1


async def _rooms_agree(*rooms: Room) -> bool:
    return len({str(room.doc.get("text", type=Text)) for room in rooms}) == 1


def _matches(peer: Peer, room: Room) -> Callable[[], bool]:
    return lambda: str(peer.text) == str(room.doc.get("text", type=Text))


async def test_a_lone_instance_keeps_edits_off_redis_until_another_opens_the_document(
    settings: Settings,
) -> None:
    async with cluster(settings) as (one, two), rest(one) as client:
        owner, [bea], doc_id = await shared_doc(one, client, "Bea")

        async with open_document(one, owner, doc_id) as a:
            room = room_of(one, doc_id)
            await eventually(lambda: _alone(room, True))
            await a.insert(0, "only here")
            await eventually(lambda: _room_has(one, doc_id, "only here"))
            assert room.publishes == 0  # nobody else to tell

            async with open_document(two, bea, doc_id) as b:
                # The newcomer's HELLO brings it everything, and wakes instance one up.
                await b.until(lambda: str(b.text) == "only here")
                await eventually(lambda: _alone(room, False))
                await a.insert(9, ", then there")
                await b.until(lambda: str(b.text) == "only here, then there")
                assert room.publishes >= 1

            # Instance two closed its room: the next message reaches nobody, and that is the last.
            await eventually(lambda: _gone(two, doc_id))
            await a.insert(0, ">")
            await eventually(lambda: _alone(room, True))
            published = room.publishes
            await a.insert(0, ">")
            await asyncio.sleep(0.2)
            assert room.publishes == published


async def _alone(room: Room, expected: bool) -> bool:
    return room.alone is expected


async def _gone(app: FastAPI, stream_id: str) -> bool:
    return uuid.UUID(stream_id) not in app.state.rooms.rooms


# ----- presence ---------------------------------------------------------------------------------


async def test_cursors_cross_instances_with_the_real_name(settings: Settings) -> None:
    async with cluster(settings) as (one, two), rest(one) as client:
        owner, [bea, cal], doc_id = await shared_doc(one, client, "Bea", "Cal")

        async with open_document(one, owner, doc_id) as a:
            await a.set_presence({"user": {"name": "Mallory", "color": "#f00"}})
            await eventually(lambda: _has_cursor(one, doc_id))

            # Instance two opens the document only now; the cursor comes with instance one's reply.
            async with open_document(two, bea, doc_id) as b:
                await b.until(lambda: a.doc.client_id in b.awareness)
                state: Any = b.awareness[a.doc.client_id]
                assert state["user"]["name"] == "Owner"

                # A newcomer on the same instance gets it from that instance's own copy.
                async with open_document(two, cal, doc_id) as c:
                    await c.until(lambda: a.doc.client_id in c.awareness)

                await a.set_presence(None)
                await b.until(lambda: b.awareness.get(a.doc.client_id, "present") is None)


async def _has_cursor(app: FastAPI, doc_id: str) -> bool:
    room = app.state.rooms.rooms.get(uuid.UUID(doc_id))
    return room is not None and bool(room.local_awareness())


# ----- events -----------------------------------------------------------------------------------


async def test_access_changes_disconnect_people_on_every_instance(settings: Settings) -> None:
    async with cluster(settings) as (one, two), rest(one) as client:
        owner, [bea, cal], doc_id = await shared_doc(one, client, "Bea", "Cal")

        async with open_document(two, bea, doc_id) as b:
            response = await client.patch(
                f"/api/documents/{doc_id}/members/{bea.id}",
                json={"role": "viewer"},
                headers=owner.headers,
            )
            assert response.status_code == 204
            assert await b.closed_with() == CloseCode.ROLE_CHANGED

        async with open_document(two, cal, doc_id) as c:
            await client.delete(f"/api/documents/{doc_id}", headers=owner.headers)
            assert await c.closed_with() == CloseCode.NOT_FOUND


async def test_comment_changes_reach_every_instance(settings: Settings) -> None:
    async with cluster(settings) as (one, two), rest(one) as client:
        owner, [bea], doc_id = await shared_doc(one, client, "Bea")

        async with open_document(two, bea, doc_id) as b:
            response = await client.post(
                f"/api/documents/{doc_id}/threads",
                json={"anchor_start": "AQI=", "anchor_end": "AQM=", "quoted_text": "", "body": "?"},
                headers=owner.headers,
            )
            assert response.status_code == 201
            await b.until(lambda: b.comment_signals == 1)


async def test_a_merge_reaches_editors_on_another_instance(settings: Settings) -> None:
    async with cluster(settings) as (one, two), rest(one) as client:
        owner, [bea], doc_id = await shared_doc(one, client, "Bea")
        branches = f"/api/documents/{doc_id}/branches"
        branch = (await client.post(branches, json={"name": "Draft"}, headers=owner.headers)).json()

        async with (
            open_document(two, bea, doc_id) as main,
            open_document(two, bea, doc_id, branch_id=branch["id"]) as fork,
        ):
            await fork.write_paragraphs("Written on the branch")
            await eventually(lambda: _branch_saved(one, doc_id))

            # Merged through instance one, where neither stream is open.
            review = (
                await client.get(f"{branches}/{branch['id']}/review", headers=owner.headers)
            ).json()
            merged = await client.post(
                f"{branches}/{branch['id']}/merge",
                json={"head": review["head"]},
                headers=owner.headers,
            )
            assert merged.status_code == 200, merged.text

            await main.until(lambda: main.paragraphs() == ["Written on the branch"])
            # The branch is read-only now: its editors reconnect with a read-only ticket.
            assert await fork.closed_with() == CloseCode.ROLE_CHANGED


async def _branch_saved(app: FastAPI, doc_id: str) -> bool:
    return await saved_rows(app, doc_id) >= 1


async def test_a_merge_freezes_the_branch_on_every_instance(settings: Settings) -> None:
    async with cluster(settings) as (one, two), rest(one) as client:
        owner, [bea], doc_id = await shared_doc(one, client, "Bea")
        branches = f"/api/documents/{doc_id}/branches"
        branch = (await client.post(branches, json={"name": "Draft"}, headers=owner.headers)).json()

        async with open_document(two, bea, doc_id, branch_id=branch["id"]):
            fork = room_of(two, branch["id"])
            await one.state.rooms.set_frozen(uuid.UUID(branch["id"]), True)
            await eventually(lambda: _accepting(fork, False))
            await one.state.rooms.set_frozen(uuid.UUID(branch["id"]), False)
            await eventually(lambda: _accepting(fork, True))


async def _accepting(room: Room, expected: bool) -> bool:
    return room.accepting_edits is expected


# ----- failures ---------------------------------------------------------------------------------


async def test_a_dropped_subscription_catches_up(settings: Settings) -> None:
    async with (
        cluster(settings, collab_bus_reconnect_seconds=0.5) as (one, two),
        rest(one) as client,
    ):
        owner, [bea], doc_id = await shared_doc(one, client, "Bea")

        async with open_document(one, owner, doc_id) as a, open_document(two, bea, doc_id) as b:
            await a.insert(0, "before ")
            await b.until(lambda: str(b.text) == "before ")

            # Cut instance two off from Redis, and edit while it cannot hear.
            bus = two.state.rooms.bus
            await one.state.redis.execute_command(
                "CLIENT",
                "KILL",
                "ID",
                await _client_id(one, f"collab-bus-{bus.instance_id.hex[:12]}"),
            )
            await eventually(lambda: _disconnected(bus))
            await a.insert(7, "during")
            await asyncio.sleep(0.2)  # published and gone while instance two was away
            assert str(b.text) == "before "

            await b.until(lambda: str(b.text) == "before during", timeout=5)
            assert bus.reconnects == 1


async def _client_id(app: FastAPI, name: str) -> str:
    listing: bytes = await app.state.redis.execute_command("CLIENT", "LIST", "TYPE", "pubsub")
    for line in listing.decode().splitlines():
        fields = dict(part.split("=", 1) for part in line.split() if "=" in part)
        if fields.get("name") == name:
            return fields["id"]
    raise AssertionError(f"no pub/sub client named {name}")


async def _disconnected(bus: Any) -> bool:
    return not bus.connected


async def test_failed_publishes_are_retried(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(room_module, "PUBLISH_RETRY_SECONDS", 0.05)
    async with cluster(settings) as (one, two), rest(one) as client:
        owner, [bea], doc_id = await shared_doc(one, client, "Bea")

        async with open_document(one, owner, doc_id) as a, open_document(two, bea, doc_id) as b:
            await eventually(lambda: _alone(room_of(one, doc_id), False))
            bus = one.state.rooms.bus
            real_publish = bus.publish
            failures = 3

            async def flaky(channel: str, message: bytes) -> int | None:
                nonlocal failures
                if failures:
                    failures -= 1
                    return None
                result: int | None = await real_publish(channel, message)
                return result

            monkeypatch.setattr(bus, "publish", flaky)
            await a.insert(0, "kept")
            await a.insert(4, " in order")

            await b.until(lambda: str(b.text) == "kept in order", timeout=5)
            assert failures == 0


async def test_a_lost_reply_to_hello_is_sent_again(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(room_module, "PUBLISH_RETRY_SECONDS", 0.05)
    async with (
        cluster(settings, collab_flush_interval_seconds=60, collab_flush_max_updates=1000) as (
            one,
            two,
        ),
        rest(one) as client,
    ):
        owner, [bea], doc_id = await shared_doc(one, client, "Bea")

        async with open_document(one, owner, doc_id) as a:
            await a.insert(0, "unsaved")
            await eventually(lambda: _room_has(one, doc_id, "unsaved"))
            bus = one.state.rooms.bus
            real_publish = bus.publish
            dropped: list[str] = []

            async def drop_first_diff(channel: str, message: bytes) -> int | None:
                if message[17] == Kind.DIFF and not dropped:
                    dropped.append(channel)
                    return None
                result: int | None = await real_publish(channel, message)
                return result

            monkeypatch.setattr(bus, "publish", drop_first_diff)
            async with open_document(two, bea, doc_id) as b:
                await b.until(lambda: str(b.text) == "unsaved")
            assert dropped
