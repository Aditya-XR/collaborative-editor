import uuid

import anyio
import structlog
from fastapi import APIRouter, Depends, Request, Response, WebSocket
from pydantic import BaseModel
from starlette.websockets import WebSocketDisconnect

from app.auth.deps import CurrentUser, limit_api_per_user
from app.collab.manager import RoomManager
from app.collab.protocol import ProtocolError
from app.collab.room import CloseCode, Connection, Room, TokenBucket
from app.collab.tickets import TicketClaims, issue_ticket, redeem_ticket
from app.core.config import Settings
from app.core.deps import AppSettings, DbSession
from app.core.ratelimit.deps import enforce
from app.core.ratelimit.policies import COLLAB_TICKET_PER_USER
from app.documents import service as documents
from app.documents.models import DocumentRole

log = structlog.get_logger()

router = APIRouter(tags=["collaboration"])


class TicketRequest(BaseModel):
    document_id: uuid.UUID


class TicketOut(BaseModel):
    ticket: str
    expires_in: int
    role: DocumentRole


async def limit_tickets(request: Request, response: Response, user: CurrentUser) -> None:
    await enforce(request, response, COLLAB_TICKET_PER_USER, str(user.id))


@router.post(
    "/collab/tickets",
    status_code=201,
    dependencies=[Depends(limit_api_per_user), Depends(limit_tickets)],
)
async def create_ticket(
    body: TicketRequest,
    request: Request,
    user: CurrentUser,
    session: DbSession,
    settings: AppSettings,
) -> TicketOut:
    """A single-use, 30-second credential for opening one document's WebSocket."""
    view = await documents.get_for(session, user, body.document_id)
    claims = TicketClaims(user.id, user.name, body.document_id, view.role)
    ticket = await issue_ticket(request.app.state.redis, claims, settings.collab_ticket_ttl_seconds)
    return TicketOut(ticket=ticket, expires_in=settings.collab_ticket_ttl_seconds, role=view.role)


@router.websocket("/ws/docs/{document_id}")
async def collaborate(websocket: WebSocket, document_id: uuid.UUID, ticket: str = "") -> None:
    # Accept first: a close before accepting reaches the browser as a bare 1006 with no code,
    # and the client needs the code to decide whether to retry.
    await websocket.accept()
    settings: Settings = websocket.app.state.settings
    claims = await redeem_ticket(websocket.app.state.redis, ticket)
    if claims is None or claims.document_id != document_id:
        await websocket.close(CloseCode.INVALID_TICKET, "Invalid or expired ticket")
        return

    rooms: RoomManager = websocket.app.state.rooms
    if not rooms.reserve_connection(claims.user_id):
        await websocket.close(CloseCode.RATE_LIMITED, "Too many open connections")
        return
    try:
        room = await rooms.acquire(document_id)
        connection = Connection(
            websocket,
            user_id=claims.user_id,
            user_name=claims.user_name,
            role=claims.role,
            bucket=TokenBucket(settings.collab_message_burst, settings.collab_messages_per_second),
            queue_size=settings.collab_send_queue_size,
        )
        room.join(connection)
        try:
            await _pump(websocket, room, connection)
        finally:
            # Shielded: when the server cancels this task (shutdown, or the client vanishing),
            # anyio cancels every await in a plain finally block, and the room would never be
            # released or saved.
            # Bookkeeping and saving come first, network I/O last: a dead socket must never
            # stand between an edit and the database.
            with anyio.CancelScope(shield=True):
                room.leave(connection)
                await rooms.release(room)
                await connection.close(1000, "Bye")
    finally:
        rooms.release_connection(claims.user_id)


async def _pump(websocket: WebSocket, room: Room, connection: Connection) -> None:
    """Reads client messages until the socket closes."""
    try:
        while not connection.closed:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
            data = message.get("bytes")
            if data is None:
                await connection.close(CloseCode.BAD_MESSAGE, "Binary messages only")
                return
            if not connection.bucket.take():
                await connection.close(CloseCode.RATE_LIMITED, "Too many messages")
                return
            try:
                room.receive(connection, data)
            except ProtocolError as exc:
                log.warning("closing connection after protocol error", error=str(exc))
                await connection.close(CloseCode.BAD_MESSAGE, "Invalid message")
                return
    except (WebSocketDisconnect, RuntimeError):
        return
