"""Adapter that runs a local HuggingFace Transformers model.

`torch` is imported in ``__init__`` so that on the default CPU image (no torch)
construction raises ImportError and the registry simply skips this model — it
won't appear in /v1/models. On the CUDA image torch is present, the device is
auto-detected (CUDA -> MPS -> CPU), and weights load lazily on first request.
"""

import asyncio
from typing import Any

from common.schemas import ChatRequest, build_text_completion
from llm_service.device import detect_device

from .base import BaseModelAdapter


class HFLocalAdapter(BaseModelAdapter):
    name = "hf_local"

    def __init__(self, **params: Any) -> None:
        super().__init__(**params)
        # Fail fast if torch is unavailable -> registry skips this entry.
        import torch

        self._torch = torch
        self._model_path = params.get("model_path", "Qwen/Qwen1.5-MoE-A2.7B-Chat")
        self._max_new_tokens = int(params.get("max_new_tokens", 256))
        self._device = detect_device()
        # fp16 on GPU/MPS, fp32 on CPU (CPU fp16 is slow / poorly supported).
        self._dtype = torch.float16 if self._device in ("cuda", "mps") else torch.float32
        self._model = None
        self._tokenizer = None

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self._tokenizer = AutoTokenizer.from_pretrained(self._model_path)
        model = AutoModelForCausalLM.from_pretrained(
            self._model_path, torch_dtype=self._dtype
        )
        model.to(self._device)
        model.eval()
        self._model = model

    def _generate_sync(self, request: ChatRequest) -> str:
        self._ensure_loaded()
        assert self._tokenizer is not None and self._model is not None
        torch = self._torch

        inputs = self._tokenizer.apply_chat_template(
            request.messages,
            tokenize=True,
            add_generation_prompt=True,
            return_tensors="pt",
        ).to(self._device)

        with torch.no_grad():
            generated = self._model.generate(
                inputs,
                max_new_tokens=self._max_new_tokens,
                do_sample=request.temperature > 0,
                temperature=max(request.temperature, 0.01),
                pad_token_id=self._tokenizer.eos_token_id,
            )
        new_tokens = generated[0][inputs.shape[-1]:]
        return self._tokenizer.decode(new_tokens, skip_special_tokens=True).strip()

    async def generate(self, request: ChatRequest) -> dict[str, Any]:
        # Run the blocking generate() off the event loop.
        text = await asyncio.to_thread(self._generate_sync, request)
        return build_text_completion(request.model, text)
