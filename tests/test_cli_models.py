"""A coding-agent CLI's phase dropdown lists the models the CLI can call.

The catalogue had nothing for OpenCode, pi, Antigravity or Gemini CLI, so a
phase run by one of them offered only the model it already had. Each CLI is
asked for its own list (``opencode models``, ``pi --list-models``,
``agy models``); Gemini CLI takes the Google catalogue's Gemini ids. No CLI
and no network are used here.
"""

import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

import cli_models  # noqa: E402
import provider_models_catalog  # noqa: E402

OPENCODE_OUTPUT = """anthropic/claude-opus-5-5
anthropic/claude-sonnet-5-5
github-copilot/claude-opus-4.8
openai/gpt-5.5
openrouter/anthropic/claude-sonnet-5.5
anthropic/claude-opus-5-5

--version
not a model id because spaces
"""

PI_OUTPUT = """provider   model               context  max-out  thinking  images
anthropic  claude-opus-5-5     1M       128K     yes       yes
openai     gpt-5.5             400K     128K     yes       yes
google     gemini-3.1-pro      1M       64K      yes       yes
"""


def _tier(_: str) -> str:
    return "standard"


def _no_google() -> list[dict]:
    return []


def test_opencode_lines_become_ids_once_each():
    assert cli_models.parse_opencode(OPENCODE_OUTPUT) == [
        "anthropic/claude-opus-5-5",
        "anthropic/claude-sonnet-5-5",
        "github-copilot/claude-opus-4.8",
        "openai/gpt-5.5",
        "openrouter/anthropic/claude-sonnet-5.5",
    ]


def test_pi_table_columns_become_provider_model_ids():
    assert cli_models.parse_pi(PI_OUTPUT) == [
        "anthropic/claude-opus-5-5",
        "openai/gpt-5.5",
        "google/gemini-3.1-pro",
    ]


def test_slugs_skip_headers_options_and_repeats():
    output = "MODEL  DESCRIPTION\ngemini-3.1-pro  Best\n-x\ngemini-3.1-pro\nclaude-sonnet-5-5\n"
    assert cli_models.parse_slugs(output) == ["gemini-3.1-pro", "claude-sonnet-5-5"]


def test_an_id_that_could_alter_a_command_line_is_dropped():
    output = 'anthropic/x"&calc\nanthropic/ok\nanthropic/a b\n'
    assert cli_models.parse_opencode(output) == ["anthropic/ok"]


def test_the_cli_list_starts_with_the_cli_default(monkeypatch):
    monkeypatch.setattr(
        "foundation.platform.find_executable", lambda name: f"/bin/{name}"
    )
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=OPENCODE_OUTPUT, stderr="")

    monkeypatch.setattr(cli_models.subprocess, "run", fake_run)
    monkeypatch.setattr(
        cli_models,
        "_registry_names",
        lambda: {
            "anthropic/claude-opus-5-5": {"name": "Claude Opus 5.5", "reasoning": True}
        },
    )

    models = cli_models.list_cli_models(
        "opencode", tier_for=_tier, google_models=_no_google
    )

    assert calls == [["/bin/opencode", "models"]]
    assert models[0]["value"] == "default"
    assert models[1] == {
        "value": "anthropic/claude-opus-5-5",
        "label": "Claude Opus 5.5 (anthropic)",
        "tier": "standard",
        "supportsThinking": True,
    }
    assert [m["value"] for m in models[1:]] == cli_models.parse_opencode(
        OPENCODE_OUTPUT
    )


@pytest.mark.parametrize(
    "outcome",
    [
        subprocess.CompletedProcess([], 1, stdout=OPENCODE_OUTPUT, stderr="boom"),
        subprocess.TimeoutExpired("opencode", 15),
        OSError("not executable"),
    ],
)
def test_a_cli_that_cannot_answer_gives_nothing(monkeypatch, outcome):
    monkeypatch.setattr(
        "foundation.platform.find_executable", lambda name: f"/bin/{name}"
    )

    def fake_run(argv, **kwargs):
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(cli_models.subprocess, "run", fake_run)

    assert (
        cli_models.list_cli_models("opencode", tier_for=_tier, google_models=_no_google)
        == []
    )


