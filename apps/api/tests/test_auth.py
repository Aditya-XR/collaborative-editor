import uuid
from datetime import UTC, datetime, timedelta

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import text

from app.core.config import Settings
from app.core.ids import uuid7
from app.core.security import create_access_token
from tests.conftest import register

REFRESH = "/api/auth/refresh"


async def refresh_with(client: AsyncClient, token: str) -> tuple[int, str | None, str | None]:
    """Presents one specific refresh token, bypassing the client's cookie jar."""
    client.cookies.clear()
    response = await client.post(REFRESH, headers={"Cookie": f"refresh_token={token}"})
    return response.status_code, response.json().get("code"), response.cookies.get("refresh_token")


async def test_register_returns_session_and_hardened_cookie(client: AsyncClient) -> None:
    response = await client.post(
        "/api/auth/register",
        json={"email": "Ada@Example.COM", "name": "  Ada  ", "password": "correct horse battery"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["user"]["email"] == "ada@example.com"
    assert body["user"]["name"] == "Ada"
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 900
    assert response.headers["cache-control"] == "no-store"

    cookie = response.headers["set-cookie"]
    assert cookie.startswith("refresh_token=")
    assert "HttpOnly" in cookie
    assert "Path=/api/auth" in cookie
    assert "SameSite=lax" in cookie
    assert "Max-Age=604800" in cookie


async def test_duplicate_email_is_rejected_case_insensitively(client: AsyncClient) -> None:
    await register(client, email="ada@example.com")

    response = await client.post(
        "/api/auth/register",
        json={"email": "ADA@example.com", "name": "Imposter", "password": "another password"},
    )

    assert response.status_code == 409
    assert response.json()["code"] == "email_taken"


async def test_register_validates_input(client: AsyncClient) -> None:
    cases = [
        {"email": "ada@example.com", "name": "Ada", "password": "short"},
        {"email": "not-an-email", "name": "Ada", "password": "long enough password"},
        {"email": "ada@example.com", "name": "   ", "password": "long enough password"},
        {"email": "ada@example.com", "name": "Ada", "password": "x" * 129},
    ]
    for payload in cases:
        response = await client.post("/api/auth/register", json=payload)
        assert response.status_code == 422, payload
        assert response.json()["code"] == "validation_error"


async def test_reserved_email_domains_are_rejected_with_a_reason(client: AsyncClient) -> None:
    response = await client.post(
        "/api/auth/register",
        json={"email": "demo@example.test", "name": "Demo", "password": "long enough password"},
    )

    assert response.status_code == 422
    issue = response.json()["detail"][0]
    assert issue["loc"] == ["body", "email"]
    assert "special-use or reserved" in issue["ctx"]["reason"]


async def test_passwords_are_stored_as_argon2id(app: FastAPI, client: AsyncClient) -> None:
    await register(client, password="correct horse battery")

    async with app.state.db_engine.connect() as conn:
        stored = (await conn.execute(text("SELECT password_hash FROM users"))).scalar_one()

    assert stored.startswith("$argon2id$")
    assert "correct horse battery" not in stored


async def test_login_succeeds_and_failures_look_identical(client: AsyncClient) -> None:
    await register(client, email="ada@example.com", password="correct horse battery")

    ok = await client.post(
        "/api/auth/login", json={"email": "ADA@example.com", "password": "correct horse battery"}
    )
    wrong_password = await client.post(
        "/api/auth/login", json={"email": "ada@example.com", "password": "wrong horse battery"}
    )
    unknown_email = await client.post(
        "/api/auth/login", json={"email": "nobody@example.com", "password": "wrong horse battery"}
    )

    assert ok.status_code == 200
    assert ok.json()["user"]["email"] == "ada@example.com"
    assert wrong_password.status_code == unknown_email.status_code == 401
    assert wrong_password.json() == unknown_email.json()
    assert wrong_password.json()["code"] == "invalid_credentials"


async def test_me_requires_a_valid_access_token(client: AsyncClient) -> None:
    user = await register(client)

    missing = await client.get("/api/me")
    garbage = await client.get("/api/me", headers={"Authorization": "Bearer nope"})
    valid = await client.get("/api/me", headers=user.headers)

    assert missing.status_code == 401
    assert missing.json()["code"] == "not_authenticated"
    assert missing.headers["www-authenticate"] == "Bearer"
    assert garbage.status_code == 401
    assert garbage.json()["code"] == "invalid_token"
    assert valid.status_code == 200
    assert valid.json() == {"id": user.id, "email": user.email, "name": user.name}


async def test_expired_access_token_gets_its_own_code(
    client: AsyncClient, settings: Settings
) -> None:
    user = await register(client)
    token = create_access_token(
        uuid.UUID(user.id),
        secret=settings.jwt_secret,
        ttl=timedelta(minutes=15),
        now=datetime.now(UTC) - timedelta(hours=1),
    )

    response = await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 401
    assert response.json()["code"] == "token_expired"


async def test_token_for_deleted_user_is_rejected(client: AsyncClient, settings: Settings) -> None:
    token = create_access_token(
        uuid7(), secret=settings.jwt_secret, ttl=timedelta(minutes=5), now=datetime.now(UTC)
    )

    response = await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 401
    assert response.json()["code"] == "invalid_token"


async def test_refresh_rotates_the_refresh_token(client: AsyncClient) -> None:
    await register(client)
    before = client.cookies["refresh_token"]

    response = await client.post(REFRESH)

    assert response.status_code == 200
    assert response.json()["access_token"]
    after = client.cookies["refresh_token"]
    assert after != before


async def test_reusing_a_rotated_token_revokes_the_whole_session(
    app: FastAPI, client: AsyncClient, settings: Settings
) -> None:
    app.state.settings = settings.model_copy(update={"refresh_reuse_grace_seconds": 0})
    await register(client)
    stolen = client.cookies["refresh_token"]
    rotated = (await client.post(REFRESH)).cookies["refresh_token"]

    status, code, _ = await refresh_with(client, stolen)
    assert (status, code) == (401, "refresh_token_reused")

    # The legitimate user's newer token died with the family, forcing a fresh sign-in.
    status, code, _ = await refresh_with(client, rotated)
    assert (status, code) == (401, "invalid_refresh_token")


async def test_two_tabs_refreshing_at_once_is_not_treated_as_theft(client: AsyncClient) -> None:
    await register(client)
    original = client.cookies["refresh_token"]
    rotated = (await client.post(REFRESH)).cookies["refresh_token"]

    status, code, _ = await refresh_with(client, original)
    assert (status, code) == (401, "refresh_race")

    status, _, newest = await refresh_with(client, rotated)
    assert status == 200
    assert newest is not None


async def test_expired_refresh_token_is_rejected(app: FastAPI, client: AsyncClient) -> None:
    await register(client)
    async with app.state.db_engine.begin() as conn:
        await conn.execute(text("UPDATE refresh_tokens SET expires_at = now() - interval '1 s'"))

    response = await client.post(REFRESH)

    assert response.status_code == 401
    assert response.json()["code"] == "refresh_token_expired"


async def test_refresh_without_cookie(client: AsyncClient) -> None:
    response = await client.post(REFRESH)

    assert response.status_code == 401
    assert response.json()["code"] == "no_session"


async def test_refresh_rejects_untrusted_origin(client: AsyncClient) -> None:
    await register(client)

    evil = await client.post(REFRESH, headers={"Origin": "https://evil.example"})
    ours = await client.post(REFRESH, headers={"Origin": "http://localhost:5173"})

    assert evil.status_code == 403
    assert evil.json()["code"] == "untrusted_origin"
    assert ours.status_code == 200


async def test_logout_ends_the_session_and_clears_the_cookie(client: AsyncClient) -> None:
    await register(client)
    token = client.cookies["refresh_token"]

    response = await client.post("/api/auth/logout")

    assert response.status_code == 204
    cleared = response.headers["set-cookie"]
    assert cleared.startswith('refresh_token=""') and "Max-Age=0" in cleared
    status, code, _ = await refresh_with(client, token)
    assert (status, code) == (401, "invalid_refresh_token")


async def test_logout_all_ends_every_session(client: AsyncClient) -> None:
    user = await register(client)
    first_device = client.cookies["refresh_token"]
    client.cookies.clear()
    login = await client.post(
        "/api/auth/login", json={"email": user.email, "password": user.password}
    )
    second_device = login.cookies["refresh_token"]

    response = await client.post(
        "/api/auth/logout-all",
        headers={"Authorization": f"Bearer {login.json()['access_token']}"},
    )

    assert response.status_code == 204
    for token in (first_device, second_device):
        status, code, _ = await refresh_with(client, token)
        assert (status, code) == (401, "invalid_refresh_token")
