"""Sign in with Google, end to end, against a fake Google: a real RSA key and published key set,
and a token endpoint that enforces PKCE, the client secret and the redirect URI (ADR 0018)."""

import base64
import hashlib
import secrets
import time
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from httpx import AsyncClient
from pydantic import SecretStr

from app.auth.google import GoogleClient
from app.core.config import Settings
from tests.conftest import mark_verified, register

CLIENT_ID = "test-client.apps.googleusercontent.com"
CLIENT_SECRET = "test-client-secret"
GOOGLE = "https://google.test"
WEB = "http://localhost:5173"


class FakeGoogle:
    def __init__(self) -> None:
        self.rotate_key()
        self.jwks_fetches = 0
        self.pending: dict[str, dict[str, Any]] = {}  # code -> what the authorize step saw
        # Changes to the next ID token, to test what the server must refuse.
        self.tamper: dict[str, Any] = {}
        self.sign_with_another_key = False

    def rotate_key(self) -> None:
        self.private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.kid = secrets.token_hex(4)

    def approve(self, authorize_url: str, **identity: Any) -> str:
        """The person picks their account on Google's screen; Google issues a code."""
        query = {key: values[0] for key, values in parse_qs(urlparse(authorize_url).query).items()}
        code = secrets.token_urlsafe(16)
        self.pending[code] = {
            "redirect_uri": query["redirect_uri"],
            "challenge": query["code_challenge"],
            "nonce": query["nonce"],
            "claims": {
                "sub": "google-sub-1",
                "email": "Grace@Example.com",
                "email_verified": True,
                "name": "Grace Hopper",
                "picture": "https://lh3.googleusercontent.com/a/grace",
                **identity,
            },
        }
        return code

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/jwks":
            self.jwks_fetches += 1
            jwk = jwt.algorithms.RSAAlgorithm.to_jwk(self.private_key.public_key(), as_dict=True)
            return httpx.Response(200, json={"keys": [{**jwk, "kid": self.kid, "alg": "RS256"}]})
        assert request.url.path == "/token"
        form = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
        grant = self.pending.pop(form.get("code", ""), None)
        verifier = form.get("code_verifier", "")
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .rstrip(b"=")
            .decode()
        )
        if (
            grant is None
            or form.get("client_id") != CLIENT_ID
            or form.get("client_secret") != CLIENT_SECRET
            or form.get("redirect_uri") != grant["redirect_uri"]
            or challenge != grant["challenge"]
        ):
            return httpx.Response(400, json={"error": "invalid_grant"})
        now = int(time.time())
        claims = {
            "iss": "https://accounts.google.com",
            "aud": CLIENT_ID,
            "iat": now,
            "exp": now + 3600,
            "nonce": grant["nonce"],
            **grant["claims"],
            **self.tamper,
        }
        key = (
            rsa.generate_private_key(public_exponent=65537, key_size=2048)
            if self.sign_with_another_key
            else self.private_key
        )
        token = jwt.encode(claims, key, algorithm="RS256", headers={"kid": self.kid})
        return httpx.Response(200, json={"id_token": token, "token_type": "Bearer"})


@pytest.fixture
def fake_google(app: FastAPI, settings: Settings) -> FakeGoogle:
    fake = FakeGoogle()
    configured = settings.model_copy(
        update={
            "google_client_id": CLIENT_ID,
            "google_client_secret": SecretStr(CLIENT_SECRET),
            "google_authorize_url": f"{GOOGLE}/authorize",
            "google_token_url": f"{GOOGLE}/token",
            "google_jwks_url": f"{GOOGLE}/jwks",
        }
    )
    app.state.google = GoogleClient(
        configured, httpx.AsyncClient(transport=httpx.MockTransport(fake.handle))
    )
    return fake


async def start(client: AsyncClient, next_path: str = "/") -> str:
    response = await client.get("/api/auth/google/start", params={"next": next_path})
    assert response.status_code == 302, response.text
    location: str = response.headers["location"]
    return location


def state_of(authorize_url: str) -> str:
    return parse_qs(urlparse(authorize_url).query)["state"][0]


async def sign_in(
    client: AsyncClient, google: FakeGoogle, next_path: str = "/", **identity: Any
) -> httpx.Response:
    authorize_url = await start(client, next_path)
    code = google.approve(authorize_url, **identity)
    return await client.get(
        "/api/auth/google/callback", params={"code": code, "state": state_of(authorize_url)}
    )


