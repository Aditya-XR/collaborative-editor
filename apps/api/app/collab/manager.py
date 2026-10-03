import asyncio
import uuid
from collections import Counter, defaultdict
from collections.abc import Callable

import structlog

from app.collab.room import CloseCode, Room
from app.collab.store import UpdateStore
from app.core.config import Settings

log = structlog.get_logger()


class RoomManager:
    """Keeps one Room per open stream on this instance: a document's main text, or a branch.

    Rooms are keyed by stream id (the branch id, or the document id for main); ids are UUIDs, so
    the two never collide. A per-stream lock serialises loading and eviction, so two people
    opening the same document at the same moment share one room instead of loading it twice.
    """

    def __init__(self, store: UpdateStore, settings: Settings) -> None:
        self.store = store
        self._settings = settings
        self.rooms: dict[uuid.UUID, Room] = {}
        self._locks: defaultdict[uuid.UUID, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._evictions: dict[uuid.UUID, asyncio.Task[None]] = {}
        self._connections_per_user: Counter[uuid.UUID] = Counter()

    # ----- per-user connection cap ------------------------------------------------------------

    def reserve_connection(self, user_id: uuid.UUID) -> bool:
        if self._connections_per_user[user_id] >= self._settings.collab_max_connections_per_user:
            return False
        self._connections_per_user[user_id] += 1
        return True

    def release_connection(self, user_id: uuid.UUID) -> None:
        self._connections_per_user[user_id] -= 1
        if self._connections_per_user[user_id] <= 0:
            del self._connections_per_user[user_id]

    # ----- room lifecycle ---------------------------------------------------------------------

    async def acquire(self, document_id: uuid.UUID, branch_id: uuid.UUID | None = None) -> Room:
        stream_id = branch_id or document_id
        async with self._locks[stream_id]:
            eviction = self._evictions.pop(stream_id, None)
            if eviction is not None:
                eviction.cancel()
            room = self.rooms.get(stream_id)
            if room is None:
                room = Room(
                    document_id,
                    self.store,
                    await self.store.load(document_id, branch_id),
                    flush_interval=self._settings.collab_flush_interval_seconds,
                    flush_max_updates=self._settings.collab_flush_max_updates,
                    compaction_threshold=self._settings.collab_compaction_threshold,
                    version_interval=self._settings.versions_auto_interval_seconds,
                    branch_id=branch_id,
                )
                self.rooms[stream_id] = room
            room.holders += 1
            return room

    async def release(self, room: Room) -> None:
        room.holders -= 1
        if room.holders > 0:
            return
        grace = self._settings.collab_room_grace_seconds
        if grace <= 0:
            await self._evict(room.stream_id)
        else:
            self._evictions[room.stream_id] = asyncio.create_task(
                self._evict_later(room.stream_id, grace)
            )

    async def _evict_later(self, stream_id: uuid.UUID, delay: float) -> None:
        await asyncio.sleep(delay)
        await self._evict(stream_id)

    async def _evict(self, stream_id: uuid.UUID) -> None:
        async with self._locks[stream_id]:
            self._evictions.pop(stream_id, None)
            room = self.rooms.get(stream_id)
            if room is None or room.holders > 0:
                return
            del self.rooms[stream_id]
            await room.close()

    # ----- administrative ---------------------------------------------------------------------

    async def flush(self, stream_id: uuid.UUID) -> None:
        """Saves a stream's buffered edits now, so what is read next includes them.

        Only this instance's room is reached; edits buffered on another instance (phase 5) are
        at most one flush interval behind.
        """
        room = self.rooms.get(stream_id)
        if room is not None:
            await room.flush()

    async def apply(
        self,
        document_id: uuid.UUID,
        branch_id: uuid.UUID | None,
        make_update: Callable[[bytes], bytes],
        user_id: uuid.UUID | None,
    ) -> None:
        """Edits a stream on someone's behalf, through its room so everyone connected sees it,
        and returns once the edit is saved.

        `make_update` gets the room's current state vector and returns the update to apply, so
        the update can be exactly what the room lacks.
        """
        room = await self.acquire(document_id, branch_id)
        try:
            update = await asyncio.to_thread(make_update, room.doc.get_state())
            room.apply_server_update(update, user_id)
            await room.flush()
        finally:
            await self.release(room)

    def notify(self, stream_id: uuid.UUID, message: bytes) -> None:
        """Sends a message to everyone connected to one stream, e.g. that its comments changed.

        Only this instance's room is reached, like disconnect_user below; phase 5 fans it out over
        Redis pub/sub.
        """
        room = self.rooms.get(stream_id)
        if room is not None:
            room.broadcast(message)

    def _rooms_of(self, document_id: uuid.UUID) -> list[Room]:
        return [room for room in self.rooms.values() if room.document_id == document_id]

    async def close_document(self, document_id: uuid.UUID, code: CloseCode, reason: str) -> None:
        """Disconnects everyone from a document and its branches, e.g. when it is trashed."""
        await asyncio.gather(*(room.kick_all(code, reason) for room in self._rooms_of(document_id)))

    async def close_stream(self, stream_id: uuid.UUID, code: CloseCode, reason: str) -> None:
        """Disconnects everyone from one stream, e.g. a branch that was just merged."""
        room = self.rooms.get(stream_id)
        if room is not None:
            await room.kick_all(code, reason)

    async def disconnect_user(
        self, document_id: uuid.UUID, user_id: uuid.UUID, code: CloseCode, reason: str
    ) -> None:
        """Closes one user's connections to a document and its branches after their access
        changed.

        Only this instance's rooms are reached; with several instances (phase 5) the same request
        goes out over Redis pub/sub.
        """
        await asyncio.gather(
            *(room.kick_user(user_id, code, reason) for room in self._rooms_of(document_id))
        )

    async def shutdown(self) -> None:
        """Called on server shutdown: tell clients to reconnect elsewhere, then save everything."""
        for task in self._evictions.values():
            task.cancel()
        self._evictions.clear()
        rooms = list(self.rooms.values())
        await asyncio.gather(
            *(room.kick_all(CloseCode.RESTARTING, "Server restarting") for room in rooms)
        )
        for room in rooms:
            await room.close()
        self.rooms.clear()
        log.info("collaboration rooms saved", count=len(rooms))
