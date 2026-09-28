import pytest
from fastapi import FastAPI
from httpx import AsyncClient

from app.collab.room import CloseCode
from app.core.config import Settings
from tests.collab_client import open_document
from tests.test_collab import editor_pair


@pytest.fixture
def settings(settings: Settings) -> Settings:
    # Small budgets so the limits are reachable in a test.
    return settings.model_copy(
        update={
            "collab_message_burst": 20,
            "collab_messages_per_second": 0.01,  # effectively no refill during a test
            "collab_max_connections_per_user": 2,
        }
    )


async def test_flooding_messages_closes_the_connection(app: FastAPI, client: AsyncClient) -> None:
    alice, _, doc_id = await editor_pair(client, app)

    async with open_document(app, alice, doc_id) as peer:
        # The budget is 20 messages; the 21st is refused. Sending exactly one past the budget
        # means the client never writes to a socket the server has already closed.
        for i in range(21):
            await peer.insert(0, str(i % 10))
        assert await peer.closed_with() == CloseCode.RATE_LIMITED


async def test_connections_per_user_are_capped(app: FastAPI, client: AsyncClient) -> None:
    alice, _, doc_id = await editor_pair(client, app)

    async with open_document(app, alice, doc_id), open_document(app, alice, doc_id):
        async with open_document(app, alice, doc_id, sync=False) as third:
            assert await third.closed_with() == CloseCode.RATE_LIMITED

    async with open_document(app, alice, doc_id):  # slots are released on disconnect
        pass
