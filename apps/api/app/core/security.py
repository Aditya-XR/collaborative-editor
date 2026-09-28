import asyncio
import hashlib
import secrets
import uuid
from datetime import datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher()  # Argon2id with the library's RFC 9106 defaults

# Verified against when an email is unknown, so a miss costs as much time as a hit and response
# timing does not reveal which emails are registered.
_DUMMY_HASH = _hasher.hash("timing-equaliser-not-a-real-password")

_JWT_ALGORITHM = "HS256"


class TokenExpiredError(Exception):
    pass


class InvalidTokenError(Exception):
    pass


async def hash_password(password: str) -> str:
    # Argon2 is deliberately slow and CPU-bound; keep it off the event loop.
    return await asyncio.to_thread(_hasher.hash, password)


async def verify_password(password_hash: str | None, password: str) -> tuple[bool, str | None]:
    """Returns (matches, new_hash); new_hash is set when the stored hash should be upgraded."""
    return await asyncio.to_thread(_verify_sync, password_hash, password)


def _verify_sync(password_hash: str | None, password: str) -> tuple[bool, str | None]:
    if password_hash is None:
        try:
            _hasher.verify(_DUMMY_HASH, password)
        except VerificationError:
            pass
        return False, None
    try:
        _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False, None
    if _hasher.check_needs_rehash(password_hash):
        return True, _hasher.hash(password)
    return True, None


def create_access_token(user_id: uuid.UUID, *, secret: str, ttl: timedelta, now: datetime) -> str:
    claims = {"sub": str(user_id), "typ": "access", "iat": now, "exp": now + ttl}
    return jwt.encode(claims, secret, algorithm=_JWT_ALGORITHM)


def decode_access_token(token: str, *, secret: str) -> uuid.UUID:
    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=[_JWT_ALGORITHM],
            options={"require": ["sub", "exp", "iat"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise TokenExpiredError from exc
    except jwt.InvalidTokenError as exc:
        raise InvalidTokenError from exc
    if claims.get("typ") != "access":
        raise InvalidTokenError
    try:
        return uuid.UUID(claims["sub"])
    except ValueError as exc:
        raise InvalidTokenError from exc


def new_refresh_token() -> str:
    return secrets.token_urlsafe(32)


def hash_refresh_token(token: str) -> str:
    # 256 random bits cannot be brute-forced, so a fast hash is enough here (unlike passwords).
    return hashlib.sha256(token.encode()).hexdigest()
