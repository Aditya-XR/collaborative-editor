import asyncio
import os
import sys

import asyncpg
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.engine import make_url

from app.core.db import Base, create_engine
from tests.conftest import API_ROOT, alembic_config

MIGRATION_LOCK = 0x636F6C6C6162  # as in alembic/env.py


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


async def test_instances_starting_together_migrate_one_at_a_time(database_url: str) -> None:
    """Each container migrates as it starts; two starting at once must not both create the same
    tables. Separate processes, as in production: Alembic's context is global to a process."""
    await asyncio.to_thread(command.downgrade, alembic_config(database_url), "base")
    env = {**os.environ, "DATABASE_URL": database_url}

    async def migrate() -> int:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "alembic", "upgrade", "head", cwd=API_ROOT, env=env
        )
        return await process.wait()

    assert list(await asyncio.gather(migrate(), migrate())) == [0, 0]
    engine = create_engine(database_url)
    try:
        async with engine.connect() as conn:
            current = await conn.scalar(text("SELECT version_num FROM alembic_version"))
    finally:
        await engine.dispose()
    head = ScriptDirectory.from_config(alembic_config(database_url)).get_current_head()
    assert current == head


async def test_a_lock_left_behind_never_hangs_startup(database_url: str) -> None:
    """A killed process's session can linger on the database server, holding the migration
    lock. A restart with nothing to migrate goes ahead; one with migrations to run gives up
    after a bounded wait instead of hanging."""
    url = make_url(database_url)
    holder = await asyncpg.connect(
        user=url.username,
        password=url.password,
        host=url.host,
        port=url.port,
        database=url.database,
    )
    try:
        await holder.execute("SELECT pg_advisory_lock($1)", MIGRATION_LOCK)
        env = {**os.environ, "DATABASE_URL": database_url, "MIGRATION_LOCK_TIMEOUT": "1s"}

        async def alembic(*args: str) -> int:
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "alembic", *args, cwd=API_ROOT, env=env
            )
            return await asyncio.wait_for(process.wait(), timeout=30)

        assert await alembic("upgrade", "head") == 0  # at head already: does not wait
        await holder.execute("SELECT pg_advisory_unlock($1)", MIGRATION_LOCK)
        await asyncio.to_thread(command.downgrade, alembic_config(database_url), "-1")
        await holder.execute("SELECT pg_advisory_lock($1)", MIGRATION_LOCK)
        assert await alembic("upgrade", "head") != 0  # has work, lock held: gives up
    finally:
        await holder.close()
    await asyncio.to_thread(command.upgrade, alembic_config(database_url), "head")


async def test_search_text_is_backfilled_for_documents_edited_before_search(
    database_url: str,
) -> None:
    from typing import Any

    from pycrdt import Doc, XmlElement, XmlFragment, XmlText
    from sqlalchemy import text

    config = alembic_config(database_url)
    await asyncio.to_thread(command.downgrade, config, "bb86555f0bb3")  # search exists, empty
    old: Doc[Any] = Doc()
    paragraph = old.get("default", type=XmlFragment).children.append(XmlElement("paragraph"))
    paragraph.children.append(XmlText("Written before search existed"))
    engine = create_engine(database_url)
    try:
        async with engine.begin() as conn:
            await conn.execute(text("TRUNCATE users, documents CASCADE"))
            await conn.execute(
                text(
                    "INSERT INTO users (id, email, name, password_hash) VALUES"
                    " ('01900000-0000-7000-8000-000000000001', 'old@example.com', 'Old', 'x')"
                )
            )
            await conn.execute(
                text(
                    "INSERT INTO documents (id, owner_id, title) VALUES"
                    " ('01900000-0000-7000-8000-000000000002',"
                    "  '01900000-0000-7000-8000-000000000001', 'Old doc'),"
                    " ('01900000-0000-7000-8000-000000000003',"
                    "  '01900000-0000-7000-8000-000000000001', 'Never opened')"
                )
            )
            await conn.execute(
                text(
                    "INSERT INTO document_updates (document_id, update)"
                    " VALUES ('01900000-0000-7000-8000-000000000002', :update)"
                ),
                {"update": old.get_update()},
            )

        await asyncio.to_thread(command.upgrade, config, "head")

        async with engine.connect() as conn:
            rows: dict[str, str] = dict(
                (await conn.execute(text("SELECT title, search_text FROM documents"))).all()
            )
            await conn.execute(text("TRUNCATE users, documents CASCADE"))
            await conn.commit()
    finally:
        await engine.dispose()

    assert rows == {"Old doc": "Written before search existed", "Never opened": ""}


async def test_deployment_test_accounts_are_removed_and_nothing_else(database_url: str) -> None:
    from sqlalchemy import text

    config = alembic_config(database_url)
    await asyncio.to_thread(command.downgrade, config, "b48a71d073f4")
    engine = create_engine(database_url)
    try:
        async with engine.begin() as conn:
            await conn.execute(text("TRUNCATE users, documents CASCADE"))
            await conn.execute(
                text(
                    "INSERT INTO users (id, email, name, password_hash) VALUES"
                    " ('01900000-0000-7000-8000-00000000000a', 'smoke-bob-605e929c@example.com',"
                    "  'Smoke Bob', 'x'),"
                    " ('01900000-0000-7000-8000-00000000000b', 'real@example.com', 'Real', 'x')"
                )
            )
            await conn.execute(
                text(
                    "INSERT INTO documents (id, owner_id, title) VALUES"
                    " ('01900000-0000-7000-8000-00000000000c',"
                    "  '01900000-0000-7000-8000-00000000000a', 'Smoke test'),"
                    " ('01900000-0000-7000-8000-00000000000d',"
                    "  '01900000-0000-7000-8000-00000000000b', 'Real work')"
                )
            )

        await asyncio.to_thread(command.upgrade, config, "head")

        async with engine.connect() as conn:
            emails: list[str] = list(
                (await conn.execute(text("SELECT email FROM users"))).scalars()
            )
            titles: list[str] = list(
                (await conn.execute(text("SELECT title FROM documents"))).scalars()
            )
            await conn.execute(text("TRUNCATE users, documents CASCADE"))
            await conn.commit()
    finally:
        await engine.dispose()

    assert emails == ["real@example.com"]
    assert titles == ["Real work"]  # the test account's document went with it
