import asyncio
import uuid
from collections import Counter, defaultdict
from collections.abc import Callable, Coroutine
from typing import Any

import structlog
from pycrdt import Doc

from app.collab import room as room_module
from app.collab.bus import (
    CONTROL_CHANNEL,
    BusError,
    Envelope,
    Kind,
    Reader,
    RedisBus,
    decode,
    decode_close,
    encode,
    encode_close,
    parts,
    stream_channel,
    stream_of,
)
from app.collab.protocol import EMPTY_UPDATE, ProtocolError
from app.collab.room import CloseCode, Room
from app.collab.store import UpdateStore
from app.core.config import Settings

log = structlog.get_logger()

# How long another instance's merge may hold a branch frozen if the "resume" message is lost.
FREEZE_SECONDS = 30.0
PUBLISH_ATTEMPTS = 3


class RoomManager:
    """Keeps one Room per open stream on this instance: a document's main text, or a branch.

    Rooms are keyed by stream id (the branch id, or the document id for main); ids are UUIDs, so
    the two never collide. A per-stream lock serialises loading and eviction, so two people
    opening the same document at the same moment share one room instead of loading it twice.

    Rooms for the same stream on other instances are kept in step through the bus (ADR 0004):
    each room publishes what its own clients do and applies what the others publish.
    """

    def __init__(self, store: UpdateStore, settings: Settings, bus: RedisBus) -> None:
        self.store = store
        self.bus = bus
        self._settings = settings
        self.rooms: dict[uuid.UUID, Room] = {}
        self._locks: defaultdict[uuid.UUID, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._evictions: dict[uuid.UUID, asyncio.Task[None]] = {}
        self._connections_per_user: Counter[uuid.UUID] = Counter()
        # Messages for rooms being loaded right now, applied once the room exists.
        self._loading: dict[uuid.UUID, list[Envelope]] = {}
        self._tasks: set[asyncio.Task[Any]] = set()
        bus.listen(self._on_message, self._on_active)

    # ----- per-user connection cap ------------------------------------------------------------

    def reserve_connection(self, user_id: uuid.UUID) -> bool:
        """Per instance: with several instances, the cap applies on each."""
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
                room = await self._load(document_id, branch_id)
            room.holders += 1
            return room

    async def _load(self, document_id: uuid.UUID, branch_id: uuid.UUID | None) -> Room:
        """Subscribes first, then reads Postgres, then asks the other instances for anything
        they hold that is not saved yet. In that order nothing falls in between: an edit
        published after the subscription arrives as a message, one saved before the read is in
        the read, and one still waiting to be saved on another instance comes back in its reply.
        """
        stream_id = branch_id or document_id
        self._loading[stream_id] = []
        try:
            subscribed = await self.bus.subscribe(stream_channel(stream_id))
            stored = await self.store.load(document_id, branch_id)
        except BaseException:
            del self._loading[stream_id]
            await self.bus.unsubscribe(stream_channel(stream_id))
            raise
        settings = self._settings
        room = Room(
            document_id,
            self.store,
            stored,
            flush_interval=settings.collab_flush_interval_seconds,
            flush_max_updates=settings.collab_flush_max_updates,
            compaction_threshold=settings.collab_compaction_threshold,
            version_interval=settings.versions_auto_interval_seconds,
            branch_id=branch_id,
            link=_Link(self, stream_id),
            publish_interval=settings.collab_publish_interval_seconds,
        )
        self.rooms[stream_id] = room
        for envelope in self._loading.pop(stream_id):
            self._handle(room, envelope)
        if subscribed:
            # If not, the bus reports the subscription once it is made, and the room syncs then.
            self._spawn(self._say_hello(room))
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
            await self.bus.unsubscribe(stream_channel(stream_id))

    # ----- administrative ---------------------------------------------------------------------

    async def flush(self, stream_id: uuid.UUID) -> None:
        """Saves a stream's buffered edits now, so what is read next includes them.

        Only this instance's room is reached; edits buffered on another instance are at most one
        flush interval behind (ADR 0004).
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
        and returns once the edit is saved and sent to the other instances.

        `make_update` gets the room's current state vector and returns the update to apply, so
        the update can be exactly what the room lacks.
        """
        room = await self.acquire(document_id, branch_id)
        try:
            update = await asyncio.to_thread(make_update, room.doc.get_state())
            room.apply_server_update(update, user_id)
            await room.flush()
            await room.publish_now()
        finally:
            await self.release(room)

    def _rooms_of(self, document_id: uuid.UUID) -> list[Room]:
        return [room for room in self.rooms.values() if room.document_id == document_id]

    async def notify(self, stream_id: uuid.UUID, message: bytes) -> None:
        """Sends a message to everyone connected to one stream, on every instance, e.g. that its
        comments changed."""
        room = self.rooms.get(stream_id)
        if room is not None:
            room.broadcast(message)
        await self._publish(stream_channel(stream_id), Kind.NOTIFY, message)

    async def close_document(self, document_id: uuid.UUID, code: CloseCode, reason: str) -> None:
        """Disconnects everyone from a document and its branches, e.g. when it is trashed."""
        await self._publish(
            CONTROL_CHANNEL, Kind.KICK_DOCUMENT, document_id.bytes + encode_close(code, reason)
        )
        await self._kick_document(document_id, code, reason)

    async def close_stream(self, stream_id: uuid.UUID, code: CloseCode, reason: str) -> None:
        """Disconnects everyone from one stream, e.g. a branch that was just merged."""
        await self._publish(stream_channel(stream_id), Kind.KICK, encode_close(code, reason))
        room = self.rooms.get(stream_id)
        if room is not None:
            await room.kick_all(code, reason)

    async def disconnect_user(
        self, document_id: uuid.UUID, user_id: uuid.UUID, code: CloseCode, reason: str
    ) -> None:
        """Closes one user's connections to a document and its branches, on every instance,
        after their access changed."""
        await self._publish(
            CONTROL_CHANNEL,
            Kind.KICK_USER,
            document_id.bytes + user_id.bytes + encode_close(code, reason),
        )
        await self._kick_user(document_id, user_id, code, reason)

    async def set_frozen(self, stream_id: uuid.UUID, frozen: bool) -> None:
        """Stops (or resumes) edits to a branch on every instance while it is merged. Other
        instances freeze for at most FREEZE_SECONDS, in case the "resume" message is lost."""
        room = self.rooms.get(stream_id)
        if room is not None:
            room.frozen = frozen
        seconds = int(FREEZE_SECONDS) if frozen else 0
        await self._publish(stream_channel(stream_id), Kind.FREEZE, bytes([seconds]))

    async def shutdown(self) -> None:
        """Called on server shutdown: tell clients to reconnect elsewhere, then save everything.

        Only this instance's clients are told; the other instances keep their rooms."""
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
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        log.info("collaboration rooms saved", count=len(rooms))

    # ----- the bus ------------------------------------------------------------------------

    async def _publish(self, channel: str, kind: Kind, payload: bytes) -> int | None:
        """Sends one message, trying again a couple of times if Redis refuses it: a lost kick
        would leave someone editing after losing access, and a lost sync reply would leave
        another instance without edits it asked for. Returns the number of receivers, or None.
        """
        message = encode(self.bus.instance_id, kind, payload)
        for attempt in range(PUBLISH_ATTEMPTS):
            if attempt:
                await asyncio.sleep(room_module.PUBLISH_RETRY_SECONDS)
            receivers = await self.bus.publish(channel, message)
            if receivers is not None:
                return receivers
        log.error("gave up publishing to other instances", kind=kind.name)
        return None

    async def _publish_once(self, channel: str, kind: Kind, payload: bytes) -> int | None:
        """For rooms' edit batches, which keep and retry what did not go out themselves."""
        return await self.bus.publish(channel, encode(self.bus.instance_id, kind, payload))

    def _on_message(self, channel: str, data: bytes) -> None:
        try:
            envelope = decode(data)
        except BusError as exc:
            log.warning("ignored a pub/sub message", error=str(exc))
            return
        if envelope.sender == self.bus.instance_id:
            return  # our own, echoed back by Redis
        try:
            if channel == CONTROL_CHANNEL:
                self._handle_control(envelope)
                return
            stream_id = stream_of(channel)
            if stream_id is None:
                return
            room = self.rooms.get(stream_id)
            if room is not None:
                self._handle(room, envelope)
            elif stream_id in self._loading:
                self._loading[stream_id].append(envelope)
            # Otherwise the room was just evicted here: nothing to do.
        except (BusError, ProtocolError, ValueError) as exc:
            log.warning("ignored a malformed pub/sub message", error=str(exc))

    def _handle(self, room: Room, envelope: Envelope) -> None:
        if room.heard_from_peer() and envelope.kind is not Kind.HELLO:
            # An instance we did not know had this stream open, and which did not say HELLO
            # (its HELLO was lost): it may lack edits we kept to ourselves, so sync now.
            self._spawn(self._say_hello(room))
        reader = Reader(envelope.payload)
        match envelope.kind:
            case Kind.BATCH:
                update, cursors = reader.part(), reader.part()
                room.apply_remote_update(update)
                if cursors:
                    room.apply_remote_awareness(cursors)
            case Kind.HELLO:
                self._spawn(self._answer_hello(room, envelope.sender, reader.rest()))
            case Kind.NEEDS:
                if reader.uuid() == self.bus.instance_id:
                    self._spawn(self._send_diff(room, envelope.sender, reader.rest()))
            case Kind.DIFF:
                if reader.uuid() == self.bus.instance_id:
                    room.apply_remote_update(reader.rest())
            case Kind.NOTIFY:
                room.broadcast(envelope.payload)
            case Kind.KICK:
                code, reason = decode_close(reader)
                self._spawn(room.kick_all(code, reason))
            case Kind.FREEZE:
                room.freeze_for(reader.fixed(1)[0])

    def _handle_control(self, envelope: Envelope) -> None:
        reader = Reader(envelope.payload)
        document_id = reader.uuid()
        match envelope.kind:
            case Kind.KICK_DOCUMENT:
                code, reason = decode_close(reader)
                self._spawn(self._kick_document(document_id, code, reason))
            case Kind.KICK_USER:
                user_id = reader.uuid()
                code, reason = decode_close(reader)
                self._spawn(self._kick_user(document_id, user_id, code, reason))

    def _on_active(self, channel: str) -> None:
        """A subscription became active again after the connection to Redis was lost, so
        messages may have been missed in either direction: catch up from Postgres, and sync with
        the other instances."""
        stream_id = stream_of(channel)
        room = self.rooms.get(stream_id) if stream_id else None
        if room is not None:
            self._spawn(self._resync(room))

    async def _resync(self, room: Room) -> None:
        saved = await self.store.state(room.document_id, room.branch_id)
        missing = await asyncio.to_thread(_missing_from, saved, room.doc.get_state())
        room.apply_remote_update(missing)
        await self._say_hello(room)

    async def _say_hello(self, room: Room) -> None:
        epoch = room.peer_epoch
        receivers = await self._publish(
            stream_channel(room.stream_id), Kind.HELLO, room.doc.get_state()
        )
        room.note_receivers(receivers, epoch)

    async def _answer_hello(self, room: Room, peer: uuid.UUID, state_vector: bytes) -> None:
        """A peer just subscribed: send what it lacks, the cursors connected here, and our state
        vector so it can send what we lack in turn (Yjs sync between servers)."""
        await self._send_diff(room, peer, state_vector)
        channel = stream_channel(room.stream_id)
        cursors = room.local_awareness()
        if cursors:
            await self._publish(channel, Kind.BATCH, parts(b"", cursors))
        await self._publish(channel, Kind.NEEDS, peer.bytes + room.doc.get_state())

    async def _send_diff(self, room: Room, peer: uuid.UUID, state_vector: bytes) -> None:
        try:
            missing = room.doc.get_update(state_vector)
        except ValueError:
            log.warning("ignored an invalid state vector from another instance")
            return
        if missing != EMPTY_UPDATE:
            await self._publish(stream_channel(room.stream_id), Kind.DIFF, peer.bytes + missing)

    async def _kick_document(self, document_id: uuid.UUID, code: int, reason: str) -> None:
        await asyncio.gather(*(room.kick_all(code, reason) for room in self._rooms_of(document_id)))

    async def _kick_user(
        self, document_id: uuid.UUID, user_id: uuid.UUID, code: int, reason: str
    ) -> None:
        await asyncio.gather(
            *(room.kick_user(user_id, code, reason) for room in self._rooms_of(document_id))
        )

    def _spawn(self, coroutine: Coroutine[Any, Any, None]) -> None:
        task = asyncio.create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        task.add_done_callback(_log_failure)


class _Link:
    """What a room uses to publish to its stream's channel."""

    def __init__(self, manager: RoomManager, stream_id: uuid.UUID) -> None:
        self._manager = manager
        self._channel = stream_channel(stream_id)

    async def publish(self, kind: Kind, payload: bytes) -> int | None:
        return await self._manager._publish_once(self._channel, kind, payload)


def _missing_from(saved: bytes, state_vector: bytes) -> bytes:
    """What a document holding `state_vector` lacks from the saved state. CPU work."""
    doc: Doc[Any] = Doc()
    doc.apply_update(saved)
    return doc.get_update(state_vector)


def _log_failure(task: asyncio.Task[Any]) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.error("collaboration background task failed", error=repr(task.exception()))
