from functools import lru_cache
from typing import Literal, Self

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url

# Placeholder for local dev only; the validator below refuses it in production.
_DEV_JWT_SECRET = "dev-only-insecure-jwt-secret-change-me-in-production"  # noqa: S105


class Settings(BaseSettings):
    """Runtime configuration, read from environment variables or apps/api/.env."""

    # hide_input_in_errors: a startup error must not print the settings it was given, which
    # include DATABASE_URL and REDIS_URL with their passwords, into the deploy logs.
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", hide_input_in_errors=True)

    env: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"

    database_url: str = "postgresql+asyncpg://collabedit:collabedit@localhost:5432/collabedit"
    redis_url: str = "redis://localhost:6379/0"

    # Origin of the web app, used for CORS and for checking Origin on cookie endpoints.
    frontend_url: str = "http://localhost:5173"

    # Seconds each readiness check may take before it counts as failed.
    readiness_timeout: float = 2.0

    # Auth
    jwt_secret: str = _DEV_JWT_SECRET
    access_token_ttl_seconds: int = 15 * 60
    refresh_token_ttl_days: int = 7
    # A rotated refresh token presented again within this window is treated as two tabs
    # refreshing at once, not as theft.
    refresh_reuse_grace_seconds: int = 10
    cookie_secure: bool = False

    rate_limit_enabled: bool = True

    # Live editing
    collab_ticket_ttl_seconds: int = 30
    # How long an empty room stays in memory, so a quick reconnect skips reloading from Postgres.
    collab_room_grace_seconds: float = 30.0
    # The saver writes buffered edits after this delay, or sooner once this many are waiting.
    collab_flush_interval_seconds: float = 0.5
    collab_flush_max_updates: int = 50
    collab_max_connections_per_user: int = 10
    # Per-connection message budget: a burst of 200, refilling at 60 per second.
    collab_message_burst: int = 200
    collab_messages_per_second: float = 60.0
    # Outgoing messages queued per connection before it is dropped as too slow.
    collab_send_queue_size: int = 512

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @field_validator("database_url")
    @classmethod
    def _use_asyncpg(cls, value: str) -> str:
        """Accepts the URL a host hands out (Neon: postgresql://…?sslmode=require&…) and adapts
        it for asyncpg, which needs its own driver name, spells TLS as `ssl`, and rejects libpq
        options such as `channel_binding`."""
        url = make_url(value)
        if url.drivername in ("postgres", "postgresql"):
            url = url.set(drivername="postgresql+asyncpg")
        query = dict(url.query)
        if "sslmode" in query:
            query["ssl"] = query.pop("sslmode")
        query.pop("channel_binding", None)
        return url.set(query=query).render_as_string(hide_password=False)

    @model_validator(mode="after")
    def _require_safe_production_settings(self) -> Self:
        if not self.is_production:
            return self
        if self.jwt_secret == _DEV_JWT_SECRET or len(self.jwt_secret) < 32:
            raise ValueError("JWT_SECRET must be set to a random value of at least 32 characters")
        if not self.cookie_secure:
            raise ValueError("COOKIE_SECURE must be true in production (cookies over HTTPS only)")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
