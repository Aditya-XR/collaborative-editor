from functools import lru_cache
from typing import Literal, Self

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Placeholder for local dev only; the validator below refuses it in production.
_DEV_JWT_SECRET = "dev-only-insecure-jwt-secret-change-me-in-production"  # noqa: S105


class Settings(BaseSettings):
    """Runtime configuration, read from environment variables or apps/api/.env."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

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

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @model_validator(mode="after")
    def _require_real_secret_in_production(self) -> Self:
        if self.is_production and (self.jwt_secret == _DEV_JWT_SECRET or len(self.jwt_secret) < 32):
            raise ValueError("JWT_SECRET must be set to a random value of at least 32 characters")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
