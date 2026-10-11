"""Redis pub/sub between API instances (ADR 0004).

Each open stream (a document's main text, or a branch) has a channel that every instance holding
its room subscribes to. Instances publish edits, cursors and events there and apply what the
others publish, so people connected to different instances edit one document together. A second,
always-subscribed channel carries events about whole documents (kicks after an access change).

Pub/sub is fire-and-forget: a message sent while an instance is disconnected is lost. Nothing
depends on every message arriving. Edits are saved by the instance that received them, and
whenever a subscription becomes active (a room loads, or the connection comes back), the room
exchanges state vectors with its peers, the way two Yjs clients sync, and fetches what it missed.

Wire format, all binary: a version byte, the sender's 16-byte instance id, a kind byte, then the
kind's payload. Messages of an unknown version or kind are ignored, so instances running
different releases during a deploy do not break each other.
"""

import asyncio
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from enum import IntEnum

import structlog
from redis.asyncio import Redis
from redis.asyncio.client import PubSub
from redis.asyncio.retry import Retry
from redis.backoff import NoBackoff

log = structlog.get_logger()

VERSION = 1
CONTROL_CHANNEL = "collab:control"
_STREAM_PREFIX = "collab:stream:"


class Kind(IntEnum):
    # On a stream's channel
    BATCH = 1  # edits (one merged Yjs update) and cursor changes from the last few milliseconds
    HELLO = 2  # "my subscription just became active; here is my state vector"
    DIFF = 3  # to one instance: the edits it lacks
    NEEDS = 4  # to one instance: "here is my state vector; send me what I lack"
    NOTIFY = 5  # a message to relay to every connected client (comments changed)
    KICK = 6  # close every connection to this stream
    FREEZE = 7  # stop (or, with 0 seconds, resume) accepting edits: a merge is in progress
    # On the control channel
    KICK_USER = 20  # close one user's connections to a document and its branches
    KICK_DOCUMENT = 21  # close every connection to a document and its branches


class BusError(ValueError):
    """Bytes that are not a message this release understands."""


@dataclass(frozen=True)
class Envelope:
    sender: uuid.UUID
    kind: Kind
    payload: bytes


def stream_channel(stream_id: uuid.UUID) -> str:
    return f"{_STREAM_PREFIX}{stream_id}"


def stream_of(channel: str) -> uuid.UUID | None:
    if not channel.startswith(_STREAM_PREFIX):
        return None
    try:
        return uuid.UUID(channel.removeprefix(_STREAM_PREFIX))
    except ValueError:
        return None


# ----- encoding -----------------------------------------------------------------------------


def _var_uint(value: int) -> bytes:
    out = bytearray()
    while value > 0x7F:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


class Reader:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._at = 0

    def var_uint(self) -> int:
        value = shift = 0
        while True:
            if self._at >= len(self._data) or shift > 63:
                raise BusError("truncated number")
            byte = self._data[self._at]
            self._at += 1
            value |= (byte & 0x7F) << shift
            if byte < 0x80:
                return value
            shift += 7

    def fixed(self, size: int) -> bytes:
        if self._at + size > len(self._data):
            raise BusError("truncated field")
        chunk = self._data[self._at : self._at + size]
        self._at += size
        return chunk

    def part(self) -> bytes:
        return self.fixed(self.var_uint())

    def uuid(self) -> uuid.UUID:
        return uuid.UUID(bytes=self.fixed(16))

    def rest(self) -> bytes:
        chunk = self._data[self._at :]
        self._at = len(self._data)
        return chunk


def parts(*chunks: bytes) -> bytes:
    """Length-prefixed chunks, read back with Reader.part()."""
    return b"".join(_var_uint(len(chunk)) + chunk for chunk in chunks)


def encode_close(code: int, reason: str) -> bytes:
    return _var_uint(code) + reason.encode()


def decode_close(reader: Reader) -> tuple[int, str]:
    code = reader.var_uint()
    return code, reader.rest().decode(errors="replace")


def encode(sender: uuid.UUID, kind: Kind, payload: bytes = b"") -> bytes:
    return bytes([VERSION]) + sender.bytes + bytes([kind]) + payload


def decode(message: bytes) -> Envelope:
    if len(message) < 18 or message[0] != VERSION:
        raise BusError("unknown message version")
    try:
        kind = Kind(message[17])
    except ValueError as exc:
        raise BusError(f"unknown message kind {message[17]}") from exc
    return Envelope(uuid.UUID(bytes=message[1:17]), kind, message[18:])


# ----- transport ----------------------------------------------------------------------------

MessageHandler = Callable[[str, bytes], None]
ActivationHandler = Callable[[str], None]