async def session_of(client: AsyncClient) -> dict[str, Any]:
    response = await client.post("/api/auth/refresh")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def password_login(client: AsyncClient, email: str, password: str) -> int:
    response = await client.post("/api/auth/login", json={"email": email, "password": password})
    return response.status_code


# ----- the flow ---------------------------------------------------------------------------------


async def test_first_sign_in_creates_a_verified_account_without_a_password(
    client: AsyncClient, fake_google: FakeGoogle
) -> None:
    authorize_url = await start(client, "/d/0192-abc")
    query = parse_qs(urlparse(authorize_url).query)
    assert authorize_url.startswith(f"{GOOGLE}/authorize?")
    assert query["client_id"] == [CLIENT_ID]
    assert query["redirect_uri"] == [f"{WEB}/api/auth/google/callback"]
    assert query["scope"] == ["openid email profile"]
    assert query["response_type"] == ["code"]
    assert query["code_challenge_method"] == ["S256"]

    code = fake_google.approve(authorize_url)
    response = await client.get(
        "/api/auth/google/callback", params={"code": code, "state": state_of(authorize_url)}
    )

    assert response.status_code == 302
    assert response.headers["location"] == f"{WEB}/d/0192-abc"
    user = (await session_of(client))["user"]
    assert user["email"] == "grace@example.com"
    assert user["name"] == "Grace Hopper"
    assert user["email_verified"] is True
    assert user["has_password"] is False
    assert user["avatar_url"] == "https://lh3.googleusercontent.com/a/grace"
    # No password exists to guess.
    assert await password_login(client, "grace@example.com", "anything at all") == 401


async def test_a_returning_person_is_found_by_googles_id_not_their_address(
    client: AsyncClient, fake_google: FakeGoogle
) -> None:
    await sign_in(client, fake_google)
    first = (await session_of(client))["user"]["id"]

    await sign_in(client, fake_google, email="grace.hopper@navy.example")

    again = (await session_of(client))["user"]
    assert again["id"] == first
    assert again["email"] == "grace@example.com"  # the account keeps its own address


async def test_google_joins_an_account_whose_address_is_verified(
    app: FastAPI, client: AsyncClient, fake_google: FakeGoogle
) -> None:
    grace = await register(
        client, email="grace@example.com", name="Grace", password="hunter2 hunter2"
    )
    await mark_verified(app, grace)

    await sign_in(client, fake_google)

    assert (await session_of(client))["user"]["id"] == grace.id
    # The password still works: the same person, now with two ways in.
    assert await password_login(client, "grace@example.com", "hunter2 hunter2") == 200


async def test_google_evicts_whoever_registered_the_address_without_proving_it(
    app: FastAPI, client: AsyncClient, fake_google: FakeGoogle
) -> None:
    """Account pre-hijacking: an attacker registers the victim's address, waits for the victim
    to sign in with Google, and keeps a way in. The attacker's password and sessions go."""
    from httpx import ASGITransport

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://attacker.local"
    ) as attacker:
        squatter = await register(
            attacker, email="grace@example.com", name="Not Grace", password="attacker's password"
        )

        await sign_in(client, fake_google)

        victim = (await session_of(client))["user"]
        assert victim["id"] == squatter.id  # the address's account, now Grace's
        assert victim["email_verified"] is True
        assert victim["has_password"] is False
        assert await password_login(attacker, "grace@example.com", "attacker's password") == 401
        refreshed = await attacker.post("/api/auth/refresh")
        assert refreshed.status_code == 401


async def test_an_address_google_has_not_verified_is_refused(
    client: AsyncClient, fake_google: FakeGoogle
) -> None:
    response = await sign_in(client, fake_google, email_verified=False)

    assert response.headers["location"] == f"{WEB}/login?error=google_email_unverified"
    assert (await client.post("/api/auth/refresh")).status_code == 401


# ----- what the callback must refuse ------------------------------------------------------------


async def test_only_the_browser_that_started_can_finish(
    app: FastAPI, client: AsyncClient, fake_google: FakeGoogle
) -> None:
    """Login CSRF: an attacker's own callback URL, opened in the victim's browser, would sign
    the victim into the attacker's account. The state cookie stops it."""
    from httpx import ASGITransport

    authorize_url = await start(client)
    code = fake_google.approve(authorize_url)
    callback = {"code": code, "state": state_of(authorize_url)}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as victim:
        elsewhere = await victim.get("/api/auth/google/callback", params=callback)
    assert elsewhere.headers["location"] == f"{WEB}/login?error=google_failed"


