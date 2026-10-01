"""Codex account and configured OpenAI API models share a routed selector."""

import json
from unittest.mock import Mock

import codex_models
import provider_models_catalog as catalog
import pytest


@pytest.fixture(autouse=True)
def isolated_discovery(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    monkeypatch.setattr(codex_models, "_catalogs", {})
    monkeypatch.setattr(
        codex_models, "airgap_status", lambda *_: {"airgapStrict": False}
    )
    monkeypatch.setattr(
        codex_models, "_discover_models", Mock(side_effect=OSError("offline"))
    )


def test_discovery_cache_and_explicit_refresh(monkeypatch):
    discover = Mock(side_effect=[[{"value": "gpt-5.5"}], [{"value": "gpt-6-sol"}]])
    monkeypatch.setattr(codex_models, "_discover_models", discover)
    first = catalog.list_models("openai-codex")
    assert catalog.list_models("openai-codex") == first
    assert discover.call_count == 1
    assert catalog.list_models("openai-codex", force_refresh=True)["models"] == [
        {"value": "gpt-6-sol"}
    ]
    assert discover.call_count == 2


def test_changed_codex_home_does_not_reuse_other_account_models(monkeypatch, tmp_path):
    discover = Mock(side_effect=[[{"value": "account-a"}], [{"value": "account-b"}]])
    monkeypatch.setattr(codex_models, "_discover_models", discover)
    catalog.list_models("openai-codex")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "other"))
    assert catalog.list_models("openai-codex")["models"] == [{"value": "account-b"}]


def test_expired_catalog_is_discovered_again(monkeypatch):
    discover = Mock(return_value=[{"value": "gpt-6-sol"}])
    monkeypatch.setattr(codex_models, "_discover_models", discover)
    monkeypatch.setattr(codex_models.time, "monotonic", lambda: 100)
    catalog.list_models("openai-codex")
    monkeypatch.setattr(codex_models.time, "monotonic", lambda: 1001)
    catalog.list_models("openai-codex")
    assert discover.call_count == 2


def test_strict_offline_never_starts_codex(monkeypatch):
    discover = Mock()
    monkeypatch.setattr(codex_models, "_discover_models", discover)
    monkeypatch.setattr(
        codex_models, "airgap_status", lambda *_: {"airgapStrict": True}
    )
    assert catalog.list_models("openai-codex", force_refresh=True)["source"] == "static"
    discover.assert_not_called()


def test_refresh_discovers_new_models_instead_of_only_reading_disk(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    model = {"value": "gpt-6-sol", "label": "GPT-6 Sol", "tier": "flagship"}
    monkeypatch.setattr(
        codex_models, "_discover_models", lambda: [model], raising=False
    )
    result = catalog.list_models("openai-codex", force_refresh=True)
    assert result["models"] == [model]
    assert result["source"] == "live"
    assert result["fetchedAt"] is not None


def test_refresh_failure_reports_cache_fallback(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))

    def fail():
        raise TimeoutError("credential-shaped details must not be exposed")

    monkeypatch.setattr(codex_models, "_discover_models", fail, raising=False)
    result = catalog.list_models("openai-codex", force_refresh=True)
    assert result["source"] == "static"
    assert result["error"]
    assert "credential-shaped" not in result["error"]


def test_codex_catalog_combines_api_models_only_when_api_key_exists(
    monkeypatch, tmp_path
):
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

    monkeypatch.setattr(
        catalog,
        "_api_key_for",
        lambda provider: "secret" if provider == "openai" else None,
    )
    monkeypatch.setattr(
        catalog,
        "_FETCHERS",
        {
            **catalog._FETCHERS,
            "openai": lambda: [
                {"value": "gpt-4.1-mini", "label": "GPT-4.1 mini", "tier": "fast"},
                {"value": "gpt-5.4-mini", "label": "GPT-5.4 mini", "tier": "fast"},
                {"value": "gpt-5.5", "label": "API GPT-5.5", "tier": "standard"},
            ],
        },
    )
    combined = catalog.list_models("openai-codex", force_refresh=True)
    assert [m["value"] for m in combined["models"]] == [
        "gpt-5.5",
        "gpt-4.1-mini",
        "gpt-5.4-mini",
    ]
    assert combined["models"][0]["label"] == "GPT-5.5"


def test_codex_catalog_never_adds_api_models_without_api_key(monkeypatch):
    monkeypatch.setattr(catalog, "_api_key_for", lambda _: None)
    codex = {
        "provider": "openai-codex",
        "models": [{"value": "gpt-5.5"}],
        "source": "live",
        "fetchedAt": 1,
        "error": None,
    }
    monkeypatch.setattr(codex_models, "codex_model_catalog", lambda **_: codex)
    monkeypatch.setitem(
        catalog._FETCHERS, "openai", lambda: [{"value": "gpt-4.1-mini"}]
    )
    assert catalog.list_models("openai-codex")["models"] == [{"value": "gpt-5.5"}]


def test_codex_small_models_are_fast_and_keep_exact_id(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    small = {
        "value": "gpt-5.5-mini",
        "label": "GPT-5.5 mini",
        "tier": "fast",
        "supportsThinking": True,
    }
    monkeypatch.setattr(codex_models, "_discover_models", lambda: [small])

    result = catalog.list_models("openai-codex", force_refresh=True)

    assert result["models"] == [small]
    assert codex_models.resolve_codex_model("gpt-5.5-mini") == "gpt-5.5-mini"


def test_codex_cache_classifies_small_models_as_fast(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    (tmp_path / "models_cache.json").write_text(
        json.dumps(
            {
                "models": [
                    {
                        "slug": "gpt-5.5-mini",
                        "display_name": "GPT-5.5 mini",
                        "visibility": "list",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    result = codex_models._cached_catalog()

    assert result["models"][0]["value"] == "gpt-5.5-mini"
    assert result["models"][0]["tier"] == "fast"


def test_codex_missing_cache_has_no_api_only_fallback(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    result = catalog.list_models("openai-codex")
    assert [m["value"] for m in result["models"]] == ["gpt-5.5"]
    assert result["source"] == "static"


def test_legacy_mini_is_repaired_only_for_codex():
    assert codex_models.resolve_codex_model("gpt-5.5-mini") == "gpt-5.5-mini"
    assert codex_models.resolve_codex_model("gpt-5.5") == "gpt-5.5"
    assert codex_models.resolve_codex_model("future-custom-id") == "future-custom-id"


def test_corrupt_codex_cache_stays_separate_from_api(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    (tmp_path / "models_cache.json").write_text("not json", encoding="utf-8")
    result = catalog.list_models("openai-codex")
    assert [m["value"] for m in result["models"]] == ["gpt-5.5"]


def test_cli_replacement_invalidates_inventory_without_manual_refresh(
    monkeypatch, tmp_path
):
    executable = tmp_path / "codex"
    executable.write_text("old-cli", encoding="utf-8")
    monkeypatch.setattr(
        codex_models, "find_executable", lambda _: str(executable), raising=False
    )
    discover = Mock(
        side_effect=[[{"value": "gpt-5.6-sol"}], [{"value": "gpt-6.1-sol"}]]
    )
    monkeypatch.setattr(codex_models, "_discover_models", discover)
    catalog.list_models("openai-codex")
    executable.write_text("updated-cli-with-new-models", encoding="utf-8")
    assert catalog.list_models("openai-codex")["models"] == [{"value": "gpt-6.1-sol"}]
    assert discover.call_count == 2
