"""Pydantic schemas defining the *uniform* adapter input and a helper for the
OpenAI chat.completion output shape that every adapter must produce."""

import time
import uuid
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict


class ChatRequest(BaseModel):
    """Unified adapter input — mirrors the OpenAI chat/completions request body
    the VS Code plugin already builds. Extra fields are preserved as-is."""

    model_config = ConfigDict(extra="allow", protected_namespaces=())

    model: str
    messages: list[dict[str, Any]]
    tools: Optional[list[dict[str, Any]]] = None
    tool_choice: Any = "auto"
    temperature: float = 0.1
    stream: bool = False


def build_completion(
    model: str,
    *,
    content: Optional[str] = None,
    tool_calls: Optional[list[dict[str, Any]]] = None,
    request_id: Optional[str] = None,
) -> dict[str, Any]:
    """Build an OpenAI chat.completion dict (the uniform adapter output).

    The plugin reads ``choices[0].message`` exactly as for a real provider:
    ``content`` for text, ``tool_calls`` to drive file edits / commands.
    """

    calls = tool_calls or []
    completion_id = f"chatcmpl-{request_id or uuid.uuid4().hex}"
    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": content if content is not None else "",
                    "tool_calls": calls,
                },
                "finish_reason": "tool_calls" if calls else "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def build_text_completion(
    model: str,
    text: str,
    *,
    request_id: Optional[str] = None,
) -> dict[str, Any]:
    """Wrap plain assistant text into an OpenAI chat.completion dict."""
    return build_completion(model, content=text, request_id=request_id)