async def test_a_callback_works_once(client: AsyncClient, fake_google: FakeGoogle) -> None:
    authorize_url = await start(client)
    callback = {"code": fake_google.approve(authorize_url), "state": state_of(authorize_url)}

    first = await client.get("/api/auth/google/callback", params=callback)
    client.cookies.set("google_state", callback["state"], path="/api/auth/google")
    again = await client.get("/api/auth/google/callback", params=callback)

    assert first.headers["location"] == f"{WEB}/"
    assert again.headers["location"] == f"{WEB}/login?error=google_failed"


@pytest.mark.parametrize(
    "tamper",
    [
        {"aud": "someone-elses-client.apps.googleusercontent.com"},
        {"iss": "https://accounts.evil.example"},
        {"nonce": "from-another-sign-in"},
        {"exp": int(time.time()) - 3600},
    ],
    ids=["audience", "issuer", "nonce", "expired"],
)
async def test_an_id_token_that_is_not_for_us_is_refused(
    client: AsyncClient, fake_google: FakeGoogle, tamper: dict[str, Any]
) -> None:
    fake_google.tamper = tamper

    response = await sign_in(client, fake_google)

    assert response.headers["location"] == f"{WEB}/login?error=google_failed"


async def test_an_id_token_not_signed_by_google_is_refused(
    client: AsyncClient, fake_google: FakeGoogle
) -> None:
    fake_google.sign_with_another_key = True

    response = await sign_in(client, fake_google)

    assert response.headers["location"] == f"{WEB}/login?error=google_failed"


async def test_a_code_with_the_wrong_pkce_verifier_is_refused(
    client: AsyncClient, fake_google: FakeGoogle
) -> None:
    """Google checks the verifier against the challenge from the start: a stolen code is
    useless without the verifier, which never leaves the server."""
    first = await start(client)
    second = await start(client)
    code = fake_google.approve(first)
    # Finish with the code from the first attempt but the second attempt's state (and so its
    # verifier): Google sees a verifier that does not match the code's challenge.
    response = await client.get(
        "/api/auth/google/callback", params={"code": code, "state": state_of(second)}
    )
    assert response.headers["location"] == f"{WEB}/login?error=google_failed"


async def test_cancelling_on_google_returns_to_sign_in(
    client: AsyncClient, fake_google: FakeGoogle
) -> None:
    authorize_url = await start(client)

    response = await client.get(
        "/api/auth/google/callback",
        params={"error": "access_denied", "state": state_of(authorize_url)},
    )

    assert response.headers["location"] == f"{WEB}/login?error=google_cancelled"
    assert "google_state=" in response.headers["set-cookie"]  # cleared


@pytest.mark.parametrize(
    "next_path", ["//evil.example/", "https://evil.example/", "/\\evil.example"]
)
async def test_the_return_path_cannot_leave_the_site(
    client: AsyncClient, fake_google: FakeGoogle, next_path: str
) -> None:
    response = await sign_in(client, fake_google, next_path=next_path)

    assert response.headers["location"] == f"{WEB}/"


# ----- keys and configuration -------------------------------------------------------------------


async def test_new_signing_keys_are_fetched_when_google_rotates(
    client: AsyncClient, fake_google: FakeGoogle
) -> None:
    await sign_in(client, fake_google)
    assert fake_google.jwks_fetches == 1
    await sign_in(client, fake_google)
    assert fake_google.jwks_fetches == 1  # cached

    fake_google.rotate_key()
    response = await sign_in(client, fake_google)

    assert response.headers["location"] == f"{WEB}/"
    assert fake_google.jwks_fetches == 2


async def test_google_sign_in_is_off_without_credentials(client: AsyncClient) -> None:
    options = await client.get("/api/auth/options")
    started = await client.get("/api/auth/google/start")

    assert options.json() == {"google": False}
    assert started.status_code == 404
    assert started.json()["code"] == "google_disabled"


async def test_options_say_when_google_is_on(client: AsyncClient, fake_google: FakeGoogle) -> None:
    assert (await client.get("/api/auth/options")).json() == {"google": True}
