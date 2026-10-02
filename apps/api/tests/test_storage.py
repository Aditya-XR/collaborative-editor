"""The document store: edit log, compaction snapshots and what a load sees (ADR 0003)."""

import asyncio
import random
import uuid
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from pycrdt import Doc, Text, XmlElement, XmlFragment, XmlText, merge_updates
from sqlalchemy import func, insert, select

from app.collab.models import DocumentSnapshot, DocumentUpdate, SnapshotKind
from app.collab.store import PendingUpdate, UpdateStore, _lock_key
from app.collab.text import EDITOR_ROOT, plain_text
from app.core.config import Settings
from app.documents.models import Document, DocumentRole
from tests.collab_client import eventually, open_document
from tests.conftest import register
from tests.test_collab import saved_text, stored_update_count
from tests.test_documents import create_doc, grant


class Writer:
    """Produces Yjs updates the way an editor would, one small edit at a time."""

    def __init__(self, seed: int = 0) -> None:
        self.doc: Doc[Any] = Doc()
        self.text = self.doc.get("text", type=Text)
        self.rng = random.Random(seed)

    def edit(self) -> bytes:
        before = self.doc.get_state()
        current = str(self.text)
        # pycrdt counts positions in UTF-8 bytes (ADR 0012), so character positions are
        # converted; otherwise a delete could cut "é" in half.
        if current and self.rng.random() < 0.3:
            start = self.rng.randrange(len(current))
            offset = len(current[:start].encode())
            del self.text[offset : offset + len(current[start].encode())]
        else:
            position = self.rng.randint(0, len(current))
            self.text.insert(len(current[:position].encode()), self.rng.choice("abcxyz é😀"))
        return self.doc.get_update(before)


def text_of(updates: list[bytes]) -> str:
    doc: Doc[Any] = Doc()
    if updates:
        doc.apply_update(merge_updates(*updates))
    return str(doc.get("text", type=Text))


async def new_document(app: FastAPI, client: AsyncClient) -> uuid.UUID:
    user = await register(client, email=f"{uuid.uuid4().hex[:8]}@example.com")
    return uuid.UUID((await create_doc(client, user))["id"])


async def snapshots(app: FastAPI, document_id: uuid.UUID) -> list[DocumentSnapshot]:
    async with app.state.sessionmaker() as session:
        rows = await session.scalars(
            select(DocumentSnapshot)
            .where(DocumentSnapshot.document_id == document_id)
            .order_by(DocumentSnapshot.created_at)
        )
        return list(rows)


def store(app: FastAPI) -> UpdateStore:
    result: UpdateStore = app.state.rooms.store
    return result


async def append(app: FastAPI, document_id: uuid.UUID, updates: list[bytes]) -> None:
    await store(app).append(document_id, [PendingUpdate(update, None) for update in updates])


# ----- compaction -----------------------------------------------------------------------------


async def test_compaction_folds_the_log_into_one_snapshot(
    app: FastAPI, client: AsyncClient
) -> None:
    document_id = await new_document(app, client)
    writer = Writer()
    await append(app, document_id, [writer.edit() for _ in range(40)])

    folded = await store(app).compact(document_id)

    assert folded == 40
    assert await stored_update_count(app, str(document_id)) == 0
    [base] = await snapshots(app, document_id)
    assert base.kind is SnapshotKind.COMPACTION
    loaded = await store(app).load(document_id)
    assert loaded.log_rows == 0
    assert text_of(loaded.updates) == str(writer.text)


async def test_a_second_compaction_replaces_the_base(app: FastAPI, client: AsyncClient) -> None:
    document_id = await new_document(app, client)
    writer = Writer()
    await append(app, document_id, [writer.edit() for _ in range(10)])
    await store(app).compact(document_id)
    await append(app, document_id, [writer.edit() for _ in range(10)])

    assert await store(app).compact(document_id) == 10
    assert [s.kind for s in await snapshots(app, document_id)] == [SnapshotKind.COMPACTION]
    assert text_of((await store(app).load(document_id)).updates) == str(writer.text)
    assert await store(app).compact(document_id) == 0  # nothing left to fold


async def test_loads_match_a_full_replay_whenever_compaction_runs(
    app: FastAPI, client: AsyncClient
) -> None:
    """Property: however edits and compactions interleave, a load rebuilds exactly the text that
    replaying every edit ever made produces. 40 random schedules, seeded so failures repeat."""
    for seed in range(40):
        rng = random.Random(seed)
        document_id = await new_document(app, client)
        writer = Writer(seed)
        for _ in range(rng.randint(1, 6)):
            await append(app, document_id, [writer.edit() for _ in range(rng.randint(1, 15))])
            if rng.random() < 0.5:
                await store(app).compact(document_id)
            loaded = await store(app).load(document_id)
            assert text_of(loaded.updates) == str(writer.text), f"seed {seed}"


async def test_compaction_never_deletes_an_edit_it_did_not_read(
    app: FastAPI, client: AsyncClient
) -> None:
    """An edit can take a log id before another and commit after it. Compaction must leave it
    alone: deleting "everything up to the highest id read" would erase it unread."""
    document_id = await new_document(app, client)
    writer = Writer()
    first, second = writer.edit(), writer.edit()

    async with app.state.db_engine.connect() as slow:
        transaction = await slow.begin()
        await slow.execute(
            insert(DocumentUpdate).values(document_id=document_id, update=first)
        )  # takes the lower id, not committed yet
        await append(app, document_id, [second])  # higher id, committed

        assert await store(app).compact(document_id) == 1
        await transaction.commit()

    assert await stored_update_count(app, str(document_id)) == 1
    assert text_of((await store(app).load(document_id)).updates) == str(writer.text)


