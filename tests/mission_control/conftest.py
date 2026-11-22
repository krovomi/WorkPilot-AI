"""Mission Control tests: the model registry's cache is the test's own.

`model_pick` asks models.dev's cached records whether a model calls tools; a
cache left in the developer's home must not decide a test. The metrics ledger
(`metrics.py`) is the test's own too: a session that ends writes it. A local
Ollama is asked whether its model calls tools: no test reaches the developer's
own server, and none inherits what an earlier test's server said.
"""

from __future__ import annotations

import json
import socket
import time

import public_model_registry
import pytest
from offline_policy import local_model_catalog


def closed_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture(autouse=True)
def model_cache(monkeypatch, tmp_path):
    """Write the registry cache: ``{models.dev provider id: [records]}``."""
    path = tmp_path / "model_registry.json"
    monkeypatch.setattr(public_model_registry, "CACHE_PATH", path)
    monkeypatch.delenv("MODEL_REGISTRY_ENABLED", raising=False)
    monkeypatch.setenv("OLLAMA_MODEL", "qwen3-coder")
    monkeypatch.setenv("WORKPILOT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("OLLAMA_BASE_URL", f"http://127.0.0.1:{closed_port()}")
    monkeypatch.setattr(local_model_catalog, "_TOOLS", {})

    def write(providers: dict[str, list[dict]]) -> None:
        path.write_text(
            json.dumps({"fetched_at": time.time(), "providers": providers}),
            encoding="utf-8",
        )

    return write
