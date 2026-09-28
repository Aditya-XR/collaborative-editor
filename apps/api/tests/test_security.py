import time
import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from argon2 import PasswordHasher

from app.core.ids import uuid7
from app.core.security import (
    InvalidTokenError,
    TokenExpiredError,
    create_access_token,
    decode_access_token,
    hash_password,
    hash_refresh_token,
    new_refresh_token,
    verify_password,
)

SECRET = "unit-test-secret-" + "x" * 56  # >= 64 bytes, long enough even for HS512


def test_uuid7_has_version_7_and_rfc_variant() -> None:
    value = uuid7()

    assert value.version == 7
    assert value.variant == uuid.RFC_4122


def test_uuid7_embeds_current_unix_milliseconds() -> None:
    embedded_ms = uuid7().int >> 80

    assert abs(embedded_ms - time.time() * 1000) < 1000


def test_uuid7_sorts_by_creation_time() -> None:
    earlier = uuid7()
    time.sleep(0.002)
    later = uuid7()

    assert earlier < later


async def test_password_hash_verifies_only_the_right_password() -> None:
    stored = await hash_password("correct horse battery")

    assert stored.startswith("$argon2id$")
    assert await verify_password(stored, "correct horse battery") == (True, None)
    assert await verify_password(stored, "wrong horse battery") == (False, None)


async def test_unknown_account_never_matches() -> None:
    assert await verify_password(None, "anything at all") == (False, None)


async def test_outdated_hash_parameters_trigger_a_rehash() -> None:
    weak = PasswordHasher(time_cost=1, memory_cost=8 * 1024, parallelism=1).hash("pw-12345678")

    matches, new_hash = await verify_password(weak, "pw-12345678")

    assert matches
    assert new_hash is not None and new_hash != weak
    assert await verify_password(new_hash, "pw-12345678") == (True, None)


def test_access_token_round_trip() -> None:
    user_id = uuid7()
    token = create_access_token(
        user_id, secret=SECRET, ttl=timedelta(minutes=15), now=datetime.now(UTC)
    )

    assert decode_access_token(token, secret=SECRET) == user_id


def test_expired_access_token_is_distinguished() -> None:
    issued = datetime.now(UTC) - timedelta(hours=1)
    token = create_access_token(uuid7(), secret=SECRET, ttl=timedelta(minutes=15), now=issued)

    with pytest.raises(TokenExpiredError):
        decode_access_token(token, secret=SECRET)


@pytest.mark.parametrize(
    "token",
    [
        "not-a-jwt",
        create_access_token(
            uuid7(),
            secret="some-other-secret-0123456789abcdef",
            ttl=timedelta(minutes=5),
            now=datetime.now(UTC),
        ),
        jwt.encode(
            {
                "sub": str(uuid7()),
                "typ": "refresh",
                "iat": datetime.now(UTC),
                "exp": datetime.now(UTC) + timedelta(minutes=5),
            },
            SECRET,
            algorithm="HS256",
        ),
        jwt.encode(
            {
                "sub": str(uuid7()),
                "typ": "access",
                "iat": datetime.now(UTC),
                "exp": datetime.now(UTC) + timedelta(minutes=5),
            },
            SECRET,
            algorithm="HS512",
        ),
        jwt.encode({"sub": str(uuid7()), "typ": "access"}, SECRET, algorithm="HS256"),
    ],
    ids=["garbage", "wrong-secret", "wrong-type", "wrong-algorithm", "no-expiry"],
)
def test_invalid_access_tokens_are_rejected(token: str) -> None:
    with pytest.raises(InvalidTokenError):
        decode_access_token(token, secret=SECRET)


def test_refresh_tokens_are_random_and_stored_hashed() -> None:
    first, second = new_refresh_token(), new_refresh_token()

    assert first != second
    assert len(first) >= 43  # 32 random bytes, base64url
    assert hash_refresh_token(first) == hash_refresh_token(first)
    assert first not in hash_refresh_token(first)
