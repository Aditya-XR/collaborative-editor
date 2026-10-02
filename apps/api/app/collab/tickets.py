"""One-time WebSocket tickets.

Browsers cannot set headers on a WebSocket handshake, so the credential has to travel in the URL,
where proxies and logs can see it. Instead of the access token, the URL carries a random ticket
that is valid for one connection, to one document, for 30 seconds.
"""

import json
import secrets
import uuid
from dataclasses import dataclass

from redis.asyncio import Redis

from app.documents.models import DocumentRole


@dataclass(frozen=True)
class TicketClaims:
    user_id: uuid.UUID
    user_name: str
    document_id: uuid.UUID
    role: DocumentRole
    # The branch to open, or None for the document's main text.
    branch_id: uuid.UUID | None = None


def _key(ticket: str) -> str:
    return f"collab:ticket:{ticket}"


async def issue_ticket(redis: Redis, claims: TicketClaims, ttl_seconds: int) -> str:
    ticket = secrets.token_urlsafe(24)
    payload = {
        "user_id": str(claims.user_id),
        "user_name": claims.user_name,
        "document_id": str(claims.document_id),
        "role": claims.role.value,
        "branch_id": str(claims.branch_id) if claims.branch_id else None,
    }
    await redis.set(_key(ticket), json.dumps(payload), ex=ttl_seconds)
    return ticket


async def redeem_ticket(redis: Redis, ticket: str) -> TicketClaims | None:
    """Returns the claims and deletes the ticket in one step, so it can never be used twice."""
    if not ticket or len(ticket) > 64:
        return None
    raw = await redis.getdel(_key(ticket))
    if raw is None:
        return None
    data = json.loads(raw)
    return TicketClaims(
        user_id=uuid.UUID(data["user_id"]),
        user_name=data["user_name"],
        document_id=uuid.UUID(data["document_id"]),
        role=DocumentRole(data["role"]),
        branch_id=uuid.UUID(data["branch_id"]) if data.get("branch_id") else None,
    )
