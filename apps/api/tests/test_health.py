import asyncio

import pytest
from fastapi import FastAPI
from httpx import AsyncClient

from app.core.config import Settings


async def test_healthz_is_ok(client: AsyncClient) -> None:
    response = await client.get("/api/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "release": "unknown"}


async def test_healthz_names_the_deployed_commit(settings: Settings) -> None:
    from httpx import ASGITransport

    from app.main import create_app

    app = create_app(
        settings.model_copy(update={"release": "41421ad6c0ffee0123456789abcdef0123456789"})
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        response = await client.get("/api/healthz")

    assert response.json() == {"status": "ok", "release": "41421ad6c0ff"}


def test_render_sets_the_release(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RENDER_GIT_COMMIT", "abc123")

    assert Settings().release == "abc123"


async def test_readyz_ok_when_all_dependencies_answer(client: AsyncClient) -> None:
    response = await client.get("/api/readyz")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "checks": {
            "database": {"status": "ok", "detail": None},
            "redis": {"status": "ok", "detail": None},
        },
    }


async def test_readyz_503_without_leaking_error_message(app: FastAPI, client: AsyncClient) -> None:
    async def redis_down() -> None:
        raise ConnectionError("redis://default:hunter2@cache.internal:6379")

    app.state.readiness_checks["redis"] = redis_down

    response = await client.get("/api/readyz")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "error"
    assert body["checks"]["database"]["status"] == "ok"
    assert body["checks"]["redis"] == {"status": "error", "detail": "ConnectionError"}
    assert "hunter2" not in response.text


async def test_readyz_times_out_slow_dependency(app: FastAPI, client: AsyncClient) -> None:
    async def slow_database() -> None:
        await asyncio.sleep(5)

    app.state.readiness_checks["database"] = slow_database

    response = await client.get("/api/readyz")

    assert response.status_code == 503
    assert response.json()["checks"]["database"]["detail"] == "timed out after 0.2s"


async def test_response_carries_generated_request_id(client: AsyncClient) -> None:
    response = await client.get("/api/healthz")

    request_id = response.headers["x-request-id"]
    assert len(request_id) == 32
    assert request_id.isalnum()


async def test_valid_incoming_request_id_is_echoed(client: AsyncClient) -> None:
    response = await client.get("/api/healthz", headers={"X-Request-ID": "trace-abc-123"})

    assert response.headers["x-request-id"] == "trace-abc-123"


async def test_unsafe_incoming_request_id_is_replaced(client: AsyncClient) -> None:
    response = await client.get("/api/healthz", headers={"X-Request-ID": "evil\nlog line"})

    assert response.headers["x-request-id"] != "evil\nlog line"
    assert len(response.headers["x-request-id"]) == 32


async def test_cors_preflight_allows_frontend_origin(client: AsyncClient) -> None:
    response = await client.options(
        "/api/healthz",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert response.headers["access-control-allow-credentials"] == "true"


async def test_cors_rejects_unknown_origin(client: AsyncClient) -> None:
    response = await client.options(
        "/api/healthz",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert "access-control-allow-origin" not in response.headers