class RedisBus:
    """One subscriber connection per instance, shared by every room.

    Reconnecting is done here, not by redis-py: its client re-subscribes silently after a dropped
    connection, and the messages published in between are lost without anyone noticing. Here,
    every subscription that becomes active without a subscribe() call waiting for it (after a
    reconnect, however it happened) is reported to `on_active`, and the room re-syncs.
    """

    def __init__(
        self,
        url: str,
        publisher: Redis,
        *,
        instance_id: uuid.UUID,
        reconnect_delay: float = 1.0,
        subscribe_timeout: float = 2.0,
    ) -> None:
        self.instance_id = instance_id
        self.connected = False
        self._connected = asyncio.Event()
        # How many times the subscriber connection was re-established, for tests and logs.
        self.reconnects = 0
        self._connected_before = False
        self._publisher = publisher
        # No retries: a failure must surface here, where the re-sync happens.
        self._subscriber = Redis.from_url(
            url,
            decode_responses=False,
            retry=Retry(NoBackoff(), 0),
            health_check_interval=15,
            client_name=f"collab-bus-{self.instance_id.hex[:12]}",
        )
        self._reconnect_delay = reconnect_delay
        self._subscribe_timeout = subscribe_timeout
        self._pubsub: PubSub | None = None
        self._channels: set[str] = {CONTROL_CHANNEL}
        self._waiters: dict[str, asyncio.Future[None]] = {}
        self._reader: asyncio.Task[None] | None = None
        self._on_message: MessageHandler = lambda channel, data: None
        self._on_active: ActivationHandler = lambda channel: None

    def listen(self, on_message: MessageHandler, on_active: ActivationHandler) -> None:
        self._on_message = on_message
        self._on_active = on_active

    async def start(self) -> None:
        """Starts the reader and returns at once: Redis being down must not stop the API from
        starting, and the reader keeps trying."""
        self._reader = asyncio.create_task(self._run(), name="collab-bus")

    async def stop(self) -> None:
        if self._reader is not None:
            self._reader.cancel()
            await asyncio.gather(self._reader, return_exceptions=True)
        await self._drop_connection()
        await self._subscriber.aclose()

    async def check(self) -> None:
        """For /api/readyz, which bounds the wait."""
        await self._connected.wait()

    # ----- subscriptions ------------------------------------------------------------------

    async def subscribe(self, channel: str) -> bool:
        """Subscribes and waits until Redis confirms, so that nothing published from then on is
        missed. Returns False if that could not be confirmed (Redis down): the subscription is
        then made, and reported to on_active, when the connection comes back."""
        self._channels.add(channel)
        pubsub = self._pubsub
        if not self.connected or pubsub is None:
            return False
        waiter = asyncio.get_running_loop().create_future()
        self._waiters[channel] = waiter
        try:
            await pubsub.subscribe(channel)
            await asyncio.wait_for(waiter, self._subscribe_timeout)
            return True
        except Exception as exc:
            log.warning("subscribing failed; will retry on reconnect", error=repr(exc))
            return False
        finally:
            if self._waiters.get(channel) is waiter:
                del self._waiters[channel]

    async def unsubscribe(self, channel: str) -> None:
        self._channels.discard(channel)
        if self.connected and self._pubsub is not None:
            try:
                await self._pubsub.unsubscribe(channel)
            except Exception as exc:
                # Harmless: messages for rooms that are gone are ignored.
                log.warning("unsubscribing failed", error=repr(exc))

    async def publish(self, channel: str, message: bytes) -> int | None:
        """Returns how many subscribers got the message (this instance's own subscription
        included), or None if Redis did not take it; callers decide whether to retry."""
        try:
            receivers: int = await self._publisher.publish(channel, message)
        except Exception as exc:
            log.warning("publishing failed", error=repr(exc))
            return None
        return receivers

    # ----- reader -------------------------------------------------------------------------

    async def _run(self) -> None:
        while True:
            try:
                await self._connect()
                await self._read()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if self.connected:
                    log.warning("pub/sub connection lost", error=repr(exc))
                self.connected = False
                self._connected.clear()
                await self._drop_connection()
                await asyncio.sleep(self._reconnect_delay)

    async def _connect(self) -> None:
        pubsub = self._subscriber.pubsub()
        self._pubsub = pubsub
        # Every channel at once; their confirmations arrive in _read and trigger re-syncs.
        await pubsub.subscribe(*sorted(self._channels))
        if self._connected_before:
            self.reconnects += 1
            log.info("pub/sub reconnected", channels=len(self._channels))
        self._connected_before = True
        self.connected = True
        self._connected.set()

    async def _read(self) -> None:
        assert self._pubsub is not None
        while True:
            message = await self._pubsub.get_message(timeout=1.0)
            if message is None:
                continue
            kind = message["type"]
            channel = message["channel"]
            channel = channel.decode() if isinstance(channel, bytes) else str(channel)
            if kind == "message":
                try:
                    self._on_message(channel, message["data"])
                except Exception:
                    log.exception("handling a pub/sub message failed", channel=channel)
            elif kind == "subscribe":
                waiter = self._waiters.pop(channel, None)
                if waiter is not None and not waiter.done():
                    waiter.set_result(None)  # the subscribe() call re-syncs its room itself
                elif channel in self._channels:
                    self._on_active(channel)  # re-subscribed after a reconnect

    async def _drop_connection(self) -> None:
        pubsub, self._pubsub = self._pubsub, None
        for waiter in self._waiters.values():
            if not waiter.done():
                waiter.set_exception(ConnectionError("pub/sub connection lost"))
        self._waiters.clear()
        if pubsub is not None:
            try:
                await pubsub.aclose()  # type: ignore[no-untyped-call]  # untyped in redis-py
            except Exception as exc:
                log.debug("closing the old pub/sub connection failed", error=repr(exc))
