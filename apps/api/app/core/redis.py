from redis.asyncio import Redis


def create_redis(redis_url: str) -> Redis:
    return Redis.from_url(redis_url, decode_responses=False)


async def ping_redis(client: Redis) -> None:
    await client.ping()
