"""Thin aio-pika wrapper: one client per service holding a robust connection
and a channel, with publish + consume helpers."""

import json
from collections.abc import Awaitable, Callable
from typing import Any

import aio_pika
from aio_pika.abc import AbstractIncomingMessage

from .config import get_settings

Handler = Callable[[dict[str, Any]], Awaitable[None]]


class RabbitClient:
    def __init__(self, url: str | None = None) -> None:
        settings = get_settings()
        self._url = url or settings.rabbit_url
        self._request_queue = settings.request_queue
        self._response_queue = settings.response_queue
        self.connection: aio_pika.abc.AbstractRobustConnection | None = None
        self.channel: aio_pika.abc.AbstractChannel | None = None

    async def connect(self, prefetch: int = 16) -> "RabbitClient":
        self.connection = await aio_pika.connect_robust(self._url)
        self.channel = await self.connection.channel()
        await self.channel.set_qos(prefetch_count=prefetch)
        # Make sure both queues exist regardless of who starts first.
        await self.channel.declare_queue(self._request_queue, durable=True)
        await self.channel.declare_queue(self._response_queue, durable=True)
        return self

    async def publish(self, queue: str, body: dict[str, Any]) -> None:
        assert self.channel is not None, "RabbitClient.connect() must be called first"
        message = aio_pika.Message(
            body=json.dumps(body).encode("utf-8"),
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            content_type="application/json",
        )
        await self.channel.default_exchange.publish(message, routing_key=queue)

    async def consume(self, queue_name: str, handler: Handler) -> None:
        assert self.channel is not None, "RabbitClient.connect() must be called first"
        queue = await self.channel.declare_queue(queue_name, durable=True)

        async def _on_message(message: AbstractIncomingMessage) -> None:
            # requeue=False: a failing handler must not create a poison loop.
            async with message.process(requeue=False):
                data = json.loads(message.body.decode("utf-8"))
                await handler(data)

        await queue.consume(_on_message)

    async def close(self) -> None:
        if self.connection is not None:
            await self.connection.close()
