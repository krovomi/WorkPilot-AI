"""Explicit local phase choices take precedence over offline defaults."""

import json

import pytest


@pytest.fixture
def local_policy(tmp_path, monkeypatch):
    from core import local_model_catalog

    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    monkeypatch.setattr(
        local_model_catalog,
        "detect_runtime",
        lambda _: {
            "available": True,
            "models": [{"name": "qwen2.5-coder:7b"}, {"name": "qwen3-coder:30b"}],
        },
    )

    def write(strict, phase):
        directory = tmp_path / ".workpilot"
        directory.mkdir(exist_ok=True)
        (directory / "offline-mode.json").write_text(
            json.dumps(
                {
                    "airgapStrict": strict,
                    "defaultProvider": "ollama",
                    "routing": {
                        phase: {"provider": "ollama", "model": "qwen2.5-coder:7b"}
                    },
                }
            ),
            encoding="utf-8",
        )
        return tmp_path

    return write


@pytest.mark.parametrize(
    "strict,route_phase",
    [(True, "coder"), (True, "spec_writer"), (False, "spec_writer")],
)
def test_selected_local_model_wins_over_offline_route(
    local_policy, strict, route_phase
):
    from core.offline_policy import resolve_offline_route

    root = local_policy(strict, route_phase)
    assert resolve_offline_route(
        root, root, "spec_writer", "ollama", "qwen3-coder:30b"
    ) == (
        "ollama",
        "qwen3-coder:30b",
        "http://127.0.0.1:11434",
    )


@pytest.mark.parametrize("model", ["missing:30b", "qwen3-embedding:8b"])
def test_invalid_selection_fails_instead_of_switching_models(local_policy, model):
    from core.offline_policy import resolve_offline_route

    root = local_policy(True, "spec_writer")
    with pytest.raises(ValueError):
        resolve_offline_route(root, root, "spec_writer", "ollama", model)


def test_spec_factory_preserves_selected_model(local_policy, monkeypatch):
    import core.client

    root = local_policy(True, "coder")
    monkeypatch.setattr(core.client, "_log_llm_context_switch", lambda *a, **kw: None)
    client = core.client.create_agent_client(
        project_dir=root,
        spec_dir=root,
        agent_type="spec_writer",
        provider="ollama",
        model="qwen3-coder:30b",
        system_prompt="Test",
        max_thinking_tokens=None,
    )
    assert client.model == "qwen3-coder:30b"
    assert client._offline_only is True
