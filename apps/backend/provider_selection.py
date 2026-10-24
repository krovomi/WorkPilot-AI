"""The provider chosen in the UI, for the builds this process starts.

``POST /providers/select`` writes it; ``core/client.py``, ``core/model_info.py``
and ``phase_config.py`` read it. It used to live in ``provider_api``, so every
reader imported the FastAPI app to read one string: ``phase_config`` and
``core`` depended on the server module, and ``model_info`` could only peek at
``sys.modules`` to avoid closing an import cycle while logging. This module
imports nothing of the backend, so any layer may read it.

Process-wide on purpose: a desktop backend serves one user. In server mode the
route that writes it is refused (``deny_in_server_mode``).
"""

from __future__ import annotations

import threading

_selected_provider: str | None = None
_lock = threading.Lock()


def select_provider(provider: str | None) -> None:
    global _selected_provider
    with _lock:
        _selected_provider = provider


def get_selected_provider() -> str | None:
    with _lock:
        return _selected_provider
