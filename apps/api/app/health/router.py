import asyncio
from collections.abc import Awaitable, Callable
from typing import Literal

import structlog
from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

log = structlog.get_logger()

router = APIRouter(tags=["health"])

ReadinessCheck = Callable[[], Awaitable[None]]


class CheckResult(BaseModel):
    status: Literal["ok", "error"]
    detail: str | None = None


class Readiness(BaseModel):
    status: Literal["ok", "error"]
    checks: dict[str, CheckResult]


@router.get("/healthz")
async def healthz(request: Request) -> dict[str, str]:
    """Liveness: the process is up. Never touches dependencies.

    Also names the commit running, so a deploy can be confirmed from outside.
    """
    release: str = request.app.state.settings.release
    return {"status": "ok", "release": release[:12] or "unknown"}


@router.get("/readyz", response_model=Readiness)
async def readyz(request: Request, response: Response) -> Readiness:
    """Readiness: every dependency answers in time. Returns 503 otherwise."""
    checks: dict[str, ReadinessCheck] = request.app.state.readiness_checks
    timeout: float = request.app.state.settings.readiness_timeout

    names = list(checks)
    results = await asyncio.gather(*(_run_check(name, checks[name], timeout) for name in names))
    report = dict(zip(names, results, strict=True))

    ready = all(result.status == "ok" for result in report.values())
    if not ready:
        response.status_code = 503
    return Readiness(status="ok" if ready else "error", checks=report)


async def _run_check(name: str, check: ReadinessCheck, limit_s: float) -> CheckResult:
    try:
        async with asyncio.timeout(limit_s):
            await check()
    except TimeoutError:
        log.warning("readiness check timed out", check=name, limit_s=limit_s)
        return CheckResult(status="error", detail=f"timed out after {limit_s}s")
    except Exception as exc:
        # Only the exception type is returned: messages can contain connection strings.
        log.warning("readiness check failed", check=name, error=repr(exc))
        return CheckResult(status="error", detail=type(exc).__name__)
    return CheckResult(status="ok")
