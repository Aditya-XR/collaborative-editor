import asyncio
import json
import time
import uuid
from collections.abc import Callable, Coroutine
from enum import IntEnum
from typing import Any

import anyio
import structlog
from pycrdt import Doc, create_sync_message, merge_updates, write_var_uint
from starlette.websockets import WebSocket, WebSocketState

from app.collab.protocol import (
    AWARENESS,
    EMPTY_UPDATE,
    SYNC,
    SYNC_STEP1,
    SYNC_STEP2,
    SYNC_UPDATE,
    AwarenessEntry,
    ProtocolError,
    awareness_message,
    decode_awareness,
    encode_awareness,
    read_payload,
    sync_update_message,
)
from app.collab.store import PendingUpdate, UpdateStore
from app.documents.models import DocumentRole

log = structlog.get_logger()

MAX_AWARENESS_STATE_BYTES = 4096
SAVE_RETRY_SECONDS = 2.0


class CloseCode(IntEnum):
    """WebSocket close codes the browser acts on (4000-4999 are free for applications)."""

    RESTARTING = 1012  # reconnect shortly
    BAD_MESSAGE = 4400  # do not retry with the same client state
    INVALID_TICKET = 4401  # fetch a new ticket, then reconnect
    FORBIDDEN = 4403  # access removed: stop, drop the local copy
    NOT_FOUND = 4404  # deleted or trashed: stop, drop the local copy
    TOO_SLOW = 4408  # reconnect; the server could not keep up with sending
    RATE_LIMITED = 4429  # back off, then reconnect


class TokenBucket:
    """In-memory token bucket for one connection: a socket lives on one instance, so no Redis."""

    def __init__(
        self, capacity: int, per_second: float, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._capacity = capacity
        self._rate = per_second
        self._clock = clock
        self._tokens = float(capacity)
        self._updated = clock()

    def take(self) -> bool:
        now = self._clock()
        self._tokens = min(self._capacity, self._tokens + (now - self._updated) * self._rate)
        self._updated = now
        if self._tokens < 1:
            return False
        self._tokens -= 1
        return True


class Connection:
    """One browser tab on one document. Outgoing messages go through a bounded queue drained by
    its own writer task, so one slow client never stalls the others."""

    def __init__(
        self,
        websocket: WebSocket,
        *,
        user_id: uuid.UUID,
        user_name: str,
        role: DocumentRole,
        bucket: TokenBucket,
        queue_size: int,
    ) -> None:
        self.websocket = websocket
        self.user_id = user_id
        self.user_name = user_name
        self.role = role
        self.bucket = bucket
        self.awareness_ids: set[int] = set()
        self.closed = False
        self._queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=queue_size)
        self._writer: asyncio.Task[None] | None = None

    @property
    def can_edit(self) -> bool:
        return self.role in (DocumentRole.OWNER, DocumentRole.EDITOR)

    def start(self) -> None:
        self._writer = asyncio.create_task(self._write_loop())

    def send(self, message: bytes) -> bool:
        """Queues a message. False means the queue is full: the client is too slow."""
        if self.closed:
            return True
        try:
            self._queue.put_nowait(message)
        except asyncio.QueueFull:
            return False
        return True

    async def close(self, code: int, reason: str) -> None:
        if self.closed:
            return
        self.closed = True
        if self._writer is not None:
            self._writer.cancel()
        if self.websocket.client_state is WebSocketState.DISCONNECTED:
            return  # the client already left; there is nobody to send a close frame to
        # Bounded: a peer that stopped reading must not hold up the caller.
        with anyio.move_on_after(1):
            try:
                await self.websocket.close(code, reason)
            except RuntimeError:
                pass  # closed concurrently

    async def _write_loop(self) -> None:
        try:
            while True:
                await self.websocket.send_bytes(await self._queue.get())
        except asyncio.CancelledError:
            raise
        except Exception:  # the socket died mid-send; the reader will see the disconnect
            self.closed = True