async def test_only_one_compaction_of_a_document_runs_at_a_time(
    app: FastAPI, client: AsyncClient
) -> None:
    document_id = await new_document(app, client)
    await append(app, document_id, [Writer().edit()])

    async with app.state.db_engine.connect() as other_instance:
        transaction = await other_instance.begin()
        await other_instance.execute(select(func.pg_advisory_xact_lock(_lock_key(document_id))))

        assert await store(app).compact(document_id) is None
        await transaction.rollback()

    assert await store(app).compact(document_id) == 1


async def test_compaction_refreshes_search_text_but_not_the_edit_time(
    app: FastAPI, client: AsyncClient
) -> None:
    document_id = await new_document(app, client)
    source: Doc[Any] = Doc()
    body = source.get(EDITOR_ROOT, type=XmlFragment)
    paragraph = body.children.append(XmlElement("paragraph"))
    paragraph.children.append(XmlText("Quarterly roadmap"))
    await append(app, document_id, [source.get_update()])
    async with app.state.sessionmaker() as session:
        edited = (await session.get_one(Document, document_id)).updated_at

    await store(app).compact(document_id)

    async with app.state.sessionmaker() as session:
        document = await session.get_one(Document, document_id)
        assert await session.scalar(select(Document.search_text)) == "Quarterly roadmap"
        assert document.updated_at == edited


# ----- rooms ----------------------------------------------------------------------------------


async def test_a_room_compacts_once_the_log_passes_the_threshold(
    settings: Settings, client: AsyncClient
) -> None:
    from app.main import create_app

    app = create_app(settings.model_copy(update={"collab_compaction_threshold": 5}))
    async with app.router.lifespan_context(app):
        alice = await register(client, email="threshold@example.com")
        doc = await create_doc(client, alice)
        async with open_document(app, alice, doc["id"]) as peer:
            for i in range(12):
                await peer.insert(i, "x")
                await asyncio.sleep(0.03)  # separate saves, so the log really grows
            await eventually(
                lambda: _has_compaction_base(app, uuid.UUID(doc["id"])),
            )
            assert await stored_update_count(app, doc["id"]) < 12
        assert await saved_text(app, doc["id"]) == "x" * 12


async def _has_compaction_base(app: FastAPI, document_id: uuid.UUID) -> bool:
    return any(s.kind is SnapshotKind.COMPACTION for s in await snapshots(app, document_id))


async def test_an_editing_session_ends_with_a_checkpoint(app: FastAPI, client: AsyncClient) -> None:
    """When the last editor leaves, the log is folded and the session becomes a version."""
    alice = await register(client, email="alice@example.com", name="Alice")
    bob = await register(client, email="bob@example.com", name="Bob")
    doc = await create_doc(client, alice)
    await grant(app, doc["id"], bob, DocumentRole.EDITOR)
    document_id = uuid.UUID(doc["id"])

    async with open_document(app, alice, doc["id"]) as a, open_document(app, bob, doc["id"]):
        await a.insert(0, "Session one")
        await eventually(lambda: _has_rows(app, doc["id"]))

    await eventually(lambda: _room_gone(app, document_id))
    kinds = sorted(s.kind.value for s in await snapshots(app, document_id))
    assert kinds == ["auto", "compaction"]
    assert await stored_update_count(app, doc["id"]) == 0
    assert await saved_text(app, doc["id"]) == "Session one"


async def test_a_session_without_edits_leaves_no_version(app: FastAPI, client: AsyncClient) -> None:
    alice = await register(client, email="alice@example.com", name="Alice")
    doc = await create_doc(client, alice)

    async with open_document(app, alice, doc["id"]):
        pass

    await eventually(lambda: _room_gone(app, uuid.UUID(doc["id"])))
    assert await snapshots(app, uuid.UUID(doc["id"])) == []


async def _has_rows(app: FastAPI, doc_id: str) -> bool:
    return await stored_update_count(app, doc_id) > 0


async def _room_gone(app: FastAPI, document_id: uuid.UUID) -> bool:
    return document_id not in app.state.rooms.rooms


# ----- text for search ------------------------------------------------------------------------


def test_plain_text_keeps_words_and_drops_formatting() -> None:
    doc: Doc[Any] = Doc()
    body = doc.get(EDITOR_ROOT, type=XmlFragment)
    heading = body.children.append(XmlElement("heading", {"level": "1"}))
    heading.children.append(XmlText("Launch plan 😀"))
    paragraph = body.children.append(XmlElement("paragraph"))
    text = paragraph.children.append(XmlText("Ship "))
    text.insert(len(text), "on time", {"bold": {}})
    text.insert(len(text), " with\x00care\x02")
    items = body.children.append(XmlElement("bulletList"))
    item = items.children.append(XmlElement("listItem"))
    item.children.append(XmlElement("paragraph")).children.append(XmlText("Café menu"))
    body.children.append(XmlElement("paragraph"))  # an empty line adds nothing

    assert plain_text(doc) == "Launch plan 😀\nShip on time with care \nCafé menu"


def test_plain_text_of_a_document_never_opened_in_the_editor_is_empty() -> None:
    doc: Doc[Any] = Doc()
    doc.get("text", type=Text).insert(0, "not the editor's root")

    assert plain_text(doc) == ""
