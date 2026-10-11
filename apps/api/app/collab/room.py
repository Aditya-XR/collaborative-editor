import asyncio
import json
import time
import uuid
from collections.abc import Callable, Coroutine
from enum import IntEnum
from typing import Any, Protocol

import anyio
import structlog
from pycrdt import Doc, create_sync_message, merge_updates, write_var_uint
from starlette.websockets import WebSocket, WebSocketState

from app.collab.bus import Kind, parts
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
PUBLISH_RETRY_SECONDS = 1.0
# Browsers drop a cursor not renewed for 30 seconds (y-protocols renews every 15); a cursor
# relayed from another instance is not shown to newcomers after that either.
REMOTE_AWARENESS_TTL = 30.0


class StreamLink(Protocol):
    """How a room reaches the same stream's rooms on other instances (RoomManager's bus)."""

    async def publish(self, kind: Kind, payload: bytes) -> int | None:
        """How many subscribers got it, this instance included; None if it was not sent."""
        ...


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
        link: StreamLink | None = None,
        publish_interval: float = 0.05,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.document_id = document_id
        # None for the document's main text; otherwise this room edits one of its branches.
        self.branch_id = branch_id
        # While set, edits are not accepted: a merge is checking and taking this branch's state.
        self.frozen = False
        # The same, set from another instance's merge. It lapses on its own, so a lost "resume"
        # message can never leave a branch frozen for good.
        self._frozen_until = 0.0
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
        # Other instances (ADR 0004): what this room still has to tell them, sent as one message
        # per interval, and the cursors of people connected over there.
        self._link = link
        self._publish_interval = publish_interval
        self._outbox_updates: list[bytes] = []
        self._outbox_awareness: dict[int, AwarenessEntry] = {}
        self._publisher: asyncio.Task[None] | None = None
        self._publish_lock = asyncio.Lock()
        self._remote_awareness: dict[int, tuple[AwarenessEntry, float]] = {}
        # True while no other instance has this stream open: then edits are not published at
        # all. Learnt from Redis, which says how many subscribers each message reached; a
        # newcomer always says HELLO and gets everything it lacks in the reply.
        self._alone = False
        # Bumped whenever another instance speaks on the stream, so that a publish sent before
        # that, whose count of receivers is out of date, cannot conclude the room is alone.
        self.peer_epoch = 0
        # Edits queued for other instances, and the messages that carried them.
        self.updates_out = 0
        self.publishes = 0

    @property
    def stream_id(self) -> uuid.UUID:
        """What the room manager keys rooms by: the branch, or the document for main."""
        return self.branch_id or self.document_id

    @property
    def accepting_edits(self) -> bool:
        return not self.frozen and self._clock() >= self._frozen_until

    def freeze_for(self, seconds: float) -> None:
        """Another instance is merging this branch: refuse edits for up to this long; 0 resumes."""
        self._frozen_until = self._clock() + seconds if seconds > 0 else 0.0

    # ----- membership -------------------------------------------------------------------------

    def join(self, connection: Connection) -> None:
        self.connections.add(connection)
        connection.start()
        # Sync step 1: our state vector. The client answers with every update we lack.
        connection.send(create_sync_message(self.doc))
        cursors = list(self._awareness.values()) + self._fresh_remote_awareness()
        if cursors:
            connection.send(awareness_message(encode_awareness(cursors)))

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
            self._queue_publish(awareness=gone)

    async def kick_all(self, code: int, reason: str) -> None:
        await asyncio.gather(*(c.close(code, reason) for c in list(self.connections)))

    async def kick_user(self, user_id: uuid.UUID, code: int, reason: str) -> int:
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
        if not connection.can_edit or not self.accepting_edits:
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
        self._queue_publish(update=payload)

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
            # Someone who moved here from another instance: this connection speaks for them now.
            self._remote_awareness.pop(entry.client_id, None)
            connection.awareness_ids.add(entry.client_id)
            accepted.append(entry)
        if accepted:
            self.broadcast(awareness_message(encode_awareness(accepted)), exclude=connection)
            self._queue_publish(awareness=accepted)

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
        self._queue_publish(update=update)

    # ----- other instances --------------------------------------------------------------------

    def apply_remote_update(self, update: bytes) -> None:
        """Edits another instance accepted (and saves): applied and relayed, never saved here."""
        if not update or update == EMPTY_UPDATE:
            return
        try:
            self.doc.apply_update(update)
        except ValueError:
            log.warning(
                "ignored an invalid update from another instance", stream_id=str(self.stream_id)
            )
            return
        self.broadcast(sync_update_message(update))

    def apply_remote_awareness(self, update: bytes) -> None:
        """Cursors of people connected to other instances, stamped with their real names over
        there. A cursor owned by a connection here is never changed from outside."""
        accepted = []
        now = self._clock()
        for entry in decode_awareness(update):
            if entry.client_id in self._awareness_owner:
                continue
            current = self._remote_awareness.get(entry.client_id)
            if current is not None and entry.clock <= current[0].clock:
                continue
            if entry.state is None:
                self._remote_awareness.pop(entry.client_id, None)
            else:
                self._remote_awareness[entry.client_id] = (entry, now)
            accepted.append(entry)
        if accepted:
            self.broadcast(awareness_message(encode_awareness(accepted)))

    def local_awareness(self) -> bytes:
        """The cursors of people connected here, for an instance that just opened this stream."""
        return encode_awareness(list(self._awareness.values())) if self._awareness else b""

    def _fresh_remote_awareness(self) -> list[AwarenessEntry]:
        horizon = self._clock() - REMOTE_AWARENESS_TTL
        stale = [cid for cid, (_, seen) in self._remote_awareness.items() if seen < horizon]
        for client_id in stale:
            del self._remote_awareness[client_id]
        return [entry for entry, _ in self._remote_awareness.values()]

    @property
    def alone(self) -> bool:
        return self._alone

    def note_receivers(self, receivers: int | None, sent_at_epoch: int) -> None:
        """Records how many subscribers a message on this stream reached (1 is only us)."""
        if receivers is None:
            return
        if receivers > 1:
            self._alone = False
        elif sent_at_epoch == self.peer_epoch:
            self._alone = True

    def heard_from_peer(self) -> bool:
        """Another instance spoke on this stream. True if this room believed it was alone, and
        so may have kept edits to itself: the caller then syncs with the newcomer."""
        self.peer_epoch += 1
        was_alone, self._alone = self._alone, False
        return was_alone

    def _queue_publish(
        self, *, update: bytes | None = None, awareness: list[AwarenessEntry] | None = None
    ) -> None:
        if self._link is None or self._alone:
            return
        if update is not None:
            self._outbox_updates.append(update)
            self.updates_out += 1
        for entry in awareness or []:
            self._outbox_awareness[entry.client_id] = entry  # only the newest state matters
        if self._publisher is None:
            self._publisher = self._spawn(self._publish_while_busy())

    async def _publish_while_busy(self) -> None:
        """A throttle with a leading edge: the first edit after a quiet spell goes out at once,
        and while edits keep coming they go out together, at most once per interval. A lone
        keystroke waits for nothing; a busy document costs one Redis command per interval."""
        try:
            while self._outbox_updates or self._outbox_awareness:
                sent = await self.publish_now()
                await asyncio.sleep(self._publish_interval if sent else PUBLISH_RETRY_SECONDS)
        finally:
            self._publisher = None

    async def publish_now(self) -> bool:
        """Sends everything queued for other instances as one message: one merged update and the
        newest state of each cursor. Returns False, keeping it all queued, if Redis does not
        take it: while their rooms stay open, other instances learn of these edits from nowhere
        else."""
        if self._link is None:
            return True
        async with self._publish_lock:
            updates, self._outbox_updates = self._outbox_updates, []
            cursors, self._outbox_awareness = self._outbox_awareness, {}
            if not updates and not cursors:
                return True
            update = b""
            if updates:
                update = updates[0] if len(updates) == 1 else merge_updates(*updates)
            cursor_bytes = encode_awareness(list(cursors.values())) if cursors else b""
            epoch = self.peer_epoch
            try:
                receivers = await self._link.publish(Kind.BATCH, parts(update, cursor_bytes))
            except BaseException:
                self._requeue(update, cursors)  # cancelled mid-send: keep it for the next try
                raise
            if receivers is None:
                self._requeue(update, cursors)
                return False
            self.publishes += 1
            self.note_receivers(receivers, epoch)
            return True

    def _requeue(self, update: bytes, cursors: dict[int, AwarenessEntry]) -> None:
        """Puts a batch back in front of anything queued meanwhile; newer cursor states win."""
        if update:
            self._outbox_updates.insert(0, update)
        self._outbox_awareness = {**cursors, **self._outbox_awareness}

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
        # Other instances keep their rooms open, and learn of edits only from this one. One last
        # try: if Redis is failing now, they reload from Postgres when their subscription comes
        # back (ADR 0004).
        if self._publisher is not None:
            self._publisher.cancel()
            await asyncio.gather(self._publisher, return_exceptions=True)
        if not await self.publish_now():
            log.warning(
                "could not send the last edits to other instances", stream_id=str(self.stream_id)
            )
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
