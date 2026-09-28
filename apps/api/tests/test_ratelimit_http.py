from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.core.config import Settings
from tests.conftest import register


@pytest.fixture
def settings(settings: Settings) -> Settings:
    return settings.model_copy(update={"rate_limit_enabled": True})


@asynccontextmanager
async def client_from(app: FastAPI, ip: str) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app, client=(ip, 40000))
    async with AsyncClient(transport=transport, base_url="http://testserver.local") as client:
        yield client


async def test_login_is_limited_per_ip(app: FastAPI) -> None:
    async with client_from(app, "203.0.113.7") as client:
        attempts = [
            await client.post(
                "/api/auth/login", json={"email": f"user{i}@example.com", "password": "guess"}
            )
            for i in range(6)
        ]

    assert [r.status_code for r in attempts] == [401] * 5 + [429]
    assert [r.headers["x-ratelimit-remaining"] for r in attempts[:5]] == ["4", "3", "2", "1", "0"]
    blocked = attempts[-1]
    assert blocked.json()["code"] == "rate_limited"
    assert int(blocked.headers["retry-after"]) >= 1


async def test_login_is_limited_per_email_across_many_ips(app: FastAPI) -> None:
    statuses = []
    for i in range(11):
        async with client_from(app, f"198.51.100.{i + 1}") as client:
            response = await client.post(
                "/api/auth/login", json={"email": "ada@example.com", "password": "guess"}
            )
            statuses.append(response.status_code)

    assert statuses == [401] * 10 + [429]


async def test_registration_is_limited_per_ip(app: FastAPI) -> None:
    async with client_from(app, "192.0.2.10") as client:
        statuses = [
            (
                await client.post(
                    "/api/auth/register",
                    json={
                        "email": f"new{i}@example.com",
                        "name": "New",
                        "password": "long enough password",
                    },
                )
            ).status_code
            for i in range(4)
        ]

    assert statuses == [201, 201, 201, 429]


async def test_api_responses_carry_rate_limit_headers(client: AsyncClient) -> None:
    user = await register(client)

    response = await client.get("/api/me", headers=user.headers)

    assert response.status_code == 200
    assert response.headers["x-ratelimit-limit"] == "120"
    assert response.headers["x-ratelimit-remaining"] == "119"
    assert "x-ratelimit-reset" in response.headers
