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


def test_an_old_active_provider_marker_is_hidden_from_the_listing(_isolated_config):
    _isolated_config.write_text(
        json.dumps({"openai": {"api_key": "a"}, "__active_provider__": "openai"}),
        encoding="utf-8",
    )
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


def test_a_failed_write_leaves_the_old_file_and_no_temp_copy(
    _isolated_config, monkeypatch
):
    llm_config.save_provider_config("openai", {"api_key": "a"})

    def disk_full(*_args):
        raise OSError("No space left on device")

    monkeypatch.setattr(llm_config.os, "replace", disk_full)
    with pytest.raises(OSError, match="No space left"):
        llm_config.save_provider_config("anthropic", {"api_key": "b"})

    assert json.loads(_isolated_config.read_text("utf-8")) == {
        "openai": {"api_key": "a"}
    }
    leftovers = [p.name for p in _isolated_config.parent.iterdir() if ".tmp" in p.name]
    assert leftovers == []


def test_a_temp_file_already_gone_does_not_hide_the_error(
    _isolated_config, monkeypatch
):
    real_unlink = os.unlink

    def replace_after_removing(src, _dst):
        real_unlink(src)
        raise OSError("rename refused")

    monkeypatch.setattr(llm_config.os, "replace", replace_after_removing)
    with pytest.raises(OSError, match="rename refused"):
        llm_config.save_provider_config("openai", {"api_key": "a"})


def test_permissions_are_left_alone_on_windows(_isolated_config, monkeypatch):
    _isolated_config.write_text(json.dumps({"x": {}}), encoding="utf-8")
    monkeypatch.setattr(llm_config, "is_windows", lambda: True)
    monkeypatch.setattr(
        llm_config.os,
        "chmod",
        lambda *_a: pytest.fail("chmod must not run on Windows"),
    )

    assert llm_config.load_all_provider_configs() == {"x": {}}


def test_a_file_whose_mode_cannot_be_changed_is_still_loaded(
    _isolated_config, monkeypatch
):
    previous = os.umask(0o027)  # the file is born group-readable
    try:
        _isolated_config.write_text(json.dumps({"x": {}}), encoding="utf-8")
    finally:
        os.umask(previous)
    monkeypatch.setattr(llm_config, "is_windows", lambda: False)
    refused = []

    def no_chmod(*args, **_k):
        refused.append(args)
        raise PermissionError("chmod refused")

    monkeypatch.setattr(llm_config.os, "chmod", no_chmod)

    assert llm_config.load_all_provider_configs() == {"x": {}}
    assert refused, "the loader must have tried to tighten the file"


def test_a_corrupt_file_that_cannot_be_moved_is_still_ignored(
    _isolated_config, monkeypatch, caplog
):
    _isolated_config.write_text("{ broken", encoding="utf-8")

    def refuse(*_a):
        raise OSError("read-only")

    monkeypatch.setattr(llm_config.os, "replace", refuse)

    assert llm_config.load_all_provider_configs() == {}
    assert "could not be moved aside" in caplog.text
    assert _isolated_config.exists()


def test_delete_of_an_unknown_provider_does_not_rewrite(_isolated_config):
    llm_config.save_provider_config("openai", {"api_key": "a"})
    before = _isolated_config.stat().st_mtime_ns

    llm_config.delete_provider_config("mistral")

    assert _isolated_config.stat().st_mtime_ns == before


class TestProviderConfig:
    def test_a_saved_config_wins_and_keeps_its_extra_fields(self, _isolated_config):
        llm_config.save_provider_config(
            "openai",
            {
                "api_key": "sk-o",
                "model": "gpt-5",
                "base_url": "https://api.example",
                "organization": "org-1",
            },
        )

        config = llm_config.ProviderConfig.load_provider_config(
            "coding", "/spec", "openai"
        )

        assert (config.provider, config.model, config.api_key, config.base_url) == (
            "openai",
            "gpt-5",
            "sk-o",
            "https://api.example",
        )
        assert config.organization == "org-1"
        assert config.is_claude_sdk is False

    def test_the_cli_model_beats_the_saved_one(self, _isolated_config):
        llm_config.save_provider_config("openai", {"model": "gpt-5"})

        config = llm_config.ProviderConfig.load_provider_config(
            "coding", "/spec", "openai", "gpt-5-mini"
        )

        assert config.model == "gpt-5-mini"

    def test_anthropic_uses_a_system_api_key(self, _isolated_config, monkeypatch):
        monkeypatch.setattr(llm_config, "get_auth_token", lambda: "sk-ant-api")

        config = llm_config.ProviderConfig.load_provider_config("coding", "/spec")

        assert (config.provider, config.model, config.api_key) == (
            "anthropic",
            llm_config.DEFAULT_CLAUDE_MODEL,
            "sk-ant-api",
        )

    def test_an_oauth_token_is_not_used_as_an_api_key(
        self, _isolated_config, monkeypatch
    ):
        monkeypatch.setattr(llm_config, "get_auth_token", lambda: "oauth-token")

        config = llm_config.ProviderConfig.load_provider_config(
            "coding", "/spec", "claude"
        )

        assert config.api_key is None
        assert config.is_claude_sdk is True

    def test_other_providers_get_no_key(self, _isolated_config, monkeypatch):
        monkeypatch.setattr(
            llm_config, "get_auth_token", lambda: pytest.fail("not for ollama")
        )

        config = llm_config.ProviderConfig.load_provider_config(
            "coding", "/spec", "ollama", "llama4"
        )

        assert (config.provider, config.model, config.api_key) == (
            "ollama",
            "llama4",
            None,
        )


class TestClaudeTokenFromSystem:
    def test_only_an_api_key_is_returned(self, monkeypatch):
        monkeypatch.setattr(llm_config, "get_auth_token", lambda: "sk-ant-1")
        assert llm_config.get_claude_token_from_system() == "sk-ant-1"

        monkeypatch.setattr(llm_config, "get_auth_token", lambda: "oauth")
        assert llm_config.get_claude_token_from_system() is None

    def test_force_saves_the_claude_entry(self, _isolated_config, monkeypatch):
        monkeypatch.setattr(llm_config, "get_auth_token", lambda: "sk-ant-2")

        llm_config.force_claude_provider_config()

        assert llm_config.load_provider_config("claude") == {
            "api_key": "sk-ant-2",
            "model": llm_config.DEFAULT_CLAUDE_MODEL,
        }

    def test_force_without_a_key_writes_nothing(
        self, _isolated_config, monkeypatch, caplog
    ):
        monkeypatch.setattr(llm_config, "get_auth_token", lambda: None)

        llm_config.force_claude_provider_config()

        assert not _isolated_config.exists()
        assert "aucun token Claude valide" in caplog.text
