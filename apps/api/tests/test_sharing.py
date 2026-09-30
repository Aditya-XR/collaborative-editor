from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import text

from app.collab.room import CloseCode
from app.documents.models import DocumentRole
from tests.collab_client import open_document
from tests.conftest import RegisteredUser, register
from tests.test_documents import create_doc, grant


@pytest.fixture
async def team(client: AsyncClient) -> dict[str, RegisteredUser]:
    return {
        "owner": await register(client, email="owner@example.com", name="Olivia Owner"),
        "editor": await register(client, email="editor@example.com", name="Eddie Editor"),
        "viewer": await register(client, email="viewer@example.com", name="Vera Viewer"),
        "outsider": await register(client, email="out@example.com", name="Oscar Outsider"),
    }


async def shared_doc(app: FastAPI, client: AsyncClient, team: dict[str, RegisteredUser]) -> str:
    doc = await create_doc(client, team["owner"], "Team plan")
    await grant(app, doc["id"], team["editor"], DocumentRole.EDITOR)
    await grant(app, doc["id"], team["viewer"], DocumentRole.VIEWER)
    return str(doc["id"])


async def members(client: AsyncClient, doc_id: str, user: RegisteredUser) -> dict[str, str]:
    response = await client.get(f"/api/documents/{doc_id}/members", headers=user.headers)
    assert response.status_code == 200, response.text
    return {m["user"]["email"]: m["role"] for m in response.json()}


# ----- members ----------------------------------------------------------------------------------


async def test_members_are_listed_owner_first(
    app: FastAPI, client: AsyncClient, team: dict[str, RegisteredUser]
) -> None:
    doc_id = await shared_doc(app, client, team)

    response = await client.get(f"/api/documents/{doc_id}/members", headers=team["viewer"].headers)

    assert response.status_code == 200
    listed = [(m["user"]["name"], m["role"]) for m in response.json()]
    assert listed == [
        ("Olivia Owner", "owner"),
        ("Eddie Editor", "editor"),
        ("Vera Viewer", "viewer"),
    ]
    outsider = await client.get(
        f"/api/documents/{doc_id}/members", headers=team["outsider"].headers
    )
    assert outsider.status_code == 404


async def test_owners_and_editors_can_invite_by_email(
    app: FastAPI, client: AsyncClient, team: dict[str, RegisteredUser]
) -> None:
    doc_id = await shared_doc(app, client, team)
    newcomer = await register(client, email="new@example.com", name="Nia Newcomer")

    response = await client.post(
        f"/api/documents/{doc_id}/members",
        json={"email": "NEW@example.com", "role": "commenter"},
        headers=team["editor"].headers,
    )

    assert response.status_code == 201
    assert response.json()["user"]["id"] == newcomer.id
    assert response.json()["role"] == "commenter"
    shared = await client.get("/api/documents?scope=shared", headers=newcomer.headers)
    assert [d["title"] for d in shared.json()] == ["Team plan"]


@pytest.mark.parametrize(
    ("payload", "status", "code"),
    [
        ({"email": "nobody@example.com", "role": "editor"}, 404, "user_not_found"),
        ({"email": "viewer@example.com", "role": "editor"}, 409, "already_member"),
        ({"email": "out@example.com", "role": "owner"}, 422, "validation_error"),
    ],
)
async def test_invalid_invites_are_explained(
    app: FastAPI,
    client: AsyncClient,
    team: dict[str, RegisteredUser],
    payload: dict[str, str],
    status: int,
    code: str,
) -> None:
    doc_id = await shared_doc(app, client, team)

    response = await client.post(
        f"/api/documents/{doc_id}/members", json=payload, headers=team["owner"].headers
    )

    assert response.status_code == status
    assert response.json()["code"] == code


async def test_viewers_cannot_invite(
    app: FastAPI, client: AsyncClient, team: dict[str, RegisteredUser]
) -> None:
    doc_id = await shared_doc(app, client, team)

    response = await client.post(
        f"/api/documents/{doc_id}/members",
        json={"email": "out@example.com", "role": "viewer"},
        headers=team["viewer"].headers,
    )

    assert response.status_code == 403


