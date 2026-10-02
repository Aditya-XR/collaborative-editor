from functools import lru_cache
from typing import Literal, Self

from pydantic import AliasChoices, Field, field_validator, model_validator
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
    # The commit this process runs, reported by /api/healthz so a deploy can be confirmed.
    # Render sets RENDER_GIT_COMMIT on every deploy; RELEASE works anywhere else.
    release: str = Field(default="", validation_alias=AliasChoices("release", "render_git_commit"))

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
    # A connection that sends nothing for this long is closed. Clients send a heartbeat every
    # 15 seconds, but a hidden browser tab may run its timers only once a minute.
    collab_idle_timeout_seconds: float = 150.0
    # The edit log is folded into the document's snapshot once it holds this many rows.
    collab_compaction_threshold: int = 500

    # Version history: an automatic version at most this often while people edit, and one when
    # an editing session ends. The newest automatic versions are kept; named ones until unnamed.
    versions_auto_interval_seconds: float = 600.0
    versions_auto_kept: int = 50
    versions_named_max: int = 100

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @field_validator("database_url")
    @classmethod
    def _use_asyncpg(cls, value: str) -> str:
        """Accepts the URL a host hands out (Neon: postgresql://…?sslmode=require&…) and adapts
        it for asyncpg, which needs its own driver name, spells TLS as `ssl`, and rejects libpq
        options such as `channel_binding`."""
        url = make_url(value.strip())
        if url.drivername in ("postgres", "postgresql"):
            url = url.set(drivername="postgresql+asyncpg")
        query = dict(url.query)
        if "sslmode" in query:
            query["ssl"] = query.pop("sslmode")
        query.pop("channel_binding", None)
        return url.set(query=query).render_as_string(hide_password=False)

    @field_validator("redis_url")
    @classmethod
    def _require_redis_scheme(cls, value: str) -> str:
        """Fails at startup, before migrations run, with a message that says what to fix.

        Hosted dashboards often hand out a whole CLI command (`redis-cli -u redis://…`), and
        pasting all of it otherwise surfaces as an error deep inside the Redis client.
        """
        value = value.strip()
        if not value.startswith(("redis://", "rediss://", "unix://")):
            raise ValueError(
                "REDIS_URL must start with redis:// or rediss:// - paste only the URL, "
                "not a redis-cli command, without quotes"
            )
        return value

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
