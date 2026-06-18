"""Adapter that forwards the request to any OpenAI-compatible /chat/completions API.

Works with OpenRouter as well as self-hosted servers on another machine (Ollama,
vLLM, LM Studio, text-generation-inference): set ``base_url`` to that endpoint and
``api_key`` only if it requires auth. The input is already the OpenAI wire format,
so tool-calling works natively and the upstream response is returned unchanged.
"""

from typing import Any

import httpx

from common.config import get_settings
from common.schemas import ChatRequest

from .base import BaseModelAdapter


class OpenRouterAdapter(BaseModelAdapter):
    name = "openrouter"

    def __init__(self, **params: Any) -> None:
        super().__init__(**params)
        settings = get_settings()
        self._base_url = params.get("base_url", settings.openrouter_base_url)
        self._api_key = params.get("api_key") or settings.openrouter_key
        # Optional override so a logical model id (e.g. "openai/gpt-5.2") can map
        # to a specific upstream model name.
        self._upstream_model = params.get("upstream_model")
        self._timeout = float(params.get("timeout", 120.0))

    async def generate(self, request: ChatRequest) -> dict[str, Any]:
        body = request.model_dump(exclude_none=True)
        if self._upstream_model:
            body["model"] = self._upstream_model

        headers = {
            "Content-Type": "application/json",
            "X-Title": "VS Code AI Agent Assistant",
        }
        # Send auth only when a key is configured. Self-hosted servers (Ollama,
        # vLLM, LM Studio) usually need none; OpenRouter returns 401 if it's missing.
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.post(self._base_url, headers=headers, json=body)
            response.raise_for_status()
            return response.json()