async def test_only_the_owner_changes_roles(
    app: FastAPI, client: AsyncClient, team: dict[str, RegisteredUser]
) -> None:
    doc_id = await shared_doc(app, client, team)
    viewer_id = team["viewer"].id

    by_editor = await client.patch(
        f"/api/documents/{doc_id}/members/{viewer_id}",
        json={"role": "editor"},
        headers=team["editor"].headers,
    )
    by_owner = await client.patch(
        f"/api/documents/{doc_id}/members/{viewer_id}",
        json={"role": "editor"},
        headers=team["owner"].headers,
    )
    on_owner = await client.patch(
        f"/api/documents/{doc_id}/members/{team['owner'].id}",
        json={"role": "viewer"},
        headers=team["owner"].headers,
    )

    assert by_editor.status_code == 403
    assert by_owner.status_code == 204
    assert (await members(client, doc_id, team["owner"]))["viewer@example.com"] == "editor"
    assert on_owner.status_code == 400
    assert on_owner.json()["code"] == "owner_role_fixed"


async def test_removing_people_and_leaving(
    app: FastAPI, client: AsyncClient, team: dict[str, RegisteredUser]
) -> None:
    doc_id = await shared_doc(app, client, team)
    url = f"/api/documents/{doc_id}/members"

    editor_removes_viewer = await client.delete(
        f"{url}/{team['viewer'].id}", headers=team["editor"].headers
    )
    viewer_leaves = await client.delete(
        f"{url}/{team['viewer'].id}", headers=team["viewer"].headers
    )
    owner_removes_editor = await client.delete(
        f"{url}/{team['editor'].id}", headers=team["owner"].headers
    )
    owner_leaves = await client.delete(f"{url}/{team['owner'].id}", headers=team["owner"].headers)

    assert editor_removes_viewer.status_code == 403
    assert viewer_leaves.status_code == 204
    assert owner_removes_editor.status_code == 204
    assert owner_leaves.status_code == 400
    assert owner_leaves.json()["code"] == "owner_cannot_leave"
    assert await members(client, doc_id, team["owner"]) == {"owner@example.com": "owner"}
    gone = await client.get(f"/api/documents/{doc_id}", headers=team["editor"].headers)
    assert gone.status_code == 404


async def test_ownership_transfer(
    app: FastAPI, client: AsyncClient, team: dict[str, RegisteredUser]
) -> None:
    doc_id = await shared_doc(app, client, team)
    url = f"/api/documents/{doc_id}/transfer-ownership"

    to_outsider = await client.post(
        url, json={"user_id": team["outsider"].id}, headers=team["owner"].headers
    )
    by_editor = await client.post(
        url, json={"user_id": team["editor"].id}, headers=team["editor"].headers
    )
    transfer = await client.post(
        url, json={"user_id": team["editor"].id}, headers=team["owner"].headers
    )

    assert to_outsider.status_code == 404
    assert by_editor.status_code == 403
    assert transfer.status_code == 204
    roles = await members(client, doc_id, team["editor"])
    assert roles["editor@example.com"] == "owner"
    assert roles["owner@example.com"] == "editor"
    doc = (await client.get(f"/api/documents/{doc_id}", headers=team["editor"].headers)).json()
    assert doc["owner"]["id"] == team["editor"].id
    # The new owner can now do owner-only things; the old one cannot.
    old_owner_delete = await client.delete(
        f"/api/documents/{doc_id}", headers=team["owner"].headers
    )
    assert old_owner_delete.status_code == 403


# ----- links ------------------------------------------------------------------------------------


async def make_link(
    client: AsyncClient, doc_id: str, user: RegisteredUser, **body: Any
) -> dict[str, Any]:
    response = await client.post(
        f"/api/documents/{doc_id}/links", json={"role": "viewer", **body}, headers=user.headers
    )
    assert response.status_code == 201, response.text
    link: dict[str, Any] = response.json()
    return link


async def accept(client: AsyncClient, user: RegisteredUser, token: str) -> Any:
    return await client.post("/api/links/accept", json={"token": token}, headers=user.headers)


async def test_share_link_grants_its_role(
    app: FastAPI, client: AsyncClient, team: dict[str, RegisteredUser]
) -> None:
    doc_id = await shared_doc(app, client, team)
    link = await make_link(client, doc_id, team["editor"], role="commenter")

    response = await accept(client, team["outsider"], link["token"])

    assert response.status_code == 200
    assert response.json() == {"document_id": doc_id, "role": "commenter"}
    assert (await members(client, doc_id, team["owner"]))["out@example.com"] == "commenter"
    assert link["expires_at"] is not None  # seven days by default


async def test_links_only_ever_raise_access(
    app: FastAPI, client: AsyncClient, team: dict[str, RegisteredUser]
) -> None:
    doc_id = await shared_doc(app, client, team)
    view_link = await make_link(client, doc_id, team["owner"], role="viewer")
    edit_link = await make_link(client, doc_id, team["owner"], role="editor")

    editor_opens_view_link = await accept(client, team["editor"], view_link["token"])
    owner_opens_view_link = await accept(client, team["owner"], view_link["token"])
    viewer_opens_edit_link = await accept(client, team["viewer"], edit_link["token"])

    assert editor_opens_view_link.json()["role"] == "editor"
    assert owner_opens_view_link.json()["role"] == "owner"
    assert viewer_opens_edit_link.json()["role"] == "editor"


