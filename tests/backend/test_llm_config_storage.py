"""Storage guarantees for the provider config file.

``~/.work_pilot_ai_llm_providers.json`` holds API keys in clear text and every
mutation rewrites the whole file. These tests pin the three properties that
protects: writes are atomic, the file is owner-only, and a corrupt file
degrades gracefully instead of wedging every endpoint that touches it.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from src.connectors import llm_config  # noqa: E402


@pytest.fixture(autouse=True)
def _isolated_config(monkeypatch, tmp_path):
    """Point CONFIG_FILE at a temp file so the developer's real keys are safe."""
    monkeypatch.setattr(llm_config, "CONFIG_FILE", tmp_path / "providers.json")
    return llm_config.CONFIG_FILE


def test_round_trip(_isolated_config):
    llm_config.save_provider_config("openai", {"api_key": "sk-test", "model": "gpt"})
    assert llm_config.load_provider_config("openai") == {
        "api_key": "sk-test",
        "model": "gpt",
    }


def test_save_preserves_other_providers(_isolated_config):
    llm_config.save_provider_config("openai", {"api_key": "a"})
    llm_config.save_provider_config("anthropic", {"api_key": "b"})
    assert sorted(llm_config.list_provider_configs()) == ["anthropic", "openai"]


def test_delete_removes_only_the_named_provider(_isolated_config):
    llm_config.save_provider_config("openai", {"api_key": "a"})
    llm_config.save_provider_config("anthropic", {"api_key": "b"})
    llm_config.delete_provider_config("openai")
    assert llm_config.list_provider_configs() == ["anthropic"]


def test_active_provider_marker_is_hidden_from_the_listing(_isolated_config):
    llm_config.save_provider_config("openai", {"api_key": "a"})
    llm_config.set_active_provider("openai")
    assert llm_config.get_active_provider() == "openai"
    assert llm_config.list_provider_configs() == ["openai"]


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits only")
def test_written_file_is_owner_only(_isolated_config):
    llm_config.save_provider_config("openai", {"api_key": "sk-secret"})
    assert os.stat(_isolated_config).st_mode & 0o777 == 0o600


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits only")
def test_existing_world_readable_file_is_tightened_on_read(_isolated_config):
    _isolated_config.write_text(
        json.dumps({"openai": {"api_key": "x"}}), encoding="utf-8"
    )
    os.chmod(_isolated_config, 0o644)
    llm_config.load_all_provider_configs()
    assert os.stat(_isolated_config).st_mode & 0o777 == 0o600


def test_no_temp_files_left_behind(_isolated_config):
    llm_config.save_provider_config("openai", {"api_key": "a"})
    leftovers = [p.name for p in _isolated_config.parent.iterdir() if ".tmp" in p.name]
    assert leftovers == []


def test_corrupt_file_is_moved_aside_rather_than_raising(_isolated_config):
    _isolated_config.write_text("{ this is not json", encoding="utf-8")

    # Used to raise JSONDecodeError out of every endpoint touching provider
    # config, leaving the app permanently stuck.
    assert llm_config.load_all_provider_configs() == {}

    backup = _isolated_config.with_suffix(_isolated_config.suffix + ".corrupt")
    assert backup.exists(), "the unreadable file must be preserved for recovery"
    assert backup.read_text("utf-8") == "{ this is not json"


def test_non_object_json_is_ignored(_isolated_config):
    _isolated_config.write_text(json.dumps(["not", "an", "object"]), encoding="utf-8")
    assert llm_config.load_all_provider_configs() == {}


def test_concurrent_saves_do_not_lose_updates(_isolated_config):
    """Read-modify-write from several threads must not drop providers.

    uvicorn runs sync endpoints on a thread pool, so `/providers/config/{p}`
    calls really can interleave here.
    """
    names = [f"provider{i}" for i in range(24)]
    barrier = threading.Barrier(len(names))

    def _save(name: str) -> None:
        barrier.wait()
        llm_config.save_provider_config(name, {"api_key": f"key-{name}"})

    threads = [threading.Thread(target=_save, args=(n,)) for n in names]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sorted(llm_config.list_provider_configs()) == sorted(names)
