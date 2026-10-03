"""Comment threads: permissions, replies, resolving, live signals and email notifications."""

import base64
import uuid
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete

from app.auth.models import User
from app.comments import service
from app.core.config import Settings
from app.core.mail import Email
from app.documents.models import DocumentMember, DocumentRole
from app.main import create_app
from tests.collab_client import open_document
from tests.conftest import RegisteredUser, register, reset_state
from tests.test_documents import create_doc, grant

START = base64.b64encode(b"\x01\xa4\x8f\x03\x07").decode()
END = base64.b64encode(b"\x01\xa4\x8f\x03\x0c").decode()


class Outbox:
    def __init__(self) -> None:
        self.sent: list[Email] = []

    async def send(self, email: Email) -> None:
        self.sent.append(email)

    def to(self, address: str) -> list[Email]:
        return [email for email in self.sent if email.to == address]


@pytest.fixture
def outbox(app: FastAPI) -> Outbox:
    box = Outbox()
    app.state.mailer = box
    return box


def threads_url(doc_id: str, suffix: str = "") -> str:
    return f"/api/documents/{doc_id}/threads{suffix}"


def comment_url(doc_id: str, comment_id: str) -> str:
    return f"/api/documents/{doc_id}/comments/{comment_id}"


async def open_thread(
    client: AsyncClient,
    user: RegisteredUser,
    doc_id: str,
    body: str = "Is this number right?",
    **extra: Any,
) -> dict[str, Any]:
    payload = {
        "anchor_start": START,
        "anchor_end": END,
        "quoted_text": "  budget of 10k  ",
        "body": body,
        **extra,
    }
    response = await client.post(threads_url(doc_id), json=payload, headers=user.headers)
    assert response.status_code == 201, response.text
    thread: dict[str, Any] = response.json()
    return thread


async def answer(
    client: AsyncClient, user: RegisteredUser, doc_id: str, thread_id: str, body: str
) -> dict[str, Any]:
    response = await client.post(
        threads_url(doc_id, f"/{thread_id}/comments"), json={"body": body}, headers=user.headers
    )
    assert response.status_code == 201, response.text
    thread: dict[str, Any] = response.json()
    return thread


async def listed(
    client: AsyncClient, user: RegisteredUser, doc_id: str, branch_id: str | None = None
) -> list[dict[str, Any]]:
    params = {"branch_id": branch_id} if branch_id else {}
    response = await client.get(threads_url(doc_id), params=params, headers=user.headers)
    assert response.status_code == 200, response.text
    threads: list[dict[str, Any]] = response.json()
    return threads


async def team(
    app: FastAPI, client: AsyncClient
) -> tuple[RegisteredUser, RegisteredUser, RegisteredUser, str]:
    """An owner, a commenter and a viewer on one document."""
    owner = await register(client, email="owner@example.com", name="Owner")
    commenter = await register(client, email="c@example.com", name="Commenter")
    viewer = await register(client, email="v@example.com", name="Viewer")
    doc_id = (await create_doc(client, owner, "Q4 plan"))["id"]
    await grant(app, doc_id, commenter, DocumentRole.COMMENTER)
    await grant(app, doc_id, viewer, DocumentRole.VIEWER)
    return owner, commenter, viewer, doc_id


# ----- threads and replies ----------------------------------------------------------------------


async def test_a_thread_opens_on_a_passage_and_collects_replies(
    app: FastAPI, client: AsyncClient
) -> None:
    owner, commenter, _, doc_id = await team(app, client)
    opened = await open_thread(client, commenter, doc_id)

    assert opened["anchor_start"] == START
    assert opened["anchor_end"] == END
    assert opened["quoted_text"] == "budget of 10k"
    assert opened["branch_id"] is None
    assert opened["resolved_at"] is None
    assert [c["body"] for c in opened["comments"]] == ["Is this number right?"]

    await answer(client, owner, doc_id, opened["id"], "  Yes, checked with finance.  ")
    [as_commenter] = await listed(client, commenter, doc_id)
    [as_owner] = await listed(client, owner, doc_id)

    assert [(c["author"]["name"], c["body"]) for c in as_commenter["comments"]] == [
        ("Commenter", "Is this number right?"),
        ("Owner", "Yes, checked with finance."),
    ]
    # What each person may do differs: authors edit their own, owners delete anything.
    assert [(c["can_edit"], c["can_delete"]) for c in as_commenter["comments"]] == [
        (True, True),
        (False, False),
    ]
    assert [(c["can_edit"], c["can_delete"]) for c in as_owner["comments"]] == [
        (False, True),
        (True, True),
    ]
    assert as_commenter["can_reply"] and as_owner["can_reply"]


