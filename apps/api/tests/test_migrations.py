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
