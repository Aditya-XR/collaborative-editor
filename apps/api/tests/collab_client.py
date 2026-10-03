"""A minimal Yjs peer for tests: speaks the same sync and awareness protocol as the browser."""

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from httpx_ws import AsyncWebSocketSession, WebSocketDisconnect, aconnect_ws
from httpx_ws.transport import ASGIWebSocketTransport
from pycrdt import (
    Doc,
    Text,
    XmlElement,
    XmlFragment,
    XmlText,
    create_sync_message,
    handle_sync_message,
)

from app.collab.protocol import (
    AWARENESS,
    COMMENTS,
    SYNC,
    SYNC_STEP2,
    AwarenessEntry,
    awareness_message,
    decode_awareness,
    encode_awareness,
    read_payload,
    sync_update_message,
)
from app.collab.text import EDITOR_ROOT
from tests.conftest import RegisteredUser

BASE = "http://testserver.local"


class Peer:
    def __init__(self, ws: AsyncWebSocketSession) -> None:
        self.ws = ws
        self.doc: Doc[Any] = Doc()
        self.text = self.doc.get("text", type=Text)
        self.awareness: dict[int, dict[str, Any] | None] = {}
        self._awareness_clock = 0
        # How many times the server said this stream's comments changed.
        self.comment_signals = 0

    # ----- receiving --------------------------------------------------------------------------

    async def handle_next(self, timeout: float = 2.0) -> None:
        await self._handle(await asyncio.wait_for(self.ws.receive_bytes(), timeout))

    async def _handle(self, message: bytes) -> None:
        if message[0] == SYNC:
            reply = handle_sync_message(message[1:], self.doc)
            if reply is not None:
                await self.ws.send_bytes(reply)
        elif message[0] == AWARENESS:
            for entry in decode_awareness(read_payload(message, 1)):
                self.awareness[entry.client_id] = (
                    json.loads(entry.state) if entry.state is not None else None
                )
        elif message == bytes([COMMENTS]):
            self.comment_signals += 1

    async def until(self, condition: Callable[[], bool], timeout: float = 3.0) -> None:
        async def loop() -> None:
            while not condition():
                await self.handle_next(timeout)

        await asyncio.wait_for(loop(), timeout)

    async def sync(self) -> None:
        """The opening handshake: exchange state vectors, then the missing updates."""
        await self.ws.send_bytes(create_sync_message(self.doc))
        synced = False

        while not synced:
            message = await asyncio.wait_for(self.ws.receive_bytes(), 3)
            synced = message[0] == SYNC and message[1] == SYNC_STEP2
            await self._handle(message)  # awareness can arrive during the handshake too

    async def closed_with(self, timeout: float = 3.0) -> int:
        """Reads until the server closes the socket; returns the close code."""
        try:
            while True:
                await asyncio.wait_for(self.ws.receive_bytes(), timeout)
        except WebSocketDisconnect as exc:
            return exc.code

    # ----- sending ----------------------------------------------------------------------------

    async def edit(self, change: Callable[[Text], object]) -> bytes:
        before = self.doc.get_state()
        change(self.text)
        update = self.doc.get_update(before)
        await self.ws.send_bytes(sync_update_message(update))
        return update

    async def insert(self, index: int, value: str) -> None:
        await self.edit(lambda text: text.insert(index, value))

    async def delete(self, index: int, length: int) -> None:
        def remove(text: Text) -> None:
            del text[index : index + length]

        await self.edit(remove)

    @property
    def body(self) -> XmlFragment:
        """The document as the browser editor stores it: an XML tree under Tiptap's root,
        rather than the flat test text above."""
        body: XmlFragment = self.doc.get(EDITOR_ROOT, type=XmlFragment)
        return body

    def paragraphs(self) -> list[str]:
        return [_text_of(block) for block in self.body.children]

    async def edit_body(self, change: Callable[[XmlFragment], object]) -> None:
        before = self.doc.get_state()
        change(self.body)
        await self.ws.send_bytes(sync_update_message(self.doc.get_update(before)))

    async def write_paragraphs(self, *paragraphs: str) -> None:
        def append(body: XmlFragment) -> None:
            for paragraph in paragraphs:
                element = body.children.append(XmlElement("paragraph"))
                element.children.append(XmlText(paragraph))

        await self.edit_body(append)

    async def append_to_paragraph(self, index: int, text: str) -> None:
        """Types at the end of a paragraph (ASCII only: pycrdt counts UTF-8 bytes)."""

        def type_text(body: XmlFragment) -> None:
            block = list(body.children)[index]
            assert isinstance(block, XmlElement)
            run = next(iter(block.children))
            assert isinstance(run, XmlText)
            run.insert(len(str(run)), text)

        await self.edit_body(type_text)

    async def delete_paragraph(self, index: int) -> None:
        def remove(body: XmlFragment) -> None:
            del body.children[index]

        await self.edit_body(remove)

    async def set_presence(self, state: dict[str, Any] | None) -> None:
        self._awareness_clock += 1
        raw = None if state is None else json.dumps(state)
        entry = AwarenessEntry(self.doc.client_id, self._awareness_clock, raw)
        await self.ws.send_bytes(awareness_message(encode_awareness([entry])))


def _text_of(block: XmlText | XmlElement | XmlFragment) -> str:
    if isinstance(block, XmlText):
        return str(block)
    return "".join(_text_of(child) for child in block.children)


async def ticket_for(
    app: FastAPI, user: RegisteredUser, document_id: str, branch_id: str | None = None
) -> str:
    async with AsyncClient(transport=ASGIWebSocketTransport(app), base_url=BASE) as http:
        response = await http.post(
            "/api/collab/tickets",
            json={"document_id": document_id, "branch_id": branch_id},
            headers=user.headers,
        )
    assert response.status_code == 201, response.text
    ticket: str = response.json()["ticket"]
    return ticket


@asynccontextmanager
async def connect(app: FastAPI, document_id: str, ticket: str) -> AsyncIterator[Peer]:
    async with AsyncClient(transport=ASGIWebSocketTransport(app), base_url=BASE) as http:
        url = f"{BASE}/api/ws/docs/{document_id}?ticket={ticket}"
        session: AsyncWebSocketSession
        async with aconnect_ws(url, http, keepalive_ping_interval_seconds=None) as session:
            yield Peer(session)


@asynccontextmanager
async def open_document(
    app: FastAPI,
    user: RegisteredUser,
    document_id: str,
    *,
    sync: bool = True,
    branch_id: str | None = None,
) -> AsyncIterator[Peer]:
    ticket = await ticket_for(app, user, document_id, branch_id)
    async with connect(app, document_id, ticket) as peer:
        if sync:
            await peer.sync()
        yield peer


async def eventually(check: Callable[[], Awaitable[bool]], timeout: float = 3.0) -> None:
    """Polls until the check passes; for effects that finish after a socket closes."""
    deadline = asyncio.get_running_loop().time() + timeout
    while not await check():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.02)
