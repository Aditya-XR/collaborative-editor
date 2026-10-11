import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import text
from sqlalchemy.engine import Connection

import app.models  # noqa: F401  (registers every table on Base.metadata)
from app.core.config import get_settings
from app.core.db import Base, create_engine

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _database_url() -> str:
    # Tests point Alembic at their own database through sqlalchemy.url.
    return config.get_main_option("sqlalchemy.url") or get_settings().database_url


def run_migrations_offline() -> None:
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


# Every API container runs migrations as it starts. Several starting at once (a deploy of more
# than one instance) queue on this lock, so each sees the schema the previous one left; without
# it two would create the same tables at the same time.
MIGRATION_LOCK = 0x636F6C6C6162  # "collab"


def _run_sync(connection: Connection) -> None:
    # A session-level lock, committed at once: Alembic must start its own transaction, or it
    # would treat this one as the caller's and never commit the migrations.
    connection.execute(text("SELECT pg_advisory_lock(:key)"), {"key": MIGRATION_LOCK})
    connection.commit()
    try:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()
    finally:
        connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": MIGRATION_LOCK})
        connection.commit()


async def run_migrations_online() -> None:
    engine = create_engine(_database_url())
    async with engine.connect() as connection:
        await connection.run_sync(_run_sync)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
