"""Adapter pattern: a uniform interface over heterogeneous model backends.

Every adapter takes the same input (:class:`ChatRequest`) and returns the same
output (an OpenAI ``chat.completion`` dict), so the rest of the LLM Service — and
the plugin — never has to care which backend produced the answer.
"""

from abc import ABC, abstractmethod
from typing import Any

from common.schemas import ChatRequest


class BaseModelAdapter(ABC):
    name: str = "base"

    def __init__(self, **params: Any) -> None:  # noqa: D401 - simple store
        self.params = params

    @abstractmethod
    async def generate(self, request: ChatRequest) -> dict[str, Any]:
        """Run inference and return an OpenAI chat.completion dict."""
        raise NotImplementedError
