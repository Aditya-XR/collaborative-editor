"""Wire format shared with the browser: the Yjs sync protocol plus awareness.

Every WebSocket message is binary and starts with a varuint message type:
    0  SYNC       sync step 1 / step 2 / update, handled with pycrdt
    1  AWARENESS  cursors and presence; relayed, never stored
  120  HEARTBEAT  one byte from the client, echoed straight back (liveness through proxies
                  that swallow close frames; browsers cannot send WebSocket pings)
"""

import json
from dataclasses import dataclass

from pycrdt import Decoder, YMessageType, YSyncMessageType, write_var_uint

SYNC = int(YMessageType.SYNC)
AWARENESS = int(YMessageType.AWARENESS)
HEARTBEAT = 120
SYNC_STEP1 = int(YSyncMessageType.SYNC_STEP1)
SYNC_STEP2 = int(YSyncMessageType.SYNC_STEP2)
SYNC_UPDATE = int(YSyncMessageType.SYNC_UPDATE)

# y-protocols' encoding of an update that changes nothing.
EMPTY_UPDATE = b"\x00\x00"


class ProtocolError(ValueError):
    """The peer sent bytes that are not a valid message."""


@dataclass(frozen=True)
class AwarenessEntry:
    client_id: int
    clock: int
    # The client's state as a JSON string; None means "this client left".
    state: str | None


def decode_awareness(update: bytes) -> list[AwarenessEntry]:
    try:
        decoder = Decoder(update)
        entries = []
        for _ in range(decoder.read_var_uint()):
            client_id = decoder.read_var_uint()
            clock = decoder.read_var_uint()
            state = decoder.read_var_string()
            entries.append(AwarenessEntry(client_id, clock, None if state == "null" else state))
        return entries
    except (IndexError, RuntimeError, UnicodeDecodeError) as exc:
        raise ProtocolError("malformed awareness update") from exc


def encode_awareness(entries: list[AwarenessEntry]) -> bytes:
    """Encodes an awareness update.

    Written here rather than with pycrdt's Encoder, whose write_var_string prefixes the length in
    characters instead of UTF-8 bytes and so corrupts any non-ASCII name.
    """
    parts = [write_var_uint(len(entries))]
    for entry in entries:
        state = (entry.state if entry.state is not None else "null").encode()
        parts += [
            write_var_uint(entry.client_id),
            write_var_uint(entry.clock),
            write_var_uint(len(state)),
            state,
        ]
    return b"".join(parts)


def awareness_message(update: bytes) -> bytes:
    return bytes([AWARENESS]) + write_var_uint(len(update)) + update


def sync_update_message(update: bytes) -> bytes:
    return bytes([SYNC, SYNC_UPDATE]) + write_var_uint(len(update)) + update


def read_payload(message: bytes, offset: int) -> bytes:
    """Reads the length-prefixed payload that starts at `offset`."""
    try:
        decoder = Decoder(message[offset:])
        payload = decoder.read_message()
    except (IndexError, RuntimeError) as exc:
        raise ProtocolError("truncated message") from exc
    if payload is None:
        raise ProtocolError("missing payload")
    return payload


def is_valid_state_json(state: str) -> bool:
    try:
        return isinstance(json.loads(state), dict)
    except ValueError:
        return False
