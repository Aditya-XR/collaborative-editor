import asyncio

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from sqlalchemy import Connection

from app.core.db import Base, create_engine
from tests.conftest import alembic_config


async def test_models_and_migrations_agree(database_url: str) -> None:
    """Fails when a model changes without a matching migration."""

    def diff(connection: Connection) -> list[object]:
        return list(compare_metadata(MigrationContext.configure(connection), Base.metadata))

    engine = create_engine(database_url)
    try:
        async with engine.connect() as conn:
            differences = await conn.run_sync(diff)
    finally:
        await engine.dispose()

    assert differences == []


async def test_migrations_downgrade_and_upgrade_cleanly(database_url: str) -> None:
    config = alembic_config(database_url)

    # Alembic's env.py runs its own event loop, so drive it from a worker thread.
    await asyncio.to_thread(command.downgrade, config, "base")
    await asyncio.to_thread(command.upgrade, config, "head")
