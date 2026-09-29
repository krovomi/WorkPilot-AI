"""Codex account models must not be mixed with the OpenAI API catalog."""

import json

import provider_models_catalog as catalog


def test_codex_catalog_uses_cli_inventory(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    (tmp_path / "models_cache.json").write_text(
        json.dumps(
            {
                "models": [
                    {
                        "slug": "gpt-5.5",
                        "display_name": "GPT-5.5",
                        "visibility": "list",
                    },
                    {"slug": "hidden-reviewer", "visibility": "hide"},
                ]
            }
        ),
        encoding="utf-8",
    )
    result = catalog.list_models("openai-codex")
    assert [m["value"] for m in result["models"]] == ["gpt-5.5"]
    assert result["source"] == "cache"


def test_codex_missing_cache_has_no_api_only_fallback(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    result = catalog.list_models("openai-codex")
    assert [m["value"] for m in result["models"]] == ["gpt-5.5"]
    assert result["source"] == "static"


def test_legacy_mini_is_repaired_only_for_codex():
    from codex_models import resolve_codex_model

    assert resolve_codex_model("gpt-5.5-mini") == "gpt-5.5"
    assert resolve_codex_model("gpt-5.5") == "gpt-5.5"
    assert resolve_codex_model("future-custom-id") == "future-custom-id"


def test_corrupt_codex_cache_stays_separate_from_api(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    (tmp_path / "models_cache.json").write_text("not json", encoding="utf-8")
    result = catalog.list_models("openai-codex")
    assert [m["value"] for m in result["models"]] == ["gpt-5.5"]