class Room:
    """The live, in-memory state of one open document and everyone connected to it.

    The server relays and stores updates but never edits text itself. If it ever does (merging a
    branch, restoring a version), note that pycrdt indexes text in UTF-8 bytes while browser Yjs
    uses UTF-16 code units: positions must be converted, not copied.
    """

    def __init__(
        self,
        document_id: uuid.UUID,
        store: UpdateStore,
        updates: list[bytes],
        *,
        flush_interval: float,
        flush_max_updates: int,
    ) -> None:
        self.document_id = document_id
        self.doc: Doc[Any] = Doc()
        if updates:
            # Merged into one update, never replayed one by one: pycrdt/yrs 0.27 can drop an update
            # that arrives before one it depends on (reference Yjs parks and retries it), and
            # merging orders the operations correctly whatever order the rows are in.
            self.doc.apply_update(merge_updates(*updates))
        self.connections: set[Connection] = set()
        self.holders = 0  # connections admitted or joining; the room is evicted at zero
        self._store = store
        self._flush_interval = flush_interval
        self._flush_max = flush_max_updates
        self._pending: list[PendingUpdate] = []
        self._flush_lock = asyncio.Lock()
        self._timer: asyncio.Task[None] | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        self._awareness: dict[int, AwarenessEntry] = {}
        self._awareness_owner: dict[int, Connection] = {}

    # ----- membership -------------------------------------------------------------------------

    def join(self, connection: Connection) -> None:
        self.connections.add(connection)
        connection.start()
        # Sync step 1: our state vector. The client answers with every update we lack.
        connection.send(create_sync_message(self.doc))
        if self._awareness:
            connection.send(awareness_message(encode_awareness(list(self._awareness.values()))))

    def leave(self, connection: Connection) -> None:
        self.connections.discard(connection)
        gone = []
        for client_id in connection.awareness_ids:
            entry = self._awareness.pop(client_id, None)
            self._awareness_owner.pop(client_id, None)
            if entry is not None:
                # A higher clock with a null state tells every client this cursor is gone.
                gone.append(AwarenessEntry(client_id, entry.clock + 1, None))
        if gone:
            self.broadcast(awareness_message(encode_awareness(gone)))

    async def kick_all(self, code: CloseCode, reason: str) -> None:
        await asyncio.gather(*(c.close(code, reason) for c in list(self.connections)))

    # ----- incoming messages ------------------------------------------------------------------

    def receive(self, connection: Connection, message: bytes) -> None:
        if not message:
            raise ProtocolError("empty message")
        if message[0] == SYNC:
            self._receive_sync(connection, message)
        elif message[0] == AWARENESS:
            self._receive_awareness(connection, message)
        else:
            raise ProtocolError(f"unknown message type {message[0]}")

    def _receive_sync(self, connection: Connection, message: bytes) -> None:
        if len(message) < 2:
            raise ProtocolError("truncated sync message")
        step, payload = message[1], read_payload(message, 2)

        if step == SYNC_STEP1:
            try:
                missing = self.doc.get_update(payload)
            except ValueError as exc:
                raise ProtocolError("invalid state vector") from exc
            connection.send(bytes([SYNC, SYNC_STEP2]) + write_var_uint(len(missing)) + missing)
            return

        if step not in (SYNC_STEP2, SYNC_UPDATE):
            raise ProtocolError(f"unknown sync step {step}")
        if payload == EMPTY_UPDATE:
            return
        if not connection.can_edit:
            # Viewers and commenters may read but not change the text. Their client is
            # read-only, so this only happens with a modified client or stale offline edits.
            log.info("ignored edit from read-only connection", document_id=str(self.document_id))
            return
        try:
            self.doc.apply_update(payload)
        except ValueError as exc:
            raise ProtocolError("invalid update") from exc
        self.broadcast(sync_update_message(payload), exclude=connection)
        self._queue_save(PendingUpdate(payload, connection.user_id))

    def _receive_awareness(self, connection: Connection, message: bytes) -> None:
        accepted = []
        for entry in decode_awareness(read_payload(message, 1)):
            owner = self._awareness_owner.get(entry.client_id)
            if owner is not None and owner is not connection:
                continue  # nobody may move or remove someone else's cursor
            current = self._awareness.get(entry.client_id)
            if current is not None and entry.clock <= current.clock:
                continue  # stale
            if entry.state is None:
                self._awareness.pop(entry.client_id, None)
                self._awareness_owner.pop(entry.client_id, None)
                connection.awareness_ids.discard(entry.client_id)
                accepted.append(entry)
                continue
            entry = AwarenessEntry(entry.client_id, entry.clock, self._stamp(connection, entry))
            self._awareness[entry.client_id] = entry
            self._awareness_owner[entry.client_id] = connection
            connection.awareness_ids.add(entry.client_id)
            accepted.append(entry)
        if accepted:
            self.broadcast(awareness_message(encode_awareness(accepted)), exclude=connection)

    @staticmethod
    def _stamp(connection: Connection, entry: AwarenessEntry) -> str:
        """Overwrites the name on a cursor with the authenticated one, so nobody can type
        under someone else's name."""
        assert entry.state is not None
        if len(entry.state.encode()) > MAX_AWARENESS_STATE_BYTES:
            raise ProtocolError("awareness state too large")
        try:
            state = json.loads(entry.state)
        except ValueError as exc:
            raise ProtocolError("awareness state is not JSON") from exc
        if not isinstance(state, dict):
            raise ProtocolError("awareness state must be an object")
        user = state.get("user")
        user = user if isinstance(user, dict) else {}
        state["user"] = {**user, "id": str(connection.user_id), "name": connection.user_name}
        return json.dumps(state, separators=(",", ":"))

    # ----- outgoing ---------------------------------------------------------------------------

    def broadcast(self, message: bytes, exclude: Connection | None = None) -> None:
        for connection in list(self.connections):
            if connection is exclude:
                continue
            if not connection.send(message):
                log.warning("dropping slow connection", document_id=str(self.document_id))
                self._spawn(connection.close(CloseCode.TOO_SLOW, "Connection too slow"))

    # ----- persistence ------------------------------------------------------------------------

    def _queue_save(self, pending: PendingUpdate) -> None:
        self._pending.append(pending)
        if len(self._pending) >= self._flush_max:
            self._spawn(self.flush())
        elif self._timer is None:
            self._timer = self._spawn(self._flush_later(self._flush_interval))

    async def _flush_later(self, delay: float) -> None:
        await asyncio.sleep(delay)
        self._timer = None
        await self.flush()

    async def flush(self) -> None:
        async with self._flush_lock:
            batch, self._pending = self._pending, []
            if not batch:
                return
            try:
                await self._store.append(self.document_id, batch)
            except Exception:
                # Keep the edits and retry. Connected clients also still hold them and would
                # re-send them on reconnect, so a failed write does not lose work by itself.
                log.exception("saving edits failed, will retry", document_id=str(self.document_id))
                self._pending = batch + self._pending
                if self._timer is None:
                    self._timer = self._spawn(self._flush_later(SAVE_RETRY_SECONDS))

    async def close(self) -> None:
        """Saves everything still buffered. Called when the room leaves memory."""
        await self.flush()
        if self._timer is not None:
            self._timer.cancel()
        for task in list(self._tasks):
            if task is not self._timer:
                await asyncio.gather(task, return_exceptions=True)
        if self._pending:
            log.error(
                "room closed with unsaved edits",
                document_id=str(self.document_id),
                count=len(self._pending),
            )

    def _spawn(self, coroutine: Coroutine[Any, Any, None]) -> asyncio.Task[None]:
        task = asyncio.create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task
