import pytest
from fastapi import FastAPI
from redis.asyncio import Redis

from app.core.errors import ApiError
from app.core.ratelimit.limiter import RateLimit, RateLimiter

# 3 requests at once, refilling one token every 20 seconds.
LIMIT = RateLimit("unit", capacity=3, period_s=60)


class FakeClock:
    def __init__(self) -> None:
        self.now = 1_800_000_000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def redis(app: FastAPI) -> Redis:
    redis: Redis = app.state.redis  # the test database, flushed before each test
    return redis


@pytest.fixture
def unreachable_redis() -> Redis:
    return Redis.from_url("redis://127.0.0.1:1/0", socket_connect_timeout=0.2)


async def test_allows_a_burst_then_blocks(redis: Redis, clock: FakeClock) -> None:
    limiter = RateLimiter(redis, clock=clock)

    decisions = [await limiter.hit(LIMIT, "alice") for _ in range(4)]

    assert [d.allowed for d in decisions] == [True, True, True, False]
    assert [d.remaining for d in decisions] == [2, 1, 0, 0]
    assert decisions[-1].retry_after_s == 20
    assert decisions[-1].reset_after_s == 60


async def test_refills_one_token_per_interval(redis: Redis, clock: FakeClock) -> None:
    limiter = RateLimiter(redis, clock=clock)
    for _ in range(3):
        await limiter.hit(LIMIT, "alice")

    clock.advance(19.9)
    assert not (await limiter.hit(LIMIT, "alice")).allowed
    clock.advance(0.1)
    assert (await limiter.hit(LIMIT, "alice")).allowed

    clock.advance(3600)  # never more than capacity, however long the idle time
    decisions = [await limiter.hit(LIMIT, "alice") for _ in range(4)]
    assert [d.allowed for d in decisions] == [True, True, True, False]


async def test_buckets_are_separate_per_key_and_per_policy(redis: Redis, clock: FakeClock) -> None:
    limiter = RateLimiter(redis, clock=clock)
    other_policy = RateLimit("other", capacity=3, period_s=60)
    for _ in range(3):
        await limiter.hit(LIMIT, "alice")

    assert not (await limiter.hit(LIMIT, "alice")).allowed
    assert (await limiter.hit(LIMIT, "bob")).allowed
    assert (await limiter.hit(other_policy, "alice")).allowed


async def test_instances_share_one_bucket_through_redis(redis: Redis, clock: FakeClock) -> None:
    instance_a = RateLimiter(redis, clock=clock)
    instance_b = RateLimiter(redis, clock=clock)

    results = [
        (await instance_a.hit(LIMIT, "alice")).allowed,
        (await instance_b.hit(LIMIT, "alice")).allowed,
        (await instance_a.hit(LIMIT, "alice")).allowed,
        (await instance_b.hit(LIMIT, "alice")).allowed,
    ]

    assert results == [True, True, True, False]


async def test_skewed_clock_behind_last_writer_gets_no_refill(
    redis: Redis, clock: FakeClock
) -> None:
    ahead = RateLimiter(redis, clock=clock)
    behind_clock = FakeClock()
    behind_clock.now = clock.now - 5
    behind = RateLimiter(redis, clock=behind_clock)
    for _ in range(3):
        await ahead.hit(LIMIT, "alice")

    decision = await behind.hit(LIMIT, "alice")

    assert not decision.allowed


async def test_idle_buckets_expire_from_redis(redis: Redis, clock: FakeClock) -> None:
    limiter = RateLimiter(redis, clock=clock)
    await limiter.hit(LIMIT, "alice")

    keys = await redis.keys("rl:unit:*")
    assert len(keys) == 1
    ttl_ms = await redis.pttl(keys[0])
    assert 0 < ttl_ms <= 21_000  # time to refill one token, plus one second of slack
    assert b"alice" not in keys[0]  # keys are hashed: no emails or IPs in Redis


async def test_fail_open_policy_falls_back_to_local_buckets(
    unreachable_redis: Redis, clock: FakeClock
) -> None:
    limiter = RateLimiter(unreachable_redis, clock=clock)

    decisions = [await limiter.hit(LIMIT, "alice") for _ in range(4)]

    assert [d.allowed for d in decisions] == [True, True, True, False]


async def test_fail_closed_policy_refuses_when_redis_is_down(
    unreachable_redis: Redis, clock: FakeClock
) -> None:
    limiter = RateLimiter(unreachable_redis, clock=clock)
    strict = RateLimit("strict", capacity=3, period_s=60, fail_open=False)

    with pytest.raises(ApiError) as caught:
        await limiter.hit(strict, "alice")

    assert caught.value.status_code == 503
    assert caught.value.code == "rate_limiter_unavailable"


async def test_disabled_limiter_allows_everything(redis: Redis, clock: FakeClock) -> None:
    limiter = RateLimiter(redis, enabled=False, clock=clock)

    decisions = [await limiter.hit(LIMIT, "alice") for _ in range(10)]

    assert all(d.allowed for d in decisions)
    assert await redis.keys("rl:*") == []
