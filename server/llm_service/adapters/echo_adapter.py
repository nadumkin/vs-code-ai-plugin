"""Offline mock adapter — echoes the last user message back.

Lets the whole pipeline run end-to-end without any API key or model download.
"""

from typing import Any

from common.schemas import ChatRequest, build_text_completion

from .base import BaseModelAdapter


def _coerce_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        # OpenAI "parts" array: concatenate any text fragments.
        parts = [
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        ]
        return "".join(parts) or str(content)
    return str(content)


class EchoAdapter(BaseModelAdapter):
    name = "echo"

    def __init__(self, **params: Any) -> None:
        super().__init__(**params)
        self._prefix = params.get("prefix", "[echo] ")

    async def generate(self, request: ChatRequest) -> dict[str, Any]:
        last_user = ""
        for message in reversed(request.messages):
            if message.get("role") == "user":
                last_user = _coerce_text(message.get("content"))
                break
        text = f"{self._prefix}{last_user}".strip() or f"{self._prefix}(empty request)"
        return build_text_completion(request.model, text)
