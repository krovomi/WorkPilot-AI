"""Copilot's model list is this account's, not every model GitHub released.

The Arena offered Copilot models from the public registry; one the account
does not get answered ``400 model_not_supported``. ``copilot_models`` asks
``api.githubcopilot.com/models`` with the account's own token. No network.
"""

import sys
from pathlib import Path

import httpx
import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

import copilot_models  # noqa: E402

MODELS = [
    {
        "id": "gpt-4.1",
        "name": "GPT-4.1",
        "model_picker_enabled": True,
        "capabilities": {"type": "chat", "supports": {"tool_calls": True}},
        "policy": {"state": "enabled"},
    },
    {
        "id": "claude-sonnet-4.5",
        "name": "Claude Sonnet 4.5",
        "model_picker_enabled": True,
        "capabilities": {"type": "chat", "supports": {"thinking": True}},
    },
    # Turned off by the organisation's policy.
    {
        "id": "claude-opus-4.8",
        "name": "Claude Opus 4.8",
        "model_picker_enabled": True,
        "capabilities": {"type": "chat"},
        "policy": {"state": "disabled"},
    },
    # Routable but hidden from every picker.
    {
        "id": "gpt-4o-2024-05-13",
        "name": "GPT-4o",
        "model_picker_enabled": False,
        "capabilities": {"type": "chat"},
    },
    {
        "id": "text-embedding-3-small",
        "name": "Embedding V3 small",
        "capabilities": {"type": "embeddings"},
    },
]


def test_only_usable_chat_models_are_kept():
    ids = [entry["id"] for entry in copilot_models.usable_chat_models(MODELS)]

    assert ids == ["gpt-4.1", "claude-sonnet-4.5"]
    assert copilot_models.is_served("gpt-4.1", MODELS)
    assert not copilot_models.is_served("claude-opus-4.8", MODELS)
    assert copilot_models.usable_chat_models(None) == []


def _serve(monkeypatch, exchange_status: int):
    seen: list[tuple[str, str]] = []

    def get(url, headers=None, timeout=None):
        seen.append((url, headers["Authorization"]))
        request = httpx.Request("GET", url)
        if url == copilot_models.TOKEN_EXCHANGE_URL:
            if exchange_status == 200:
                return httpx.Response(
                    200, json={"token": "tid=session"}, request=request
                )
            return httpx.Response(exchange_status, text="Forbidden", request=request)
        return httpx.Response(200, json={"data": MODELS}, request=request)

    monkeypatch.setenv("GITHUB_TOKEN", "gho_example")
    monkeypatch.setattr(copilot_models.httpx, "get", get)
    return seen


@pytest.mark.parametrize(
    ("exchange_status", "bearer"),
    [(200, "Bearer tid=session"), (403, "Bearer gho_example")],
)
def test_the_catalog_asks_with_the_token_the_chat_uses(
    monkeypatch, exchange_status, bearer
):
    seen = _serve(monkeypatch, exchange_status)

    catalog = copilot_models.fetch_catalog()

    assert seen == [
        (copilot_models.TOKEN_EXCHANGE_URL, "token gho_example"),
        (copilot_models.MODELS_URL, bearer),
    ]
    assert catalog == [
        {"value": "gpt-4.1", "label": "GPT-4.1", "supportsThinking": False},
        {
            "value": "claude-sonnet-4.5",
            "label": "Claude Sonnet 4.5",
            "supportsThinking": True,
        },
    ]


def test_no_github_login_means_no_list(monkeypatch):
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setenv("GITHUB_CLI_PATH", "")
    import shutil

    monkeypatch.setattr(shutil, "which", lambda _: None)

    assert copilot_models.fetch_catalog() == []


def test_the_catalog_serves_copilot_live(monkeypatch, tmp_path):
    import provider_models_catalog as catalog

    _serve(monkeypatch, 403)
    monkeypatch.setattr(catalog, "CACHE_PATH", tmp_path / "catalog.json")

    result = catalog.list_models("copilot", force_refresh=True)

    assert result["source"] == "live"
    assert [m["value"] for m in result["models"]] == ["gpt-4.1", "claude-sonnet-4.5"]
    assert all("tier" in m for m in result["models"])
