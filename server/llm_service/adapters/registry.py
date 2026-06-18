"""Model registry: maps a model id to a concrete adapter instance.

Configured from ``models.json``::

    {
      "default": "mock/echo",
      "models": [
        {"id": "mock/echo", "adapter": "echo"},
        {"id": "openai/gpt-5.2", "adapter": "openrouter",
         "params": {"upstream_model": "openai/gpt-5.2"}},
        {"id": "local/qwen", "adapter": "hf_local",
         "params": {"model_path": "Qwen/Qwen2.5-Coder-1.5B-Instruct"}}
      ]
    }

Several entries can point at the same adapter type with different params, so the
service hosts "several models" behind one uniform interface.
"""

import json
import logging
from typing import Any

from .base import BaseModelAdapter
from .echo_adapter import EchoAdapter
from .openrouter_adapter import OpenRouterAdapter

logger = logging.getLogger("llm_service.registry")

# Lightweight adapters can be referenced directly. hf_local is imported lazily
# (only when configured) to avoid pulling in torch/transformers.
_ADAPTER_TYPES: dict[str, type[BaseModelAdapter]] = {
    "echo": EchoAdapter,
    "openrouter": OpenRouterAdapter,
}


def _load_hf_adapter() -> type[BaseModelAdapter]:
    from .hf_local_adapter import HFLocalAdapter

    return HFLocalAdapter


class ModelRegistry:
    def __init__(self) -> None:
        self._by_id: dict[str, BaseModelAdapter] = {}
        self._default_id: str | None = None

    @classmethod
    def from_file(cls, path: str) -> "ModelRegistry":
        registry = cls()
        with open(path, "r", encoding="utf-8") as fh:
            config = json.load(fh)

        for entry in config.get("models", []):
            model_id = entry["id"]
            adapter_type = entry["adapter"]
            params = entry.get("params", {})
            try:
                registry._by_id[model_id] = registry._build(adapter_type, params)
                logger.info("registered model '%s' -> %s", model_id, adapter_type)
            except ImportError as exc:
                # Expected when a heavy adapter's deps aren't in this image
                # (e.g. hf_local/torch on the CPU build) — skip quietly.
                logger.warning(
                    "model '%s' (%s) skipped — missing dependency: %s",
                    model_id,
                    adapter_type,
                    exc,
                )
            except Exception:  # noqa: BLE001 - don't let one bad entry kill startup
                logger.exception(
                    "failed to register model '%s' (%s)", model_id, adapter_type
                )

        registry._default_id = config.get("default")
        if not registry._by_id:
            raise RuntimeError("ModelRegistry: no models were registered")
        return registry

    def _build(self, adapter_type: str, params: dict[str, Any]) -> BaseModelAdapter:
        if adapter_type == "hf_local":
            return _load_hf_adapter()(**params)
        if adapter_type not in _ADAPTER_TYPES:
            raise ValueError(f"Unknown adapter type: {adapter_type}")
        return _ADAPTER_TYPES[adapter_type](**params)

    def select(self, model_id: str) -> BaseModelAdapter:
        if model_id in self._by_id:
            return self._by_id[model_id]
        if self._default_id and self._default_id in self._by_id:
            logger.warning(
                "model '%s' not configured; falling back to default '%s'",
                model_id,
                self._default_id,
            )
            return self._by_id[self._default_id]
        raise KeyError(
            f"No adapter for model '{model_id}' and no usable default configured"
        )

    def list_models(self) -> list[dict]:
        """Return the registered models (the source of truth for /v1/models)."""
        return [
            {
                "id": model_id,
                "adapter": adapter.name,
                "default": model_id == self._default_id,
            }
            for model_id, adapter in self._by_id.items()
        ]
