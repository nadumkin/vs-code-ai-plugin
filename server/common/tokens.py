"""Access-token verification against a shared JSON file.

The file is mounted into both the Proxy Service and the Request Service. It is
re-read whenever its mtime changes, so edits propagate without a restart.

Accepted JSON shapes::

    {"tokens": [{"token": "abc", "name": "dev"}, "another-raw-token"]}
    {"tokens": ["abc", "def"]}
    ["abc", "def"]
"""

import json
import os
import threading
from typing import Optional

from .config import get_settings


class TokenStore:
    def __init__(self, path: str) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._mtime: float | None = None
        self._tokens: set[str] = set()

    def _reload_if_changed(self) -> None:
        try:
            mtime = os.path.getmtime(self._path)
        except OSError:
            with self._lock:
                self._tokens = set()
                self._mtime = None
            return

        if mtime == self._mtime:
            return

        try:
            with open(self._path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            # Keep the previously loaded tokens on a transient read/parse error.
            return

        entries = data.get("tokens", []) if isinstance(data, dict) else data
        tokens: set[str] = set()
        for entry in entries or []:
            if isinstance(entry, str) and entry.strip():
                tokens.add(entry.strip())
            elif isinstance(entry, dict) and entry.get("token"):
                tokens.add(str(entry["token"]).strip())

        with self._lock:
            self._tokens = tokens
            self._mtime = mtime

    def verify(self, token: Optional[str]) -> bool:
        if not token:
            return False
        self._reload_if_changed()
        with self._lock:
            return token in self._tokens


def extract_bearer(authorization: Optional[str]) -> Optional[str]:
    """Pull the token out of an ``Authorization: Bearer <token>`` header.

    Falls back to returning the raw header value if no scheme is present.
    """
    if not authorization:
        return None
    parts = authorization.split(" ", 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return authorization.strip()


_store: Optional[TokenStore] = None


def get_token_store() -> TokenStore:
    global _store
    if _store is None:
        _store = TokenStore(get_settings().tokens_file)
    return _store