async def test_who_may_read_and_write_comments(app: FastAPI, client: AsyncClient) -> None:
    owner, commenter, viewer, doc_id = await team(app, client)
    outsider = await register(client, email="o@example.com", name="Outsider")
    thread = await open_thread(client, owner, doc_id)

    [seen] = await listed(client, viewer, doc_id)
    assert seen["can_reply"] is False
    assert all(not c["can_edit"] and not c["can_delete"] for c in seen["comments"])

    reply = {"body": "Me too"}
    attempts = {
        "viewer opens": await client.post(
            threads_url(doc_id),
            json={"anchor_start": START, "anchor_end": END, "quoted_text": "", "body": "Hi"},
            headers=viewer.headers,
        ),
        "viewer replies": await client.post(
            threads_url(doc_id, f"/{thread['id']}/comments"), json=reply, headers=viewer.headers
        ),
        "viewer resolves": await client.patch(
            threads_url(doc_id, f"/{thread['id']}"), json={"resolved": True}, headers=viewer.headers
        ),
        "outsider lists": await client.get(threads_url(doc_id), headers=outsider.headers),
        "outsider replies": await client.post(
            threads_url(doc_id, f"/{thread['id']}/comments"), json=reply, headers=outsider.headers
        ),
        "commenter replies": await client.post(
            threads_url(doc_id, f"/{thread['id']}/comments"), json=reply, headers=commenter.headers
        ),
    }
    assert {name: r.status_code for name, r in attempts.items()} == {
        "viewer opens": 403,
        "viewer replies": 403,
        "viewer resolves": 403,
        "outsider lists": 404,
        "outsider replies": 404,
        "commenter replies": 201,
    }


async def test_a_thread_of_another_document_is_not_found(app: FastAPI, client: AsyncClient) -> None:
    owner, _, _, doc_id = await team(app, client)
    other_doc = (await create_doc(client, owner, "Other"))["id"]
    thread = await open_thread(client, owner, doc_id)
    comment_id = thread["comments"][0]["id"]

    responses = [
        await client.post(
            threads_url(other_doc, f"/{thread['id']}/comments"),
            json={"body": "x"},
            headers=owner.headers,
        ),
        await client.patch(
            threads_url(other_doc, f"/{thread['id']}"),
            json={"resolved": True},
            headers=owner.headers,
        ),
        await client.patch(
            comment_url(other_doc, comment_id), json={"body": "x"}, headers=owner.headers
        ),
        await client.delete(comment_url(other_doc, comment_id), headers=owner.headers),
    ]
    assert [r.json()["code"] for r in responses] == [
        "thread_not_found",
        "thread_not_found",
        "comment_not_found",
        "comment_not_found",
    ]


async def test_only_authors_edit_and_editors_may_delete_anything(
    app: FastAPI, client: AsyncClient
) -> None:
    owner, commenter, _, doc_id = await team(app, client)
    editor = await register(client, email="e@example.com", name="Editor")
    await grant(app, doc_id, editor, DocumentRole.EDITOR)
    thread = await open_thread(client, owner, doc_id)
    thread = await answer(client, commenter, doc_id, thread["id"], "First reply")
    thread = await answer(client, commenter, doc_id, thread["id"], "Second reply")
    first, mine, other = (c["id"] for c in thread["comments"])

    edited = await client.patch(
        comment_url(doc_id, mine), json={"body": "First reply, fixed"}, headers=commenter.headers
    )
    assert edited.status_code == 200
    assert edited.json()["comments"][1]["body"] == "First reply, fixed"
    assert edited.json()["comments"][1]["edited_at"] is not None

    not_theirs = await client.patch(
        comment_url(doc_id, first), json={"body": "Hijacked"}, headers=commenter.headers
    )
    owner_edits_reply = await client.patch(
        comment_url(doc_id, mine), json={"body": "Hijacked"}, headers=owner.headers
    )
    commenter_deletes_owner = await client.delete(
        comment_url(doc_id, first), headers=commenter.headers
    )
    assert [r.status_code for r in (not_theirs, owner_edits_reply, commenter_deletes_owner)] == [
        403,
        403,
        403,
    ]

    assert (
        await client.delete(comment_url(doc_id, mine), headers=commenter.headers)
    ).status_code == 204
    assert (
        await client.delete(comment_url(doc_id, other), headers=editor.headers)
    ).status_code == 204
    [left] = await listed(client, owner, doc_id)
    assert [c["id"] for c in left["comments"]] == [first]


