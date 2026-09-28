from collections.abc import Awaitable, Callable

from fastapi import Request, Response

from app.core.errors import ApiError
from app.core.ratelimit.limiter import Decision, RateLimit, RateLimiter


def client_ip(request: Request) -> str:
    # uvicorn --proxy-headers rewrites request.client from X-Forwarded-For, but only for
    # proxies listed in FORWARDED_ALLOW_IPS, so clients cannot spoof their address.
    return request.client.host if request.client else "unknown"


async def enforce(request: Request, response: Response, limit: RateLimit, key: str) -> None:
    limiter: RateLimiter = request.app.state.rate_limiter
    decision = await limiter.hit(limit, key)
    headers = _headers(decision)
    if not decision.allowed:
        headers["Retry-After"] = str(max(1, decision.retry_after_s))
        raise ApiError(429, "rate_limited", "Too many requests, slow down", headers=headers)

    # One request can pass several limits (login: per IP and per email). Report the one
    # closest to blocking, and keep it on the request so the error handler adds it to 4xx
    # responses too: a failed login is exactly when a client needs to see what remains.
    tightest: dict[str, str] | None = getattr(request.state, "rate_limit_headers", None)
    if tightest is None or decision.remaining < int(tightest["X-RateLimit-Remaining"]):
        tightest = headers
    request.state.rate_limit_headers = tightest
    response.headers.update(tightest)


def limit_by_ip(limit: RateLimit) -> Callable[[Request, Response], Awaitable[None]]:
    async def dependency(request: Request, response: Response) -> None:
        await enforce(request, response, limit, client_ip(request))

    return dependency


def _headers(decision: Decision) -> dict[str, str]:
    return {
        "X-RateLimit-Limit": str(decision.limit),
        "X-RateLimit-Remaining": str(decision.remaining),
        "X-RateLimit-Reset": str(decision.reset_after_s),
    }
