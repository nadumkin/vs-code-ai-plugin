"""LLM Service (FastAPI + background consumer).

Consumes the ``requests`` queue, loads the request payload from Postgres, runs
inference through the adapter selected by the model id, writes the result back
to Postgres, and publishes a notification on the ``responses`` queue.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import select

from common.config import get_settings
from common.db import ensure_tables, session_scope
from common.models import Request
from common.rabbit import RabbitClient
from common.schemas import ChatRequest

from llm_service.adapters.registry import ModelRegistry
from llm_service.device import describe_device

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("llm_service")

settings = get_settings()
rabbit = RabbitClient()
registry: ModelRegistry | None = None


async def handle_request(data: dict) -> None:
    request_id = data.get("requestId")
    if not request_id:
        return

    # Load payload and mark as processing.
    async with session_scope() as session:
        row = (
            await session.execute(
                select(Request).where(Request.request_id == request_id)
            )
        ).scalar_one_or_none()
        if row is None:
            logger.warning("requestId %s not found in DB; dropping", request_id)
            return
        payload = row.payload
        row.status = "processing"
        await session.commit()

    status = "done"
    completion: dict | None = None
    error: str | None = None
    try:
        assert registry is not None
        chat_request = ChatRequest(**payload)
        adapter = registry.select(chat_request.model)
        logger.info(
            "request %s -> adapter %s (model %s)",
            request_id,
            adapter.name,
            chat_request.model,
        )
        completion = await adapter.generate(chat_request)
    except Exception as exc:  # noqa: BLE001 - record failure, keep consuming
        status = "error"
        error = str(exc)
        logger.exception("inference failed for %s", request_id)

    # Persist the outcome.
    async with session_scope() as session:
        row = (
            await session.execute(
                select(Request).where(Request.request_id == request_id)
            )
        ).scalar_one_or_none()
        if row is not None:
            row.status = status
            row.response = completion
            row.error = error
            await session.commit()

    # Notify the Request Service that this requestId is ready.
    await rabbit.publish(
        settings.response_queue, {"requestId": request_id, "status": status}
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    global registry
    await ensure_tables()
    logger.info("device auto-check: %s", describe_device())
    registry = ModelRegistry.from_file(settings.models_file)
    await rabbit.connect(prefetch=4)
    await rabbit.consume(settings.request_queue, handle_request)
    logger.info("LLM Service ready, consuming '%s'", settings.request_queue)
    try:
        yield
    finally:
        await rabbit.close()


app = FastAPI(title="LLM Service", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "device": describe_device().get("device")}


@app.get("/v1/models")
async def list_models() -> dict:
    if registry is None:
        return {"models": []}
    return {"models": registry.list_models()}
