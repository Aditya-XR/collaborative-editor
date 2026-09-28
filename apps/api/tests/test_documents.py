import uuid
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient

from app.core.ids import uuid7
from app.documents.models import DocumentMember, DocumentRole
from tests.conftest import RegisteredUser, register


async def create_doc(
    client: AsyncClient, user: RegisteredUser, title: str = "Plan"
) -> dict[str, Any]:
    response = await client.post("/api/documents", json={"title": title}, headers=user.headers)
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


async def grant(app: FastAPI, doc_id: str, user: RegisteredUser, role: DocumentRole) -> None:
    async with app.state.sessionmaker() as session:
        session.add(
            DocumentMember(document_id=uuid.UUID(doc_id), user_id=uuid.UUID(user.id), role=role)
        )
        await session.commit()


async def two_users(client: AsyncClient) -> tuple[RegisteredUser, RegisteredUser]:
    alice = await register(client, email="alice@example.com", name="Alice")
    bob = await register(client, email="bob@example.com", name="Bob")
    return alice, bob


async def test_create_and_fetch_a_document(client: AsyncClient) -> None:
    alice = await register(client, name="Alice")

    created = await create_doc(client, alice, "  Launch plan  ")
    fetched = await client.get(f"/api/documents/{created['id']}", headers=alice.headers)

    assert created["title"] == "Launch plan"
    assert created["role"] == "owner"
    assert created["owner"] == {"id": alice.id, "name": "Alice"}
    assert created["deleted_at"] is None
    assert uuid.UUID(created["id"]).version == 7
    assert fetched.status_code == 200
    assert fetched.json() == created


async def test_create_without_body_uses_default_title(client: AsyncClient) -> None:
    alice = await register(client)

    response = await client.post("/api/documents", headers=alice.headers)

    assert response.status_code == 201
    assert response.json()["title"] == "Untitled document"


async def test_documents_require_authentication(client: AsyncClient) -> None:
    response = await client.get("/api/documents")

    assert response.status_code == 401
    assert response.json()["code"] == "not_authenticated"


async def test_title_is_validated(client: AsyncClient) -> None:
    alice = await register(client)

    for title in ["", "   ", "x" * 201]:
        response = await client.post("/api/documents", json={"title": title}, headers=alice.headers)
        assert response.status_code == 422, title


async def test_list_filters_by_ownership(app: FastAPI, client: AsyncClient) -> None:
    alice, bob = await two_users(client)
    first = await create_doc(client, alice, "First")
    second = await create_doc(client, alice, "Second")
    bobs = await create_doc(client, bob, "Bob's notes")
    await grant(app, bobs["id"], alice, DocumentRole.EDITOR)

    async def titles(query: str) -> list[str]:
        response = await client.get(f"/api/documents{query}", headers=alice.headers)
        assert response.status_code == 200
        return [doc["title"] for doc in response.json()]

    assert await titles("") == ["Bob's notes", "Second", "First"]  # newest first
    assert await titles("?scope=owned") == ["Second", "First"]
    assert await titles("?scope=shared") == ["Bob's notes"]

    shared = (await client.get("/api/documents?scope=shared", headers=alice.headers)).json()[0]
    assert shared["role"] == "editor"
    assert shared["owner"]["name"] == "Bob"
    assert first["id"] != second["id"]


async def test_outsiders_get_404_not_403(client: AsyncClient) -> None:
    alice, bob = await two_users(client)
    doc = await create_doc(client, alice)
    url = f"/api/documents/{doc['id']}"

    responses = [
        await client.get(url, headers=bob.headers),
        await client.patch(url, json={"title": "Mine now"}, headers=bob.headers),
        await client.delete(url, headers=bob.headers),
    ]

    for response in responses:
        assert response.status_code == 404
        assert response.json()["code"] == "document_not_found"
    assert (await client.get("/api/documents", headers=bob.headers)).json() == []


async def test_roles_gate_rename_and_delete(app: FastAPI, client: AsyncClient) -> None:
    alice, bob = await two_users(client)
    carol = await register(client, email="carol@example.com", name="Carol")
    doc = await create_doc(client, alice)
    await grant(app, doc["id"], bob, DocumentRole.VIEWER)
    await grant(app, doc["id"], carol, DocumentRole.EDITOR)
    url = f"/api/documents/{doc['id']}"

    viewer_rename = await client.patch(url, json={"title": "Viewer"}, headers=bob.headers)
    editor_rename = await client.patch(url, json={"title": "Edited"}, headers=carol.headers)
    editor_delete = await client.delete(url, headers=carol.headers)

    assert viewer_rename.status_code == 403
    assert viewer_rename.json()["code"] == "insufficient_role"
    assert editor_rename.status_code == 200
    assert editor_rename.json()["title"] == "Edited"
    assert editor_rename.json()["updated_at"] >= doc["updated_at"]
    assert editor_delete.status_code == 403


async def test_trash_and_restore(app: FastAPI, client: AsyncClient) -> None:
    alice, bob = await two_users(client)
    doc = await create_doc(client, alice)
    await grant(app, doc["id"], bob, DocumentRole.EDITOR)
    url = f"/api/documents/{doc['id']}"

    assert (await client.delete(url, headers=alice.headers)).status_code == 204
    assert (await client.get(url, headers=alice.headers)).status_code == 404
    assert (await client.get(url, headers=bob.headers)).status_code == 404
    assert (await client.get("/api/documents", headers=alice.headers)).json() == []
    trash = (await client.get("/api/documents?trashed=true", headers=alice.headers)).json()
    assert [d["id"] for d in trash] == [doc["id"]]
    assert trash[0]["deleted_at"] is not None
    # Collaborators never see someone else's Trash.
    assert (await client.get("/api/documents?trashed=true", headers=bob.headers)).json() == []

    restored = await client.post(f"{url}/restore", headers=alice.headers)

    assert restored.status_code == 200
    assert restored.json()["deleted_at"] is None
    assert (await client.get(url, headers=bob.headers)).status_code == 200


async def test_put_creates_with_client_id_and_is_idempotent(client: AsyncClient) -> None:
    alice = await register(client)
    doc_id = uuid7()
    url = f"/api/documents/{doc_id}"

    first = await client.put(url, json={"title": "Written offline"}, headers=alice.headers)
    replay = await client.put(url, json={"title": "Written offline"}, headers=alice.headers)

    assert first.status_code == 201
    assert replay.status_code == 200
    assert first.json() == replay.json()
    assert first.json()["id"] == str(doc_id)
    listed = (await client.get("/api/documents", headers=alice.headers)).json()
    assert [d["id"] for d in listed] == [str(doc_id)]


async def test_put_with_another_users_id_is_a_conflict(client: AsyncClient) -> None:
    alice, bob = await two_users(client)
    doc_id = uuid7()
    await client.put(f"/api/documents/{doc_id}", headers=alice.headers)

    response = await client.put(f"/api/documents/{doc_id}", headers=bob.headers)

    assert response.status_code == 409
    assert response.json()["code"] == "id_conflict"
    assert (await client.get(f"/api/documents/{doc_id}", headers=bob.headers)).status_code == 404


async def test_malformed_ids_are_rejected(client: AsyncClient) -> None:
    alice = await register(client)

    assert (await client.get("/api/documents/not-a-uuid", headers=alice.headers)).status_code == 422
    assert (await client.put("/api/documents/123", headers=alice.headers)).status_code == 422
