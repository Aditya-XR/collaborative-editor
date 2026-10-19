"""Sign in with Google: OpenID Connect's authorization code flow with PKCE (ADR 0018).

1. /auth/google/start creates a random state, nonce and PKCE verifier, keeps them in Redis for
   ten minutes, binds the state to this browser with a cookie, and redirects to Google.
2. Google sends the browser back to /auth/google/callback with a code and the state.
3. The server checks the state against the cookie, exchanges the code (with the verifier and
   the client secret) for an ID token, and verifies the token: Google's signature from its
   published keys, issuer, audience, expiry and the nonce.

Only `openid email profile` is asked for, so Google requires no app review.
"""

import base64
import hashlib
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt
import structlog

from app.core.config import Settings

log = structlog.get_logger()

SCOPES = "openid email profile"
# How long Google's signing keys are trusted before fetching them again. Google rotates them
# every few weeks and publishes the new one well before using it; an unknown key id forces a
# fetch anyway.
JWKS_TTL_SECONDS = 3600


class GoogleSignInError(Exception):
    """Sign-in did not succeed. `code` goes to the login page as ?error=…"""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code


@dataclass(frozen=True)
class GoogleIdentity:
    subject: str  # Google's stable id for the account; emails can change, this cannot
    email: str
    email_verified: bool
    name: str
    picture: str | None


@dataclass(frozen=True)
class Attempt:
    """What /start remembers for /callback, kept in Redis under the state."""

    verifier: str
    nonce: str
    next_path: str

    def dumps(self) -> str:
        return json.dumps({"v": self.verifier, "n": self.nonce, "next": self.next_path})

    @classmethod
    def loads(cls, raw: bytes | str) -> "Attempt":
        data = json.loads(raw)
        return cls(verifier=data["v"], nonce=data["n"], next_path=data["next"])


def new_attempt(next_path: str) -> tuple[str, Attempt]:
    """A fresh state (the Redis key and cookie value) and what to remember under it."""
    return secrets.token_urlsafe(32), Attempt(
        verifier=secrets.token_urlsafe(64), nonce=secrets.token_urlsafe(32), next_path=next_path
    )


def code_challenge(verifier: str) -> str:
    """PKCE S256: base64url(sha256(verifier)) without padding (RFC 7636)."""
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


class GoogleClient:
    def __init__(self, settings: Settings, http: httpx.AsyncClient) -> None:
        self._settings = settings
        self._http = http
        self._keys: dict[str, jwt.PyJWK] = {}
        self._keys_fetched_at = 0.0

    def authorization_url(self, state: str, attempt: Attempt) -> str:
        query = {
            "client_id": self._settings.google_client_id,
            "redirect_uri": self._settings.google_redirect_uri,
            "response_type": "code",
            "scope": SCOPES,
            "state": state,
            "nonce": attempt.nonce,
            "code_challenge": code_challenge(attempt.verifier),
            "code_challenge_method": "S256",
            # Let people pick which Google account, rather than reusing whichever is signed in.
            "prompt": "select_account",
        }
        return f"{self._settings.google_authorize_url}?{urlencode(query)}"

    async def identify(self, code: str, attempt: Attempt) -> GoogleIdentity:
        """Exchanges the code for an ID token and returns who it says the person is."""
        try:
            response = await self._http.post(
                self._settings.google_token_url,
                data={
                    "code": code,
                    "client_id": self._settings.google_client_id,
                    "client_secret": self._settings.google_client_secret.get_secret_value(),
                    "redirect_uri": self._settings.google_redirect_uri,
                    "grant_type": "authorization_code",
                    "code_verifier": attempt.verifier,
                },
                headers={"Accept": "application/json"},
            )
        except httpx.HTTPError as exc:
            raise GoogleSignInError("google_unavailable", "Could not reach Google") from exc
        if response.status_code != 200:
            # Google's error body names the problem (invalid_grant: code reused or expired).
            log.warning(
                "google token exchange refused",
                status=response.status_code,
                body=response.text[:300],
            )
            raise GoogleSignInError("google_failed", "Google refused the sign-in code")
        id_token = response.json().get("id_token")
        if not isinstance(id_token, str):
            raise GoogleSignInError("google_failed", "Google sent no ID token")
        claims = await self._verify(id_token, attempt.nonce)
        email = claims.get("email")
        if not isinstance(email, str) or not email:
            raise GoogleSignInError("google_failed", "Google sent no email address")
        name = claims.get("name") if isinstance(claims.get("name"), str) else None
        picture = claims.get("picture")
        return GoogleIdentity(
            subject=str(claims["sub"]),
            email=email,
            email_verified=claims.get("email_verified") is True,
            name=(name or email.split("@")[0])[:100],
            picture=picture if isinstance(picture, str) and len(picture) <= 500 else None,
        )

    async def _verify(self, id_token: str, nonce: str) -> dict[str, Any]:
        try:
            key_id = jwt.get_unverified_header(id_token).get("kid")
            key = await self._signing_key(key_id)
            claims: dict[str, Any] = jwt.decode(
                id_token,
                key.key,
                algorithms=["RS256"],
                audience=self._settings.google_client_id,
                # Google uses both forms.
                issuer=[
                    self._settings.google_issuer,
                    self._settings.google_issuer.removeprefix("https://"),
                ],
                options={"require": ["iss", "aud", "sub", "exp", "iat"]},
                leeway=60,
            )
        except (jwt.InvalidTokenError, KeyError) as exc:
            log.warning("google id token rejected", error=repr(exc))
            raise GoogleSignInError(
                "google_failed", "Google's answer could not be verified"
            ) from exc
        # The nonce ties the token to this browser's attempt: a token made for another sign-in
        # (replayed or injected) carries another nonce.
        if not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
            raise GoogleSignInError("google_failed", "Google's answer was for another sign-in")
        return claims

    async def _signing_key(self, key_id: object) -> jwt.PyJWK:
        if not isinstance(key_id, str):
            raise KeyError("no key id")
        stale = time.monotonic() - self._keys_fetched_at > JWKS_TTL_SECONDS
        if stale or key_id not in self._keys:
            await self._fetch_keys()
        return self._keys[key_id]

    async def _fetch_keys(self) -> None:
        try:
            response = await self._http.get(self._settings.google_jwks_url)
            response.raise_for_status()
            key_set = jwt.PyJWKSet.from_dict(response.json())
        except (httpx.HTTPError, jwt.PyJWKSetError, ValueError) as exc:
            raise GoogleSignInError("google_unavailable", "Could not fetch Google's keys") from exc
        self._keys = {key.key_id: key for key in key_set.keys if key.key_id}
        self._keys_fetched_at = time.monotonic()
