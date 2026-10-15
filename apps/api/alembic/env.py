import asyncio
import logging
import os
from logging.config import fileConfig

from alembic import context
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
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
# A lock is never waited on forever: a killed process's session can linger on the database
# server and keep holding it, and startup must fail loudly rather than hang.
LOCK_WAIT = os.environ.get("MIGRATION_LOCK_TIMEOUT", "60s")

log = logging.getLogger("alembic.env")


def _already_at_target(connection: Connection) -> bool:
    """True for `upgrade head` on a database already there: every ordinary restart."""
    target = context.get_revision_argument()
    heads = set(ScriptDirectory.from_config(config).get_heads())
    current = set(MigrationContext.configure(connection).get_current_heads())
    connection.rollback()  # end the read's transaction; Alembic must begin its own
    targets = set(target) if isinstance(target, tuple) else {target}
    return targets == heads and current == heads


def _run_sync(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
    # Session-level lock calls, each committed at once: Alembic must start its own transaction,
    # or it would treat an open one as the caller's and never commit the migrations.
    locked = connection.scalar(text("SELECT pg_try_advisory_lock(:key)"), {"key": MIGRATION_LOCK})
    connection.commit()
    if not locked:
        if _already_at_target(connection):
            # Nothing to migrate, so no reason to wait for whoever holds the lock.
            log.info("Schema is current; not waiting for the migration lock")
            return
        log.info("Waiting up to %s for another instance's migrations", LOCK_WAIT)
        connection.execute(
            text("SELECT set_config('lock_timeout', :wait, false)"), {"wait": LOCK_WAIT}
        )
        connection.execute(text("SELECT pg_advisory_lock(:key)"), {"key": MIGRATION_LOCK})
        connection.execute(text("RESET lock_timeout"))
        connection.commit()
    try:
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
