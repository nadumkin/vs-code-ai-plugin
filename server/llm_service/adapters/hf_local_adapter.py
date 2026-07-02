"""Adapter that runs a local HuggingFace Transformers model.

`torch` is imported in ``__init__`` so that on the default CPU image (no torch)
construction raises ImportError and the registry simply skips this model. On the
CUDA/HF image torch is present, the device is auto-detected (CUDA -> MPS -> CPU),
and weights load lazily on first request.

Tool-calling: when the request carries ``tools``, they are passed to the chat
template (Qwen2.5 is trained for function calling) and the model's
``<tool_call>{...}</tool_call>`` blocks are parsed into OpenAI ``tool_calls`` so
the plugin can apply file edits / run commands — same as a real provider.
"""

import asyncio
import gc
import json
import re
import threading
from typing import Any

from common.schemas import ChatRequest, build_completion
from llm_service.device import detect_device

from .base import BaseModelAdapter

# A capable model emits <tool_call>{...}</tool_call>; the small Qwen often emits the
# same JSON inside a ```json fenced block — handle both (plus a bare JSON object).
_TOOL_CALL_RE = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.DOTALL)
_FENCE_RE = re.compile(r"```(?:json|tool_call)?\s*(.*?)\s*```", re.DOTALL)

# Single-GPU policy: only one hf_local model may hold weights at a time.
# Switching models unloads the previous one (VRAM on a 12 GB card can't fit
# e.g. 3B bf16 + 7B nf4 together). The lock also serializes load/generate so a
# request to model B can't unload model A mid-generation.
_gpu_lock = threading.Lock()
_loaded_adapter: "HFLocalAdapter | None" = None


