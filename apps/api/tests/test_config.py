import pytest
from pydantic import ValidationError

from app.core.config import Settings

SECRET = "x" * 40


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        (
            "postgresql://neondb_owner:pa%40ss@ep-cool-1.eu-central-1.aws.neon.tech/neondb"
            "?sslmode=require&channel_binding=require",
            "postgresql+asyncpg://neondb_owner:pa%40ss@ep-cool-1.eu-central-1.aws.neon.tech/neondb"
            "?ssl=require",
        ),
        ("postgres://u:p@localhost:5432/db", "postgresql+asyncpg://u:p@localhost:5432/db"),
        (
            "postgresql+asyncpg://u:p@localhost/db?ssl=require",
            "postgresql+asyncpg://u:p@localhost/db?ssl=require",
        ),
    ],
    ids=["neon", "heroku-style", "already-asyncpg"],
)
def test_database_urls_are_adapted_for_asyncpg(given: str, expected: str) -> None:
    assert Settings(database_url=given).database_url == expected


def test_production_requires_a_real_jwt_secret() -> None:
    with pytest.raises(ValidationError, match="JWT_SECRET"):
        Settings(env="production", cookie_secure=True)


def test_production_requires_secure_cookies() -> None:
    with pytest.raises(ValidationError, match="COOKIE_SECURE"):
        Settings(env="production", jwt_secret=SECRET, cookie_secure=False)


def test_valid_production_settings() -> None:
    settings = Settings(env="production", jwt_secret=SECRET, cookie_secure=True)

    assert settings.is_production


def test_config_errors_never_echo_secrets() -> None:
    with pytest.raises(ValidationError) as caught:
        Settings(
            env="production",
            cookie_secure=True,
            database_url="postgresql://user:hunter2-db-password@db.example/app",
        )

    message = str(caught.value)
    assert "hunter2-db-password" not in message
    # Not even truncated input: pydantic's truncation happens to cut this password off, but a
    # shorter field order would not, so no input may be echoed at all.
    assert "input_value" not in message
