"""Adapter for a local llama.cpp ``llama-server`` sidecar.

Used for models that don't fit in the GPU's VRAM under plain transformers —
notably the Qwen MoE. llama.cpp runs it with ``--cpu-moe``: attention/context
stay on the GPU while the (large, sparsely-used) expert weights live in CPU RAM,
so a ~14B-param MoE fits on an 8 GB card. See https://habr.com/ru/articles/961478/.

``llama-server`` speaks the OpenAI wire format, so this is just the OpenRouter
adapter pointed at the local sidecar: no API key, a longer default timeout (local
generation is slower), and the upstream "model" field is ignored by the server
(it serves the single model it was launched with).
"""

from typing import Any

from common.config import get_settings

from .openrouter_adapter import OpenRouterAdapter


class LlamaServerAdapter(OpenRouterAdapter):
    name = "llama_server"

    def __init__(self, **params: Any) -> None:
        params.setdefault("base_url", get_settings().llamacpp_base_url)
        super().__init__(**params)
        # Never send auth to the local sidecar (don't leak OPENROUTER_KEY), and
        # allow more time than a hosted API since CPU-offloaded MoE is slower.
        self._api_key = None
        self._timeout = float(params.get("timeout", 600.0))
