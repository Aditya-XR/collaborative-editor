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

from app.collab.models import SnapshotKind
from app.collab.protocol import (
    AWARENESS,
    EMPTY_UPDATE,
    HEARTBEAT,
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
from app.collab.store import PendingUpdate, StoredDocument, UpdateStore
from app.documents.models import DocumentRole

log = structlog.get_logger()

MAX_AWARENESS_STATE_BYTES = 4096
SAVE_RETRY_SECONDS = 2.0


class CloseCode(IntEnum):
    """WebSocket close codes the browser acts on (4000-4999 are free for applications)."""

    RESTARTING = 1012  # reconnect shortly
    SILENT = 4000  # nothing heard for too long; reconnect
    BAD_MESSAGE = 4400  # do not retry with the same client state
    INVALID_TICKET = 4401  # fetch a new ticket, then reconnect
    FORBIDDEN = 4403  # access removed: stop, drop the local copy
    NOT_FOUND = 4404  # deleted or trashed: stop, drop the local copy
    TOO_SLOW = 4408  # reconnect; the server could not keep up with sending
    ROLE_CHANGED = 4409  # reconnect now: a fresh ticket carries the new role
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
    """The live, in-memory state of one open stream (a document's main text, or one of its
    branches) and everyone connected to it.

    The server relays and stores updates but never edits text by position: restoring a version
    is an edit made by the browser (ADR 0014), and merging a branch applies the branch's own CRDT
    operations (ADR 0016). If it ever does, note that pycrdt indexes text in UTF-8 bytes while
    browser Yjs uses UTF-16 code units: positions must be converted, not copied.
    """

    def __init__(
        self,
        document_id: uuid.UUID,
        store: UpdateStore,
        stored: StoredDocument,
        *,
        flush_interval: float,
        flush_max_updates: int,
        compaction_threshold: int,
        version_interval: float,
        branch_id: uuid.UUID | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.document_id = document_id
        # None for the document's main text; otherwise this room edits one of its branches.
        self.branch_id = branch_id
        # While set, edits are not accepted: a merge is checking and taking this branch's state.
        self.frozen = False
        self.doc: Doc[Any] = Doc()
        if stored.updates:
            # Merged into one update, never replayed one by one: pycrdt/yrs 0.27 can drop an update
            # that arrives before one it depends on (reference Yjs parks and retries it), and
            # merging orders the operations correctly whatever order the rows are in.
            self.doc.apply_update(merge_updates(*stored.updates))
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
        # Housekeeping (ADR 0003): rows in the edit log, as far as this instance knows, and
        # edits saved since the last automatic version.
        self._log_rows = stored.log_rows
        self._unversioned = 0
        self._compaction_threshold = compaction_threshold
        self._version_interval = version_interval
        self._clock = clock
        self._last_version_at = clock()
        self._compacting: asyncio.Task[None] | None = None
        self._versioning: asyncio.Task[None] | None = None

    @property
    def stream_id(self) -> uuid.UUID:
        """What the room manager keys rooms by: the branch, or the document for main."""
        return self.branch_id or self.document_id

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

    async def kick_user(self, user_id: uuid.UUID, code: CloseCode, reason: str) -> int:
        targets = [c for c in list(self.connections) if c.user_id == user_id]
        await asyncio.gather(*(c.close(code, reason) for c in targets))
        return len(targets)

    # ----- incoming messages ------------------------------------------------------------------

    def receive(self, connection: Connection, message: bytes) -> None:
        if not message:
            raise ProtocolError("empty message")
        if message[0] == SYNC:
            self._receive_sync(connection, message)
        elif message[0] == AWARENESS:
            self._receive_awareness(connection, message)
        elif message[0] == HEARTBEAT:
            connection.send(bytes([HEARTBEAT]))
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
        if not connection.can_edit or self.frozen:
            # Viewers and commenters may read but not change the text. Their client is
            # read-only, so this only happens with a modified client or stale offline edits.
            # A frozen branch is being merged; the merge ends by making it read-only.
            log.info("ignored edit from read-only connection", stream_id=str(self.stream_id))
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

    def apply_server_update(self, update: bytes, user_id: uuid.UUID | None) -> None:
        """An edit made by the server on someone's behalf (a merge, or taking main's changes
        into a branch): applied, sent to everyone connected, and saved like any edit."""
        if update == EMPTY_UPDATE:
            return
        self.doc.apply_update(update)
        self.broadcast(sync_update_message(update))
        self._queue_save(PendingUpdate(update, user_id))

    # ----- outgoing ---------------------------------------------------------------------------

    def broadcast(self, message: bytes, exclude: Connection | None = None) -> None:
        for connection in list(self.connections):
            if connection is exclude:
                continue
            if not connection.send(message):
                log.warning("dropping slow connection", stream_id=str(self.stream_id))
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
                await self._store.append(self.document_id, batch, self.branch_id)
            except Exception:
                # Keep the edits and retry. Connected clients also still hold them and would
                # re-send them on reconnect, so a failed write does not lose work by itself.
                log.exception("saving edits failed, will retry", stream_id=str(self.stream_id))
                self._pending = batch + self._pending
                if self._timer is None:
                    self._timer = self._spawn(self._flush_later(SAVE_RETRY_SECONDS))
                return
            self._log_rows += len(batch)
            self._unversioned += len(batch)
        self._maintain()

    async def close(self) -> None:
        """Saves everything still buffered, then checkpoints: the session's edits become an
        automatic version and the log is folded, so the next load reads one snapshot.
        Called when the room leaves memory."""
        await self.flush()
        if self._timer is not None:
            self._timer.cancel()
        # Until none are left: a finishing flush can start a compaction or a version. Judged by
        # done(), not by membership: a finished task can linger in the set, and waiting for it
        # to leave turned this loop into a busy spin.
        while running := [
            task for task in self._tasks if not task.done() and task is not self._timer
        ]:
            await asyncio.gather(*running, return_exceptions=True)
        if self._pending:
            log.error(
                "room closed with unsaved edits",
                document_id=str(self.document_id),
                count=len(self._pending),
            )
        # Compaction only ever folds rows already saved, so it is safe even then.
        if self._log_rows:
            await self._compact()
        if self._unversioned and self.branch_id is None:  # versions are main's
            await self._save_auto_version()

    # ----- housekeeping -----------------------------------------------------------------------

    def _maintain(self) -> None:
        """Starts compaction or an automatic version when due. Both run beside editing: the
        live document is in memory, so neither ever blocks a keystroke."""
        if self._log_rows >= self._compaction_threshold and self._compacting is None:
            self._compacting = self._spawn(self._compact())
        due = self._clock() - self._last_version_at >= self._version_interval
        if self.branch_id is None and self._unversioned and due and self._versioning is None:
            self._versioning = self._spawn(self._save_auto_version())

    async def _compact(self) -> None:
        try:
            folded = await self._store.compact(self.document_id, self.branch_id)
            if folded:
                self._log_rows = max(0, self._log_rows - folded)
        except Exception:
            log.exception("compaction failed", stream_id=str(self.stream_id))
        finally:
            self._compacting = None

    async def _save_auto_version(self) -> None:
        covered = self._unversioned
        self._last_version_at = self._clock()
        try:
            await self._store.save_version(self.document_id, SnapshotKind.AUTO)
            self._unversioned -= covered
        except Exception:
            log.exception("saving an automatic version failed", document_id=str(self.document_id))
        finally:
            self._versioning = None

    def _spawn(self, coroutine: Coroutine[Any, Any, None]) -> asyncio.Task[None]:
        task = asyncio.create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task
