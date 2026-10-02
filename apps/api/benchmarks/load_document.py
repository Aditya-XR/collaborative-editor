"""How long opening a document takes, before and after its edit log is compacted.

Simulates one writer typing a document keystroke by keystroke (with some backspacing), stores
every keystroke as its own log row the way the sync server does, then times what opening the
document costs the server: reading from Postgres and building the in-memory Yjs doc.

    cd apps/api
    uv run python -m benchmarks.load_document            # 10,000 keystrokes
    uv run python -m benchmarks.load_document --edits 50000

Needs the local Postgres from infra/docker-compose.yml with migrations applied. It creates one
throwaway user and document and deletes them afterwards.
"""

import argparse
import asyncio
import random
import statistics
import time
import uuid
from typing import Any

from pycrdt import Doc, Text, merge_updates
from sqlalchemy import delete, func, insert, select

from app.auth.models import User
from app.collab.models import DocumentSnapshot, DocumentUpdate
from app.collab.store import PendingUpdate, UpdateStore
from app.core.config import Settings
from app.core.db import create_engine, create_sessionmaker
from app.core.ids import uuid7
from app.documents.models import Document

WORDS = "the quick brown fox jumps over a lazy dog while editors type together".split()


def keystrokes(count: int, seed: int = 7) -> tuple[list[bytes], str]:
    rng = random.Random(seed)
    doc: Doc[Any] = Doc()
    text = doc.get("text", type=Text)
    updates: list[bytes] = []
    # What the browser sends: one update per transaction, holding only that transaction's
    # change. (A diff against a state vector would also repeat every earlier deletion.)
    doc.observe(lambda event: updates.append(event.update))
    typed = ""
    for _ in range(count):
        if typed and rng.random() < 0.15:
            del text[len(typed.encode()) - 1 :]  # backspace (ASCII only, so bytes == chars)
            typed = typed[:-1]
        else:
            char = rng.choice(" " + rng.choice(WORDS))
            text.insert(len(typed), char)
            typed += char
    return updates, typed


async def time_loads(store: UpdateStore, document_id: uuid.UUID, rounds: int) -> float:
    """Median milliseconds to do what RoomManager.acquire does: load, merge, apply."""
    samples = []
    for _ in range(rounds):
        start = time.perf_counter()
        stored = await store.load(document_id)
        doc: Doc[Any] = Doc()
        doc.apply_update(merge_updates(*stored.updates))
        samples.append((time.perf_counter() - start) * 1000)
    return statistics.median(samples)


async def main(edits: int, rounds: int) -> None:
    settings = Settings()
    engine = create_engine(settings.database_url)
    sessionmaker = create_sessionmaker(engine)
    store = UpdateStore(sessionmaker)
    user_id, document_id = uuid7(), uuid7()
    # The last 500 keystrokes arrive after the first compaction: the steady-state case, since
    # rooms compact whenever the log reaches 500 rows.
    all_updates, typed = keystrokes(edits + 500)
    updates, later = all_updates[:edits], all_updates[edits:]

    async with sessionmaker() as session, session.begin():
        session.add(User(id=user_id, email=f"bench-{user_id}@example.com", name="Benchmark"))
        await session.flush()
        session.add(Document(id=document_id, owner_id=user_id, title="Benchmark"))
        await session.flush()
        for start in range(0, len(updates), 5000):
            await session.execute(
                insert(DocumentUpdate),
                [
                    {"document_id": document_id, "update": update, "user_id": user_id}
                    for update in updates[start : start + 5000]
                ],
            )
    try:
        async with sessionmaker() as session:
            log_bytes = await session.scalar(
                select(func.sum(func.length(DocumentUpdate.update))).where(
                    DocumentUpdate.document_id == document_id
                )
            )
        before = await time_loads(store, document_id, rounds)

        start = time.perf_counter()
        await store.compact(document_id)
        compaction_ms = (time.perf_counter() - start) * 1000

        async with sessionmaker() as session:
            snapshot_bytes = await session.scalar(
                select(func.length(DocumentSnapshot.state)).where(
                    DocumentSnapshot.document_id == document_id
                )
            )
        after = await time_loads(store, document_id, rounds)

        await store.append(document_id, [PendingUpdate(update, user_id) for update in later])
        start = time.perf_counter()
        await store.compact(document_id)
        steady_ms = (time.perf_counter() - start) * 1000

        loaded = (await store.load(document_id)).updates
        check: Doc[Any] = Doc()
        check.apply_update(merge_updates(*loaded))
        assert str(check.get("text", type=Text)) == typed, "compaction changed the text"
        gc_bytes = len(check.get_update())  # what a garbage-collected re-encoding would store

        print(f"{edits:,} keystrokes -> {len(typed):,} characters of text")
        print(f"  log:       {edits:,} rows, {log_bytes:,} bytes, opens in {before:.1f} ms")
        print(f"  compacted: 1 snapshot, {snapshot_bytes:,} bytes, opens in {after:.1f} ms")
        print(f"  first compaction {compaction_ms:.0f} ms; opening is {before / after:.0f}x faster")
        print(f"  folding the next 500 keystrokes into the snapshot: {steady_ms:.0f} ms")
        print(f"  (a garbage-collected snapshot would be {gc_bytes:,} bytes; see ADR 0012)")
    finally:
        async with sessionmaker() as session, session.begin():
            await session.execute(delete(User).where(User.id == user_id))  # cascades
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--edits", type=int, default=10_000)
    parser.add_argument("--rounds", type=int, default=7)
    args = parser.parse_args()
    asyncio.run(main(args.edits, args.rounds))
