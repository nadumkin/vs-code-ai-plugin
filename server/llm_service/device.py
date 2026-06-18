"""Device auto-detection for local model inference.

Priority: CUDA -> MPS -> CPU. Safe to call even when torch is not installed
(the default CPU image), in which case it reports that hf_local is unavailable.
This is the "auto-check" logged when the LLM Service starts.
"""


def describe_device() -> dict:
    try:
        import torch
    except ImportError:
        return {
            "torch": False,
            "device": "cpu",
            "note": "torch not installed; hf_local models are disabled in this image",
        }

    cuda = bool(torch.cuda.is_available())
    mps = bool(
        getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()
    )
    device = "cuda" if cuda else ("mps" if mps else "cpu")

    info: dict = {
        "torch": True,
        "torch_version": torch.__version__,
        "cuda": cuda,
        "mps": mps,
        "device": device,
    }
    if cuda:
        try:
            info["gpu"] = torch.cuda.get_device_name(0)
        except Exception:  # noqa: BLE001 - best-effort label only
            pass
    return info


def detect_device() -> str:
    return describe_device()["device"]
