from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth.router import me_router
from app.auth.router import router as auth_router
from app.collab.manager import RoomManager
from app.collab.router import router as collab_router
from app.collab.store import UpdateStore
from app.core.config import Settings, get_settings
from app.core.db import create_engine, create_sessionmaker, ping_database
from app.core.errors import register_error_handlers
from app.core.logging import RequestContextMiddleware, configure_logging
from app.core.ratelimit.limiter import RateLimiter
from app.core.redis import create_redis, ping_redis
from app.documents.router import router as documents_router
from app.health.router import router as health_router

log = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    engine = create_engine(settings.database_url)
    redis = create_redis(settings.redis_url)

    app.state.db_engine = engine
    app.state.sessionmaker = create_sessionmaker(engine)
    app.state.rooms = RoomManager(UpdateStore(app.state.sessionmaker), settings)
    app.state.redis = redis
    app.state.rate_limiter = RateLimiter(redis, enabled=settings.rate_limit_enabled)
    app.state.readiness_checks = {
        "database": lambda: ping_database(engine),
        "redis": lambda: ping_redis(redis),
    }
    log.info("startup", env=settings.env)
    try:
        yield
    finally:
        # Save open documents before the database connection goes away.
        await app.state.rooms.shutdown()
        await redis.aclose()
        await engine.dispose()
        log.info("shutdown")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, json_logs=settings.is_production)

    app = FastAPI(
        title="CollabEdit API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    app.state.settings = settings

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.frontend_url],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID"],
    )
    # Added last so it wraps everything, including CORS preflight responses.
    app.add_middleware(RequestContextMiddleware)

    register_error_handlers(app)
    app.include_router(health_router, prefix="/api")
    app.include_router(auth_router, prefix="/api")
    app.include_router(me_router, prefix="/api")
    app.include_router(documents_router, prefix="/api")
    app.include_router(collab_router, prefix="/api")
    return app


app = create_app()
