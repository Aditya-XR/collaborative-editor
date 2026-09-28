import hashlib
import math
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from importlib.resources import files
from typing import Any

import structlog
from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.core.errors import ApiError

log = structlog.get_logger()

_LUA = files("app.core.ratelimit").joinpath("bucket.lua").read_text(encoding="utf-8")


@dataclass(frozen=True)
class RateLimit:
    """`capacity` requests at once, refilling to full over `period_s` seconds.

    fail_open decides what happens when Redis is unreachable: True falls back to a per-instance
    in-memory bucket (availability first); False rejects with 503 (safety first, e.g. login).
    """

    name: str
    capacity: int
    period_s: float
    fail_open: bool = True

    @property
    def rate_per_ms(self) -> float:
        return self.capacity / (self.period_s * 1000)


@dataclass(frozen=True)
class Decision:
    allowed: bool
    limit: int
    remaining: int
    retry_after_s: int  # seconds until a request would be allowed; 0 when allowed
    reset_after_s: int  # seconds until the bucket is full again


def _decision(limit: RateLimit, allowed: bool, tokens: float, retry_ms: int) -> Decision:
    return Decision(
        allowed=allowed,
        limit=limit.capacity,
        remaining=max(0, math.floor(tokens)),
        retry_after_s=math.ceil(retry_ms / 1000),
        reset_after_s=math.ceil((limit.capacity - tokens) / limit.rate_per_ms / 1000),
    )


class LocalBuckets:
    """The same token bucket in process memory: the fallback when Redis is down."""

    def __init__(self, max_keys: int = 10_000) -> None:
        self._buckets: OrderedDict[str, tuple[float, int]] = OrderedDict()
        self._max_keys = max_keys

    def hit(self, limit: RateLimit, key: str, now_ms: int) -> Decision:
        tokens, ts = self._buckets.pop(key, (float(limit.capacity), now_ms))
        if now_ms > ts:
            tokens = min(limit.capacity, tokens + (now_ms - ts) * limit.rate_per_ms)
            ts = now_ms
        if tokens >= 1:
            tokens -= 1
            allowed, retry_ms = True, 0
        else:
            allowed, retry_ms = False, math.ceil((1 - tokens) / limit.rate_per_ms)
        self._buckets[key] = (tokens, ts)
        while len(self._buckets) > self._max_keys:
            self._buckets.popitem(last=False)  # evict the least recently used key
        return _decision(limit, allowed, tokens, retry_ms)


class RateLimiter:
    def __init__(
        self,
        redis: Redis,
        *,
        enabled: bool = True,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._script: Any = redis.register_script(_LUA)
        self._enabled = enabled
        self._clock = clock
        self._local = LocalBuckets()

    async def hit(self, limit: RateLimit, key: str) -> Decision:
        if not self._enabled:
            return Decision(True, limit.capacity, limit.capacity, 0, 0)

        bucket_key = f"rl:{limit.name}:{_digest(key)}"
        now_ms = int(self._clock() * 1000)
        try:
            allowed, tokens, retry_ms = await self._script(
                keys=[bucket_key], args=[limit.capacity, limit.rate_per_ms, now_ms, 1]
            )
        except RedisError as exc:
            if not limit.fail_open:
                log.error(
                    "rate limiter unavailable, failing closed", limit=limit.name, error=repr(exc)
                )
                raise ApiError(
                    503, "rate_limiter_unavailable", "Temporarily unavailable, try again shortly"
                ) from exc
            log.warning("rate limiter unavailable, using local buckets", limit=limit.name)
            return self._local.hit(limit, bucket_key, now_ms)

        return _decision(limit, bool(allowed), float(tokens), int(retry_ms))


def _digest(key: str) -> str:
    # Keys may be emails or IPs: hash them so Redis holds no personal data and no odd characters.
    return hashlib.sha256(key.encode()).hexdigest()[:32]
