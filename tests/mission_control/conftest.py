"""Mission Control tests: the model registry's cache is the test's own.

`model_pick` asks models.dev's cached records whether a model calls tools; a
cache left in the developer's home must not decide a test. The metrics ledger
(`metrics.py`) is the test's own too: a session that ends writes it.
"""

from __future__ import annotations

import json
import time

import public_model_registry
import pytest


@pytest.fixture(autouse=True)
def model_cache(monkeypatch, tmp_path):
    """Write the registry cache: ``{models.dev provider id: [records]}``."""
    path = tmp_path / "model_registry.json"
    monkeypatch.setattr(public_model_registry, "CACHE_PATH", path)
    monkeypatch.delenv("MODEL_REGISTRY_ENABLED", raising=False)
    monkeypatch.setenv("OLLAMA_MODEL", "qwen3-coder")
    monkeypatch.setenv("WORKPILOT_DATA_DIR", str(tmp_path / "data"))

    def write(providers: dict[str, list[dict]]) -> None:
        path.write_text(
            json.dumps({"fetched_at": time.time(), "providers": providers}),
            encoding="utf-8",
        )

    return write
