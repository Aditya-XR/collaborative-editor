"""Password reset and email verification: single-use links sent by email (ADR 0018)."""

import re
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update

from app.auth.models import AccountToken, User
from app.core.config import Settings
from app.core.mail import Email
from app.core.security import hash_token
from app.main import create_app
from tests.conftest import Outbox, register, reset_state


def token_in(email: Email, page: str) -> str:
    match = re.search(rf"http://localhost:5173/{page}#token=([\w-]+)", email.text)
    assert match, email.text
    return match.group(1)


async def forgot(client: AsyncClient, email: str) -> Any:
    response = await client.post("/api/auth/password/forgot", json={"email": email})
    assert response.status_code == 202, response.text
    return response.json()


async def reset(client: AsyncClient, token: str, password: str) -> Any:
    return await client.post(
        "/api/auth/password/reset", json={"token": token, "password": password}
    )


async def login(client: AsyncClient, email: str, password: str) -> int:
    response = await client.post("/api/auth/login", json={"email": email, "password": password})
    return response.status_code


async def expire_tokens(app: FastAPI) -> None:
    async with app.state.sessionmaker() as session:
        await session.execute(
            update(AccountToken).values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await session.commit()


# ----- password reset ---------------------------------------------------------------------------


async def test_a_reset_link_sets_a_new_password_and_signs_out_everywhere(
    client: AsyncClient, outbox: Outbox
) -> None:
    ada = await register(client, password="old password 123")
    outbox.sent.clear()

    await forgot(client, "  ADA@example.com ")

    [email] = outbox.sent
    assert email.to == "ada@example.com"
    assert email.subject == "Reset your CollabEdit password"
    response = await reset(client, token_in(email, "reset-password"), "new password 456")
    assert response.status_code == 204
    assert await login(client, ada.email, "old password 123") == 401
    # The session from before the reset is gone too; the new password opens a new one.
    assert (await client.get("/api/me", headers=ada.headers)).status_code == 200  # access JWT
    assert (await client.post("/api/auth/refresh")).status_code == 401
    assert await login(client, ada.email, "new password 456") == 200
    me = (await client.post("/api/auth/refresh")).json()["user"]
    assert me["email_verified"] is True  # the link reached the inbox: it is theirs


async def test_unknown_addresses_get_the_same_answer_and_no_email(
    client: AsyncClient, outbox: Outbox
) -> None:
    await register(client)
    outbox.sent.clear()

    known = await forgot(client, "ada@example.com")
    unknown = await forgot(client, "nobody@example.com")

    assert known == unknown
    assert [email.to for email in outbox.sent] == ["ada@example.com"]


async def test_a_reset_link_works_once_and_only_the_newest_one(
    client: AsyncClient, outbox: Outbox
) -> None:
    await register(client)
    outbox.sent.clear()
    await forgot(client, "ada@example.com")
    await forgot(client, "ada@example.com")
    older, newer = (token_in(email, "reset-password") for email in outbox.sent)

    refused = await reset(client, older, "another password")
    accepted = await reset(client, newer, "another password")
    replayed = await reset(client, newer, "yet another password")

    assert refused.json()["code"] == "invalid_token"
    assert accepted.status_code == 204
    assert replayed.json()["code"] == "invalid_token"


async def test_an_expired_reset_link_is_refused(
    app: FastAPI, client: AsyncClient, outbox: Outbox
) -> None:
    await register(client)
    outbox.sent.clear()
    await forgot(client, "ada@example.com")
    await expire_tokens(app)

    response = await reset(client, token_in(outbox.sent[0], "reset-password"), "too late now")

    assert response.status_code == 400
    assert response.json()["code"] == "token_expired"


async def test_a_google_only_account_can_add_a_password(
    app: FastAPI, client: AsyncClient, outbox: Outbox
) -> None:
    async with app.state.sessionmaker() as session:
        session.add(User(email="grace@example.com", name="Grace", password_hash=None))
        await session.commit()

    await forgot(client, "grace@example.com")
    await reset(client, token_in(outbox.sent[0], "reset-password"), "now with a password")

    assert await login(client, "grace@example.com", "now with a password") == 200


async def test_reset_validates_the_password(client: AsyncClient) -> None:
    response = await reset(client, "whatever", "short")

    assert response.status_code == 422


async def test_reset_emails_are_limited_per_address(settings: Settings) -> None:
    limited = create_app(settings.model_copy(update={"rate_limit_enabled": True}))
    async with limited.router.lifespan_context(limited):
        await reset_state(limited)
        async with AsyncClient(
            transport=ASGITransport(app=limited), base_url="http://test.local"
        ) as client:
            statuses = [
                (
                    await client.post(
                        "/api/auth/password/forgot", json={"email": "victim@example.com"}
                    )
                ).status_code
                for _ in range(4)
            ]

    assert statuses == [202, 202, 202, 429]


# ----- email verification -----------------------------------------------------------------------


async def test_sign_up_emails_a_link_that_verifies_the_address(
    client: AsyncClient, outbox: Outbox
) -> None:
    ada = await register(client)
    [email] = outbox.sent
    assert email.to == "ada@example.com"
    assert email.subject == "Confirm your email for CollabEdit"
    assert (await client.get("/api/me", headers=ada.headers)).json()["email_verified"] is False

    token = token_in(email, "verify-email")
    # No sign-in needed: the link may open in another browser.
    first = await client.post("/api/auth/email/verify", json={"token": token})
    again = await client.post("/api/auth/email/verify", json={"token": token})

    assert first.status_code == 200
    assert first.json()["email_verified"] is True
    assert again.status_code == 200  # clicked twice: still fine
    assert (await client.get("/api/me", headers=ada.headers)).json()["email_verified"] is True


async def test_resending_replaces_the_link(client: AsyncClient, outbox: Outbox) -> None:
    ada = await register(client)
    resent = await client.post("/api/auth/email/resend", headers=ada.headers)
    assert resent.status_code == 202
    first, second = (token_in(email, "verify-email") for email in outbox.sent)

    old = await client.post("/api/auth/email/verify", json={"token": first})
    new = await client.post("/api/auth/email/verify", json={"token": second})
    after = await client.post("/api/auth/email/resend", headers=ada.headers)

    assert old.json()["code"] == "invalid_token"
    assert new.json()["email_verified"] is True
    assert after.status_code == 409
    assert after.json()["code"] == "already_verified"


async def test_bad_and_expired_verification_links_are_refused(
    app: FastAPI, client: AsyncClient, outbox: Outbox
) -> None:
    await register(client)
    bogus = await client.post("/api/auth/email/verify", json={"token": "made-up"})
    await expire_tokens(app)
    expired = await client.post(
        "/api/auth/email/verify", json={"token": token_in(outbox.sent[0], "verify-email")}
    )

    assert bogus.json()["code"] == "invalid_token"
    assert expired.json()["code"] == "token_expired"


async def test_tokens_are_stored_hashed(app: FastAPI, client: AsyncClient, outbox: Outbox) -> None:
    await register(client)
    token = token_in(outbox.sent[0], "verify-email")

    async with app.state.sessionmaker() as session:
        stored = list(await session.scalars(select(AccountToken.token_hash)))

    assert stored == [hash_token(token)]
