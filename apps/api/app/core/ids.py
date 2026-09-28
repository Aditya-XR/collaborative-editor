import os
import time
import uuid

_48_BITS = (1 << 48) - 1


def uuid7() -> uuid.UUID:
    """RFC 9562 UUIDv7: 48-bit Unix milliseconds, then random bits.

    Ids sort by creation time, which keeps B-tree inserts local, and a browser can mint one
    offline without asking the server. Python 3.14 ships uuid.uuid7; this backfills 3.13.
    """
    unix_ms = time.time_ns() // 1_000_000
    value = (unix_ms & _48_BITS) << 80 | int.from_bytes(os.urandom(10), "big")
    value = (value & ~(0xF << 76)) | (0x7 << 76)  # version 7
    value = (value & ~(0x3 << 62)) | (0x2 << 62)  # RFC 4122 variant
    return uuid.UUID(int=value)
