import asyncio
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

import asyncpg
import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.engine import make_url

from app.core.config import Settings
from app.core.db import Base
from app.main import create_app

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://collabedit:collabedit@localhost:5433/collabedit_test",
)
TEST_REDIS_URL = os.environ.get("TEST_REDIS_URL", "redis://localhost:6380/15")
API_ROOT = Path(__file__).resolve().parents[1]


def alembic_config(database_url: str) -> Config:
    config = Config(str(API_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(API_ROOT / "alembic"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


async def _recreate_schema(database_url: str) -> None:
    url = make_url(database_url)
    connect = {
        "user": url.username,
        "password": url.password,
        "host": url.host,
        "port": url.port,
    }
    try:
        admin = await asyncpg.connect(database="postgres", **connect)
    except OSError as exc:
        pytest.exit(
            f"Postgres is not reachable ({exc}). Start it with: "
            "docker compose -f infra/docker-compose.yml up -d",
            returncode=2,
        )
    try:
        exists = await admin.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", url.database)
        if not exists:
            await admin.execute(f'CREATE DATABASE "{url.database}"')
    finally:
        await admin.close()

    conn = await asyncpg.connect(database=url.database, **connect)
    try:
        await conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
    finally:
        await conn.close()


@pytest.fixture(scope="session")
def database_url() -> str:
    """A fresh test database built by the real migrations, once per test run."""
    asyncio.run(_recreate_schema(TEST_DATABASE_URL))
    command.upgrade(alembic_config(TEST_DATABASE_URL), "head")
    return TEST_DATABASE_URL


@pytest.fixture
def settings(database_url: str) -> Settings:
    return Settings(
        env="test",
        database_url=database_url,
        redis_url=TEST_REDIS_URL,
        frontend_url="http://localhost:5173",
        readiness_timeout=0.2,
        jwt_secret="test-jwt-secret-that-is-long-enough-0123456789",
        # Tests about limits turn this on; elsewhere it would make test order matter.
        rate_limit_enabled=False,
        # Evict rooms as soon as the last client leaves and save almost immediately, so tests
        # can observe persistence without waiting.
        collab_room_grace_seconds=0,
        collab_flush_interval_seconds=0.01,
    )


@pytest.fixture
async def app(settings: Settings) -> AsyncIterator[FastAPI]:
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        await reset_state(app)
        yield app


async def reset_state(app: FastAPI) -> None:
    tables = ", ".join(f'"{table.name}"' for table in Base.metadata.sorted_tables)
    async with app.state.db_engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    await app.state.redis.flushdb()


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver.local") as client:
        yield client


@dataclass
class RegisteredUser:
    id: str
    email: str
    name: str
    password: str
    access_token: str

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}"}


async def register(
    client: AsyncClient,
    email: str = "ada@example.com",
    name: str = "Ada Lovelace",
    password: str = "correct horse battery",
) -> RegisteredUser:
    response = await client.post(
        "/api/auth/register", json={"email": email, "name": name, "password": password}
    )
    assert response.status_code == 201, response.text
    body = response.json()
    return RegisteredUser(body["user"]["id"], email, name, password, body["access_token"])
