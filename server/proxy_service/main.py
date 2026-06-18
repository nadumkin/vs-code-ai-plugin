"""Proxy Service (FastAPI).

Accepts a chat request from the plugin, verifies the access token, logs the
request to Postgres, enqueues it on RabbitMQ, and returns a requestId.
"""

import uuid
from contextlib import asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException

from common.config import get_settings
from common.db import ensure_tables, session_scope
from common.models import Request
from common.rabbit import RabbitClient
from common.schemas import ChatRequest
from common.tokens import extract_bearer, get_token_store

settings = get_settings()
rabbit = RabbitClient()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_tables()
    await rabbit.connect()
    try:
        yield
    finally:
        await rabbit.close()


app = FastAPI(title="Proxy Service", lifespan=lifespan)


def require_token(authorization: str | None = Header(default=None)) -> str:
    token = extract_bearer(authorization)
    if not get_token_store().verify(token):
        raise HTTPException(status_code=401, detail="Invalid or missing access token")
    return token  # type: ignore[return-value]


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/models")
async def list_models() -> dict:
    """Proxy the model list from the LLM Service (its registry is the source of truth).

    No token required — this is non-sensitive metadata and lets the settings UI
    populate the model dropdown before an access token is saved.
    """
    url = f"{settings.llm_url.rstrip('/')}/v1/models"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url)
            response.raise_for_status()
            return response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"LLM service unavailable: {exc}")


@app.post("/v1/requests")
async def create_request(
    req: ChatRequest,
    token: str = Depends(require_token),
) -> dict[str, str]:
    request_id = uuid.uuid4().hex

    async with session_scope() as session:
        session.add(
            Request(
                request_id=request_id,
                token=token,
                model=req.model,
                payload=req.model_dump(),
                status="queued",
            )
        )
        await session.commit()

    await rabbit.publish(settings.request_queue, {"requestId": request_id})
    return {"requestId": request_id}