async def test_link_tokens_are_shown_once_and_stored_hashed(
    app: FastAPI, client: AsyncClient, team: dict[str, RegisteredUser]
) -> None:
    doc_id = await shared_doc(app, client, team)
    link = await make_link(client, doc_id, team["owner"], expires_in_days=None)

    listed = await client.get(f"/api/documents/{doc_id}/links", headers=team["owner"].headers)

    assert listed.status_code == 200
    assert listed.json() == [{k: link[k] for k in ("id", "role", "created_at", "expires_at")}]
    assert "token" not in listed.json()[0]
    async with app.state.db_engine.connect() as conn:
        stored = (await conn.execute(text("SELECT token_hash FROM share_links"))).scalar_one()
    assert stored != link["token"] and len(stored) == 64


async def test_revoked_and_expired_links_stop_working(
    app: FastAPI, client: AsyncClient, team: dict[str, RegisteredUser]
) -> None:
    doc_id = await shared_doc(app, client, team)
    revoked = await make_link(client, doc_id, team["owner"])
    expired = await make_link(client, doc_id, team["owner"])
    await client.delete(
        f"/api/documents/{doc_id}/links/{revoked['id']}", headers=team["owner"].headers
    )
    async with app.state.db_engine.begin() as conn:
        await conn.execute(
            text("UPDATE share_links SET expires_at = :past WHERE id = :id"),
            {"past": datetime.now(UTC) - timedelta(seconds=1), "id": expired["id"]},
        )

    for token in (revoked["token"], expired["token"]):
        response = await accept(client, team["outsider"], token)
        assert response.status_code == 410
        assert response.json()["code"] == "link_expired"
    listed = await client.get(f"/api/documents/{doc_id}/links", headers=team["owner"].headers)
    assert listed.json() == []
    unknown = await accept(client, team["outsider"], "x" * 32)
    assert unknown.status_code == 404


async def test_links_to_trashed_documents_do_not_work(
    app: FastAPI, client: AsyncClient, team: dict[str, RegisteredUser]
) -> None:
    doc_id = await shared_doc(app, client, team)
    link = await make_link(client, doc_id, team["owner"])
    await client.delete(f"/api/documents/{doc_id}", headers=team["owner"].headers)

    response = await accept(client, team["outsider"], link["token"])

    assert response.status_code == 404


async def test_viewers_cannot_manage_links(
    app: FastAPI, client: AsyncClient, team: dict[str, RegisteredUser]
) -> None:
    doc_id = await shared_doc(app, client, team)

    create = await client.post(
        f"/api/documents/{doc_id}/links", json={"role": "viewer"}, headers=team["viewer"].headers
    )
    listing = await client.get(f"/api/documents/{doc_id}/links", headers=team["viewer"].headers)

    assert create.status_code == 403
    assert listing.status_code == 403


# ----- live effects -----------------------------------------------------------------------------


async def test_removed_member_is_disconnected_immediately(
    app: FastAPI, client: AsyncClient, team: dict[str, RegisteredUser]
) -> None:
    doc_id = await shared_doc(app, client, team)

    async with open_document(app, team["editor"], doc_id) as editor:
        response = await client.delete(
            f"/api/documents/{doc_id}/members/{team['editor'].id}", headers=team["owner"].headers
        )
        assert response.status_code == 204
        assert await editor.closed_with() == CloseCode.FORBIDDEN


async def test_role_change_reconnects_with_the_new_role(
    app: FastAPI, client: AsyncClient, team: dict[str, RegisteredUser]
) -> None:
    doc_id = await shared_doc(app, client, team)

    async with open_document(app, team["owner"], doc_id) as owner:
        await owner.insert(0, "Original")
        async with open_document(app, team["editor"], doc_id) as editor:
            await client.patch(
                f"/api/documents/{doc_id}/members/{team['editor'].id}",
                json={"role": "viewer"},
                headers=team["owner"].headers,
            )
            assert await editor.closed_with() == CloseCode.ROLE_CHANGED

        # The client reconnects with a fresh ticket, which now carries the viewer role.
        async with open_document(app, team["editor"], doc_id) as demoted:
            await demoted.insert(0, "Sneaky ")
            await owner.insert(8, "!")
            await demoted.until(lambda: str(demoted.text).endswith("!"))
            assert str(owner.text) == "Original!"