def test_a_missing_cli_is_not_run(monkeypatch):
    monkeypatch.setattr("foundation.platform.find_executable", lambda name: None)
    monkeypatch.setattr(
        cli_models.subprocess,
        "run",
        lambda *a, **k: pytest.fail("a missing CLI must not be started"),
    )

    assert (
        cli_models.list_cli_models("pi", tier_for=_tier, google_models=_no_google) == []
    )


def test_an_unknown_provider_lists_nothing():
    assert (
        cli_models.list_cli_models("nope", tier_for=_tier, google_models=_no_google)
        == []
    )


def test_gemini_cli_offers_the_google_gemini_models():
    google = [
        {
            "value": "models/gemini-3.1-pro",
            "label": "Gemini 3.1 Pro",
            "tier": "flagship",
        },
        {"value": "gemini-3-flash", "label": "Gemini 3 Flash", "tier": "fast"},
        {"value": "imagen-4", "label": "Imagen 4", "tier": "standard"},
        {"label": "no value"},
    ]

    models = cli_models.list_cli_models(
        "gemini-cli", tier_for=_tier, google_models=lambda: google
    )

    assert [m["value"] for m in models] == [
        "default",
        "gemini-3.1-pro",
        "gemini-3-flash",
    ]
    assert (
        cli_models.list_cli_models(
            "gemini-cli", tier_for=_tier, google_models=_no_google
        )
        == []
    )


def test_registry_names_key_records_by_the_cli_provider_id(monkeypatch):
    import public_model_registry

    def models_for(provider):
        if provider == "grok":
            return [{"id": "grok-4.3", "name": "Grok 4.3"}], 1.0
        return None

    monkeypatch.setattr(public_model_registry, "models_for", models_for)

    records = cli_models._registry_names()

    assert records["xai/grok-4.3"]["name"] == "Grok 4.3"
    assert records["grok/grok-4.3"]["name"] == "Grok 4.3"
    assert cli_models._label("xai/grok-4.3", records) == "Grok 4.3 (xai)"
    assert cli_models._label("xai/unknown", records) == "xai/unknown"


def test_the_catalogue_serves_the_cli_list_live(monkeypatch):
    listed = [cli_models.default_entry("opencode"), {"value": "openai/gpt-5.5"}]
    monkeypatch.setattr(
        provider_models_catalog._cli_models,
        "list_cli_models",
        lambda provider, **kwargs: listed,
    )

    answer = provider_models_catalog.list_models("opencode")

    assert answer["source"] == "live"
    assert answer["models"] == listed


@pytest.mark.parametrize("failure", [None, OSError("gone")])
def test_the_catalogue_falls_back_when_the_cli_gives_nothing(monkeypatch, failure):
    def list_cli_models(provider, **kwargs):
        if failure:
            raise failure
        return []

    monkeypatch.setattr(
        provider_models_catalog._cli_models, "list_cli_models", list_cli_models
    )

    answer = provider_models_catalog.list_models("antigravity")

    assert answer["source"] == "static"
    assert answer["error"] is None


def test_gemini_cli_reads_the_google_catalogue(monkeypatch):
    seen = []
    real_list = provider_models_catalog.list_models

    def fake_list(provider, *, force_refresh=False):
        if provider == "google":
            seen.append(force_refresh)
            return {"models": [{"value": "gemini-3.1-pro", "label": "Gemini 3.1 Pro"}]}
        return real_list(provider, force_refresh=force_refresh)

    monkeypatch.setattr(provider_models_catalog, "list_models", fake_list)

    answer = real_list("gemini-cli", force_refresh=True)

    assert seen == [True]
    assert [m["value"] for m in answer["models"]] == ["default", "gemini-3.1-pro"]