class HFLocalAdapter(BaseModelAdapter):
    name = "hf_local"

    def __init__(self, **params: Any) -> None:
        super().__init__(**params)
        # Fail fast if torch is unavailable -> registry skips this entry.
        import torch

        self._torch = torch
        self._model_path = params.get("model_path", "Qwen/Qwen1.5-MoE-A2.7B-Chat")
        self._max_new_tokens = int(params.get("max_new_tokens", 256))
        # "4bit" (NF4) / "8bit" / None. On a 12 GB card (RTX 4070) a 7B model in
        # bf16 (~15 GB) doesn't fit and accelerate offloads layers to CPU, which
        # is dramatically slow; 4-bit shrinks it to ~5 GB so it stays on-GPU.
        self._quantization = params.get("quantization")
        # Weak models (e.g. 0.5B) can't drive tool-calling; ignore advertised tools
        # so they return the edited file as a code block (applied via the fallback).
        self._supports_tools = bool(params.get("supports_tools", True))
        self._device = detect_device()
        # bfloat16: numerically more stable than float16 on modern NVIDIA GPUs
        # (Ampere+) and mandatory for Blackwell (RTX 50xx) correctness.
        # MPS only supports float16, CPU needs float32.
        if self._device == "cuda":
            self._dtype = torch.bfloat16
        elif self._device == "mps":
            self._dtype = torch.float16
        else:
            self._dtype = torch.float32
        self._model = None
        self._tokenizer = None

    def _unload(self) -> None:
        """Drop weights and return the memory to the device (called under _gpu_lock)."""
        self._model = None
        self._tokenizer = None
        gc.collect()
        if self._device == "cuda":
            self._torch.cuda.empty_cache()

    def _ensure_loaded(self) -> None:
        """Load weights lazily; evict the previously loaded model first.

        Must be called under ``_gpu_lock``.
        """
        global _loaded_adapter
        if self._model is not None:
            return
        if _loaded_adapter is not None and _loaded_adapter is not self:
            _loaded_adapter._unload()
            _loaded_adapter = None
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self._tokenizer = AutoTokenizer.from_pretrained(self._model_path)
        if self._device == "cuda":
            # Prefer the flash-attn package when present; otherwise use torch's
            # built-in fused SDPA kernels (FlashAttention-style, no extra deps —
            # the runtime image has no nvcc to build flash-attn from source).
            attn = "flash_attention_2"
            try:
                import flash_attn  # noqa: F401
            except ImportError:
                attn = "sdpa"

            kwargs: dict[str, Any] = dict(
                torch_dtype=self._dtype,
                device_map="auto",
                attn_implementation=attn,
            )
            if self._quantization in ("4bit", "8bit"):
                from transformers import BitsAndBytesConfig

                if self._quantization == "4bit":
                    kwargs["quantization_config"] = BitsAndBytesConfig(
                        load_in_4bit=True,
                        bnb_4bit_quant_type="nf4",
                        bnb_4bit_compute_dtype=self._dtype,
                        bnb_4bit_use_double_quant=True,
                    )
                else:
                    kwargs["quantization_config"] = BitsAndBytesConfig(
                        load_in_8bit=True
                    )
                # bitsandbytes manages placement; dtype is set via compute_dtype.
                kwargs.pop("torch_dtype")
            self._model = AutoModelForCausalLM.from_pretrained(
                self._model_path, **kwargs
            )
        else:
            model = AutoModelForCausalLM.from_pretrained(
                self._model_path, torch_dtype=self._dtype
            )
            model.to(self._device)
            self._model = model
        self._model.eval()
        _loaded_adapter = self

    def _build_inputs(self, request: ChatRequest):
        """Render the prompt, advertising tools to the model when present."""
        tools = request.tools if (request.tools and self._supports_tools) else None
        kwargs = dict(tokenize=True, add_generation_prompt=True, return_tensors="pt")
        if tools:
            try:
                return self._tokenizer.apply_chat_template(
                    request.messages, tools=tools, **kwargs
                ).to(self._device)
            except Exception:  # noqa: BLE001 - template may not accept tools
                pass
        return self._tokenizer.apply_chat_template(request.messages, **kwargs).to(
            self._device
        )

    def _generate_sync(self, request: ChatRequest) -> str:
        # Hold the lock for the whole load+generate: another model's request
        # must not evict our weights while we are decoding.
        with _gpu_lock:
            self._ensure_loaded()
            assert self._tokenizer is not None and self._model is not None
            torch = self._torch

            inputs = self._build_inputs(request)
            with torch.no_grad():
                # Greedy decoding: deterministic + more reliable tool-call
                # formatting for a small model (sampling made it emit tool
                # calls only sometimes).
                generated = self._model.generate(
                    inputs,
                    max_new_tokens=self._max_new_tokens,
                    do_sample=False,
                    pad_token_id=self._tokenizer.eos_token_id,
                )
            new_tokens = generated[0][inputs.shape[-1]:]
            return self._tokenizer.decode(
                new_tokens, skip_special_tokens=True
            ).strip()

    @staticmethod
    def _parse_tool_calls(
        text: str, tool_names: set[str]
    ) -> tuple[str, list[dict[str, Any]]]:
        """Turn the model output into OpenAI tool_calls when it looks like one.

        Accepts <tool_call>{...}</tool_call>, a ```json fenced object, or a bare
        JSON object. A candidate is only treated as a tool call if its ``name``
        matches one of the advertised tools (avoids false positives on plain code).
        Returns (content, tool_calls); content is cleared when tool calls are found.
        """
        candidates = [m.group(1) for m in _TOOL_CALL_RE.finditer(text)]
        if not candidates:
            candidates = [m.group(1) for m in _FENCE_RE.finditer(text)]
        if not candidates:
            stripped = text.strip()
            if stripped.startswith("{") and stripped.endswith("}"):
                candidates = [stripped]

        calls: list[dict[str, Any]] = []
        for index, raw in enumerate(candidates):
            try:
                obj = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(obj, dict):
                continue
            name = obj.get("name")
            if not isinstance(name, str) or (tool_names and name not in tool_names):
                continue
            args = obj.get("arguments", obj.get("parameters", {}))
            calls.append(
                {
                    "id": f"call_{index}",
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": args if isinstance(args, str)
                        else json.dumps(args, ensure_ascii=False),
                    },
                }
            )

        if calls:
            return "", calls
        return text, []

    async def generate(self, request: ChatRequest) -> dict[str, Any]:
        raw = await asyncio.to_thread(self._generate_sync, request)
        tool_names = {
            t.get("function", {}).get("name")
            for t in (request.tools or [])
            if isinstance(t, dict)
        }
        tool_names.discard(None)
        content, tool_calls = self._parse_tool_calls(raw, tool_names)
        return build_completion(request.model, content=content, tool_calls=tool_calls)
