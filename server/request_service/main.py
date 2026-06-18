"""Request Service (FastAPI + WebSocket).

The plugin opens ``ws://host/ws/{requestId}?token=...`` after it has a
requestId. This service:

* validates the token (shared JSON file);
* if the response is already in the DB (the plugin connected *after* the model
  finished), sends it immediately;
* otherwise registers the connection and waits for a notification on the
  ``responses`` queue, then reads the finished response from the DB and sends it.

The ``responses`` queue carries only ``{requestId, status}`` — the DB is the
single source of truth for the payload, which keeps the connect-before and
connect-after paths identical (always read DB, then send).
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from common.config import get_settings
from common.db import ensure_tables, session_scope
from common.models import Request
from common.rabbit import RabbitClient
from common.tokens import get_token_store

logger = logging.getLogger("request_service")
settings = get_settings()
rabbit = RabbitClient()

# requestId -> event that is set once a "responses" notification arrives.
pending: dict[str, asyncio.Event] = {}


async def on_response(data: dict) -> None:
    request_id = data.get("requestId")
    if not request_id:
        return
    event = pending.get(request_id)
    if event is not None:
        # The response is already committed to the DB by the LLM Service before
        # this notification is published, so the waiter can safely read it.
        event.set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_tables()
    await rabbit.connect()
    await rabbit.consume(settings.response_queue, on_response)
    try:
        yield
    finally:
        await rabbit.close()


app = FastAPI(title="Request Service", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


async def _fetch(request_id: str) -> Request | None:
    async with session_scope() as session:
        result = await session.execute(
            select(Request).where(Request.request_id == request_id)
        )
        return result.scalar_one_or_none()


async def _send_final(ws: WebSocket, row: Request) -> None:
    if row.status == "done":
        await ws.send_json(
            {
                "type": "response",
                "requestId": row.request_id,
                "status": "done",
                "payload": row.response,
            }
        )
    else:
        await ws.send_json(
            {
                "type": "error",
                "requestId": row.request_id,
                "error": row.error or "request failed",
            }
        )


@app.websocket("/ws/{request_id}")
async def ws_endpoint(ws: WebSocket, request_id: str) -> None:
    token = ws.query_params.get("token")
    if not get_token_store().verify(token):
        await ws.close(code=1008)  # policy violation
        return

    await ws.accept()
    # Register the event BEFORE reading the DB so a notification that arrives
    # between the DB read and the wait is not lost (Event.set before wait()
    # still wakes the waiter).
    event = pending.setdefault(request_id, asyncio.Event())
    try:
        row = await _fetch(request_id)
        if row is None:
            await ws.send_json(
                {"type": "error", "requestId": request_id, "error": "unknown requestId"}
            )
            return

        if row.status in ("done", "error"):
            await _send_final(ws, row)  # connect-after: answer already ready
            return

        # connect-before: wait for the LLM Service to finish.
        try:
            await asyncio.wait_for(event.wait(), timeout=settings.ws_response_timeout)
        except asyncio.TimeoutError:
            await ws.send_json(
                {
                    "type": "error",
                    "requestId": request_id,
                    "error": "timeout waiting for response",
                }
            )
            return

        row = await _fetch(request_id)
        if row is not None:
            await _send_final(ws, row)
    except WebSocketDisconnect:
        logger.info("client disconnected before response: %s", request_id)
    finally:
        pending.pop(request_id, None)