async def test_deleting_the_first_comment_deletes_the_thread(
    app: FastAPI, client: AsyncClient
) -> None:
    owner, commenter, _, doc_id = await team(app, client)
    thread = await open_thread(client, commenter, doc_id)
    await answer(client, owner, doc_id, thread["id"], "A reply")

    response = await client.delete(
        comment_url(doc_id, thread["comments"][0]["id"]), headers=commenter.headers
    )

    assert response.status_code == 204
    assert await listed(client, owner, doc_id) == []


async def test_resolving_reopening_and_replying_to_a_resolved_thread(
    app: FastAPI, client: AsyncClient
) -> None:
    owner, commenter, _, doc_id = await team(app, client)
    thread = await open_thread(client, owner, doc_id)
    resolve_url = threads_url(doc_id, f"/{thread['id']}")

    resolved = (
        await client.patch(resolve_url, json={"resolved": True}, headers=commenter.headers)
    ).json()
    assert resolved["resolved_at"] is not None
    assert resolved["resolved_by"]["name"] == "Commenter"

    # Resolving again keeps who resolved it first.
    again = (await client.patch(resolve_url, json={"resolved": True}, headers=owner.headers)).json()
    assert again["resolved_by"]["name"] == "Commenter"

    reopened = (
        await client.patch(resolve_url, json={"resolved": False}, headers=owner.headers)
    ).json()
    assert (reopened["resolved_at"], reopened["resolved_by"]) == (None, None)

    await client.patch(resolve_url, json={"resolved": True}, headers=owner.headers)
    replied = await answer(client, commenter, doc_id, thread["id"], "Actually, one more thing")
    assert replied["resolved_at"] is None  # a reply reopens the discussion


async def test_comments_outlive_their_authors_account(app: FastAPI, client: AsyncClient) -> None:
    owner, commenter, _, doc_id = await team(app, client)
    thread = await open_thread(client, commenter, doc_id)
    await answer(client, owner, doc_id, thread["id"], "Noted")

    async with app.state.sessionmaker() as session:
        await session.execute(delete(User).where(User.id == uuid.UUID(commenter.id)))
        await session.commit()

    [kept] = await listed(client, owner, doc_id)
    assert [(c["author"], c["body"]) for c in kept["comments"]] == [
        (None, "Is this number right?"),
        ({"id": owner.id, "name": "Owner"}, "Noted"),
    ]


async def test_trashing_the_document_hides_its_comments(app: FastAPI, client: AsyncClient) -> None:
    owner, commenter, _, doc_id = await team(app, client)
    await open_thread(client, commenter, doc_id)

    await client.delete(f"/api/documents/{doc_id}", headers=owner.headers)

    response = await client.get(threads_url(doc_id), headers=commenter.headers)
    assert response.status_code == 404


# ----- input --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "change",
    [
        {"anchor_start": "not base64!"},
        {"anchor_start": ""},
        {"anchor_end": base64.b64encode(bytes(257)).decode()},
        {"anchor_end": 12},
        {"body": "   "},
        {"body": "x" * 4001},
        {"quoted_text": "x" * 501},
    ],
)
async def test_malformed_threads_are_refused(
    app: FastAPI, client: AsyncClient, change: dict[str, Any]
) -> None:
    owner, _, _, doc_id = await team(app, client)
    payload = {"anchor_start": START, "anchor_end": END, "quoted_text": "q", "body": "b", **change}

    response = await client.post(threads_url(doc_id), json=payload, headers=owner.headers)

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


async def test_threads_and_replies_are_capped(
    app: FastAPI, client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner, _, _, doc_id = await team(app, client)
    monkeypatch.setattr(service, "MAX_THREADS_PER_STREAM", 1)
    monkeypatch.setattr(service, "MAX_COMMENTS_PER_THREAD", 2)
    thread = await open_thread(client, owner, doc_id)
    await answer(client, owner, doc_id, thread["id"], "Second")

    another_thread = await client.post(
        threads_url(doc_id),
        json={"anchor_start": START, "anchor_end": END, "quoted_text": "", "body": "More"},
        headers=owner.headers,
    )
    third_comment = await client.post(
        threads_url(doc_id, f"/{thread['id']}/comments"),
        json={"body": "Third"},
        headers=owner.headers,
    )

    assert another_thread.json()["code"] == "too_many_threads"
    assert third_comment.json()["code"] == "too_many_comments"


# ----- branches ---------------------------------------------------------------------------------


async def test_branch_comments_stay_on_their_branch(app: FastAPI, client: AsyncClient) -> None:
    owner, commenter, _, doc_id = await team(app, client)
    branch = (
        await client.post(
            f"/api/documents/{doc_id}/branches", json={"name": "Draft"}, headers=owner.headers
        )
    ).json()
    on_main = await open_thread(client, owner, doc_id, "About main")
    on_branch = await open_thread(
        client, commenter, doc_id, "About the draft", branch_id=branch["id"]
    )

    assert [t["id"] for t in await listed(client, owner, doc_id)] == [on_main["id"]]
    assert [t["id"] for t in await listed(client, owner, doc_id, branch["id"])] == [on_branch["id"]]
    assert on_branch["branch_id"] == branch["id"]

    await client.post(
        f"/api/documents/{doc_id}/branches/{branch['id']}/close", headers=owner.headers
    )

    # A closed branch is read-only, its discussion included, but stays readable.
    [kept] = await listed(client, owner, doc_id, branch["id"])
    assert kept["can_reply"] is False
    assert all(not c["can_delete"] for c in kept["comments"])
    refused = [
        await client.post(
            threads_url(doc_id),
            json={
                "branch_id": branch["id"],
                "anchor_start": START,
                "anchor_end": END,
                "quoted_text": "",
                "body": "Late",
            },
            headers=owner.headers,
        ),
        await client.post(
            threads_url(doc_id, f"/{on_branch['id']}/comments"),
            json={"body": "Late"},
            headers=owner.headers,
        ),
        await client.delete(
            comment_url(doc_id, on_branch["comments"][0]["id"]), headers=owner.headers
        ),
    ]
    assert [r.json()["code"] for r in refused] == ["branch_not_open"] * 3


async def test_a_branch_of_another_document_is_not_found(app: FastAPI, client: AsyncClient) -> None:
    owner, _, _, doc_id = await team(app, client)
    other_doc = (await create_doc(client, owner, "Other"))["id"]
    foreign = (
        await client.post(
            f"/api/documents/{other_doc}/branches", json={"name": "B"}, headers=owner.headers
        )
    ).json()

    response = await client.get(
        threads_url(doc_id), params={"branch_id": foreign["id"]}, headers=owner.headers
    )

    assert response.json()["code"] == "branch_not_found"


# ----- live updates -----------------------------------------------------------------------------


async def test_open_editors_hear_that_comments_changed(app: FastAPI, client: AsyncClient) -> None:
    owner, commenter, viewer, doc_id = await team(app, client)
    branch = (
        await client.post(
            f"/api/documents/{doc_id}/branches", json={"name": "Draft"}, headers=owner.headers
        )
    ).json()

    async with (
        open_document(app, viewer, doc_id) as reader,
        open_document(app, owner, doc_id, branch_id=branch["id"]) as fork,
    ):
        thread = await open_thread(client, commenter, doc_id)
        await reader.until(lambda: reader.comment_signals == 1)
        await answer(client, owner, doc_id, thread["id"], "Reply")
        await reader.until(lambda: reader.comment_signals == 2)
        await client.patch(
            threads_url(doc_id, f"/{thread['id']}"), json={"resolved": True}, headers=owner.headers
        )
        await reader.until(lambda: reader.comment_signals == 3)

        # Main's comments are not the branch's business.
        with pytest.raises(TimeoutError):
            await fork.until(lambda: fork.comment_signals > 0, timeout=0.3)
        await open_thread(client, owner, doc_id, branch_id=branch["id"])
        await fork.until(lambda: fork.comment_signals == 1)


# ----- email --------------------------------------------------------------------------------------


async def test_a_new_thread_emails_the_owner(
    app: FastAPI, client: AsyncClient, outbox: Outbox
) -> None:
    owner, commenter, _, doc_id = await team(app, client)
    thread = await open_thread(client, commenter, doc_id, "Is this number right?")

    [email] = outbox.sent
    assert email.to == owner.email
    assert email.subject == "Commenter commented on “Q4 plan”"
    assert "> budget of 10k" in email.text
    assert "Is this number right?" in email.text
    assert f"http://localhost:5173/d/{doc_id}?thread={thread['id']}" in email.text


async def test_replies_email_everyone_in_the_thread_but_the_author(
    app: FastAPI, client: AsyncClient, outbox: Outbox
) -> None:
    owner, commenter, _, doc_id = await team(app, client)
    editor = await register(client, email="e@example.com", name="Editor")
    await grant(app, doc_id, editor, DocumentRole.EDITOR)
    thread = await open_thread(client, owner, doc_id)
    assert outbox.sent == []  # nobody to tell: the owner wrote it

    await answer(client, commenter, doc_id, thread["id"], "Looks off")
    assert [e.to for e in outbox.sent] == [owner.email]
    assert outbox.sent[0].subject == "Commenter replied on “Q4 plan”"

    outbox.sent.clear()
    await answer(client, editor, doc_id, thread["id"], "Fixed it")
    assert sorted(e.to for e in outbox.sent) == [commenter.email, owner.email]

    # Someone who lost access hears nothing more.
    async with app.state.sessionmaker() as session:
        await session.execute(
            delete(DocumentMember).where(
                DocumentMember.document_id == uuid.UUID(doc_id),
                DocumentMember.user_id == uuid.UUID(commenter.id),
            )
        )
        await session.commit()
    outbox.sent.clear()
    await answer(client, owner, doc_id, thread["id"], "Thanks")
    assert [e.to for e in outbox.sent] == [editor.email]


async def test_branch_comment_emails_name_the_branch(
    app: FastAPI, client: AsyncClient, outbox: Outbox
) -> None:
    owner, commenter, _, doc_id = await team(app, client)
    branch = (
        await client.post(
            f"/api/documents/{doc_id}/branches", json={"name": "Draft"}, headers=owner.headers
        )
    ).json()

    await open_thread(client, commenter, doc_id, branch_id=branch["id"])

    [email] = outbox.sent
    assert "“Q4 plan” (branch “Draft”):" in email.text
    assert f"/d/{doc_id}/b/{branch['id']}?thread=" in email.text


async def test_a_failing_mailer_does_not_fail_the_comment(
    app: FastAPI, client: AsyncClient
) -> None:
    class Broken:
        async def send(self, email: Email) -> None:
            raise ConnectionError("SMTP is down")

    app.state.mailer = Broken()
    owner, commenter, _, doc_id = await team(app, client)

    await open_thread(client, commenter, doc_id)

    assert len(await listed(client, owner, doc_id)) == 1


async def test_writing_comments_has_its_own_rate_limit(settings: Settings) -> None:
    limited = create_app(settings.model_copy(update={"rate_limit_enabled": True}))
    async with limited.router.lifespan_context(limited):
        await reset_state(limited)
        async with AsyncClient(
            transport=ASGITransport(app=limited), base_url="http://testserver.local"
        ) as client:
            owner = await register(client, email="owner@example.com", name="Owner")
            doc_id = (await create_doc(client, owner))["id"]
            payload = {"anchor_start": START, "anchor_end": END, "quoted_text": "", "body": "x"}
            statuses = [
                (await client.post(threads_url(doc_id), json=payload, headers=owner.headers))
                for _ in range(61)
            ]

    assert [r.status_code for r in statuses] == [201] * 60 + [429]
    assert statuses[-1].json()["code"] == "rate_limited"
