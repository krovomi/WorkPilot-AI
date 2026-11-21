"""Design-to-code calls only the provider the person chose, and respects strict offline.

Every network call of the pipeline goes through httpx, replaced here by a mock
transport that records each request: a refusal is proven by an empty record,
not by a mocked handler that was simply never reached. No real network.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from services.design_to_code_providers import (
    STRICT_OFFLINE_REFUSAL,
    UNREADABLE_POLICY_REFUSAL,
    CloudCallRefused,
    cloud_refusal,
    missing_credentials,
    normalize_provider,
    provider_key,
)
from services.design_to_code_service import DesignToCodeService

IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="
KEYS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY")


@pytest.fixture
def service(tmp_path: Path) -> DesignToCodeService:
    return DesignToCodeService(str(tmp_path))


@pytest.fixture
def strict(tmp_path: Path) -> Path:
    """The project is under strict offline mode."""
    policy = tmp_path / ".workpilot" / "offline-mode.json"
    policy.parent.mkdir(parents=True)
    policy.write_text(json.dumps({"airgapStrict": True}), encoding="utf-8")
    return policy


@pytest.fixture(autouse=True)
def no_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (*KEYS, "OLLAMA_BASE_URL", "OLLAMA_MODEL", "LOCAL_LLM_MODEL"):
        monkeypatch.delenv(key, raising=False)


@pytest.fixture
def select(monkeypatch: pytest.MonkeyPatch):
    """Set the provider selected for the run, and whether somebody chose it."""

    def _select(provider: str, chosen: bool = True) -> None:
        monkeypatch.setattr(
            "core.client._resolve_active_provider",
            lambda spec_dir=None: (provider, chosen),
        )

    return _select


@pytest.fixture
def network(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Every httpx request the pipeline sends, answered by a mock transport."""
    state: dict = {"sent": [], "status": 200}
    real = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        state["sent"].append(request)
        if state["status"] != 200:
            return httpx.Response(state["status"], json={"error": "refused"})
        host = request.url.host
        if host == "api.anthropic.com":
            return httpx.Response(200, json={"content": [{"text": "from-claude"}]})
        if host == "generativelanguage.googleapis.com":
            return httpx.Response(
                200,
                json={
                    "candidates": [{"content": {"parts": [{"text": "from-gemini"}]}}]
                },
            )
        return httpx.Response(
            200, json={"choices": [{"message": {"content": f"from-{host}"}}]}
        )

    def client(*args, **kwargs):
        return real(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client)
    return state


@pytest.fixture
def oneshot(monkeypatch: pytest.MonkeyPatch) -> dict:
    """The one-shot trunk gives nothing, so the direct fallback is reached."""
    state: dict = {"error": None}

    async def fake(prompt, **kwargs):
        if state["error"]:
            raise state["error"]
        return ""

    monkeypatch.setattr("core.oneshot.oneshot_completion", fake)
    return state


# --- the policy and the keys ----------------------------------------------------


def test_cloud_calls_are_allowed_without_a_strict_policy(tmp_path: Path) -> None:
    assert cloud_refusal(tmp_path) is None


def test_strict_offline_refuses_the_cloud_with_a_fixed_message(
    tmp_path: Path, strict: Path
) -> None:
    assert cloud_refusal(tmp_path) == STRICT_OFFLINE_REFUSAL


def test_an_unreadable_policy_counts_as_strict(tmp_path: Path, strict: Path) -> None:
    strict.write_text("{not json", encoding="utf-8")
    assert cloud_refusal(tmp_path) == UNREADABLE_POLICY_REFUSAL


def test_provider_names_have_one_spelling() -> None:
    assert normalize_provider(" Anthropic ") == "claude"
    assert normalize_provider("gemini") == "google"
    assert normalize_provider(None) == ""


def test_a_provider_reads_only_its_own_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-0000")  # pragma: allowlist secret
    monkeypatch.setenv("GEMINI_API_KEY", "gm-test-0000")  # pragma: allowlist secret
    assert provider_key("openai") is None
    assert provider_key("copilot") is None
    assert provider_key("google") == "gm-test-0000"  # pragma: allowlist secret


def test_a_missing_key_names_the_chosen_provider() -> None:
    assert "OPENAI_API_KEY" in missing_credentials("openai", "vision analysis")
    assert "OpenAI, the provider selected" in missing_credentials("openai", "x")
    assert "sign in to Claude Code" in missing_credentials("claude", "x")
    assert "no direct call for copilot" in missing_credentials("copilot", "x")
    assert "this provider" in missing_credentials("", "x")


# --- vision ---------------------------------------------------------------------


async def test_strict_offline_makes_no_cloud_vision_call(
    service, strict, select, network, monkeypatch
) -> None:
    select("claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-0000")  # pragma: allowlist secret

    with pytest.raises(CloudCallRefused, match="Strict offline mode"):
        await service._call_vision_ai(IMAGE, "describe")

    assert network["sent"] == []


async def test_strict_offline_fails_the_pipeline_with_the_fixed_message(
    service, strict, select, network, monkeypatch
) -> None:
    select("openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-0000")  # pragma: allowlist secret

    result = await service.run_pipeline(image_data=IMAGE)

    assert result.success is False
    assert result.errors == [STRICT_OFFLINE_REFUSAL]
    assert network["sent"] == []


@pytest.mark.parametrize(
    "handler", ["_call_claude_vision", "_call_openai_vision", "_call_gemini_vision"]
)
async def test_each_cloud_vision_call_checks_strict_offline(
    service, strict, network, handler
) -> None:
    with pytest.raises(CloudCallRefused):
        await getattr(service, handler)("sk-test-0000", IMAGE, "describe")

    assert network["sent"] == []


async def test_strict_offline_calls_the_local_model_on_loopback(
    service, strict, select, network, monkeypatch
) -> None:
    select("ollama")
    monkeypatch.setenv("OLLAMA_MODEL", "llava")

    answer = await service._call_vision_ai(IMAGE, "describe")

    assert answer == "from-127.0.0.1"
    [request] = network["sent"]
    assert str(request.url) == "http://127.0.0.1:11434/v1/chat/completions"
    body = json.loads(request.content)
    assert body["model"] == "llava"
    assert body["messages"][0]["content"][1]["image_url"]["url"] == IMAGE


async def test_a_local_model_off_loopback_is_not_called(
    service, strict, select, network, monkeypatch
) -> None:
    select("ollama")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://models.example.test:11434")

    with pytest.raises(RuntimeError, match="loopback"):
        await service._call_vision_ai(IMAGE, "describe")

    assert network["sent"] == []


async def test_a_missing_key_never_falls_back_to_another_provider(
    service, select, network, monkeypatch
) -> None:
    select("openai")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-0000")  # pragma: allowlist secret
    monkeypatch.setenv("GOOGLE_API_KEY", "gm-test-0000")  # pragma: allowlist secret

    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        await service._call_vision_ai(IMAGE, "describe")

    assert network["sent"] == []


async def test_a_provider_without_vision_does_not_borrow_another_key(
    service, select, network, monkeypatch
) -> None:
    select("copilot")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-0000")  # pragma: allowlist secret

    with pytest.raises(RuntimeError, match="copilot"):
        await service._call_vision_ai(IMAGE, "describe")

    assert network["sent"] == []


async def test_claude_without_a_key_uses_the_claude_sign_in(
    service, select, network, monkeypatch
) -> None:
    import services.design_to_code_service as module

    select("claude")
    monkeypatch.setattr(module, "_claude_signed_in", lambda: True)

    async def subscription(self, image_data, prompt):
        return "from-subscription"

    monkeypatch.setattr(
        DesignToCodeService, "_call_claude_subscription_vision", subscription
    )

    assert await service._call_vision_ai(IMAGE, "describe") == "from-subscription"
    assert network["sent"] == []


async def test_claude_without_key_or_sign_in_is_an_error_naming_claude(
    service, select, network, monkeypatch
) -> None:
    import services.design_to_code_service as module

    select("anthropic")
    monkeypatch.setattr(module, "_claude_signed_in", lambda: False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-0000")  # pragma: allowlist secret

    with pytest.raises(RuntimeError, match="needs Claude"):
        await service._call_vision_ai(IMAGE, "describe")

    assert network["sent"] == []


async def test_the_chosen_provider_is_called_with_its_own_key(
    service, select, network, monkeypatch
) -> None:
    select("gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "gm-test-0000")  # pragma: allowlist secret
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-0000")  # pragma: allowlist secret

    assert await service._call_vision_ai(IMAGE, "describe") == "from-gemini"

    [request] = network["sent"]
    assert request.url.host == "generativelanguage.googleapis.com"
    assert (
        request.headers["x-goog-api-key"] == "gm-test-0000"
    )  # pragma: allowlist secret
    assert "gm-test-0000" not in str(request.url)


async def test_a_failing_vision_call_is_reported(
    service, select, network, monkeypatch
) -> None:
    select("openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-0000")  # pragma: allowlist secret
    network["status"] = 500

    with pytest.raises(RuntimeError, match="Vision AI analysis failed"):
        await service._call_vision_ai(IMAGE, "describe")

    assert [r.url.host for r in network["sent"]] == ["api.openai.com"]


async def test_nothing_configured_and_nothing_chosen_is_simulated(
    service, select, network, monkeypatch
) -> None:
    import services.design_to_code_service as module

    select("claude", chosen=False)
    monkeypatch.setattr(module, "_claude_signed_in", lambda: False)

    answer = await service._call_vision_ai(IMAGE, "describe")

    assert answer == service._mock_vision_analysis()
    assert service._simulated is True
    assert network["sent"] == []


# --- code generation ------------------------------------------------------------


async def test_strict_offline_makes_no_cloud_code_generation_call(
    service, strict, select, network, oneshot, monkeypatch
) -> None:
    select("claude", chosen=False)
    oneshot["error"] = ValueError("local model unavailable")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-0000")  # pragma: allowlist secret

    with pytest.raises(CloudCallRefused, match="Strict offline mode"):
        await service._call_code_generation_ai("generate")

    assert network["sent"] == []


@pytest.mark.parametrize("method", ["_generate_with_claude", "_generate_with_openai"])
async def test_each_direct_code_generation_call_checks_strict_offline(
    service, strict, network, method
) -> None:
    with pytest.raises(CloudCallRefused):
        await getattr(service, method)("sk-test-0000", "generate")

    assert network["sent"] == []


async def test_code_generation_never_uses_another_provider_key(
    service, select, network, oneshot, monkeypatch
) -> None:
    select("openai")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-0000")  # pragma: allowlist secret

    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        await service._call_code_generation_ai("generate")

    assert network["sent"] == []


@pytest.mark.parametrize(
    ("provider", "key", "host", "answer"),
    [
        ("claude", "ANTHROPIC_API_KEY", "api.anthropic.com", "from-claude"),
        ("openai", "OPENAI_API_KEY", "api.openai.com", "from-api.openai.com"),
    ],
)
async def test_code_generation_falls_back_to_the_chosen_provider_only(
    service, select, network, oneshot, monkeypatch, provider, key, host, answer
) -> None:
    select(provider)
    for variable in KEYS:
        monkeypatch.setenv(variable, "sk-test-0000")  # pragma: allowlist secret

    assert await service._call_code_generation_ai("generate") == answer
    assert [r.url.host for r in network["sent"]] == [host]


async def test_a_failing_direct_code_generation_call_is_reported(
    service, select, network, oneshot, monkeypatch
) -> None:
    select("claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-0000")  # pragma: allowlist secret
    network["status"] = 500

    with pytest.raises(RuntimeError, match="Code generation failed"):
        await service._call_code_generation_ai("generate")


async def test_a_local_model_that_returns_nothing_is_not_replaced(
    service, select, network, oneshot, monkeypatch
) -> None:
    select("ollama")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-0000")  # pragma: allowlist secret

    with pytest.raises(RuntimeError, match="local model selected"):
        await service._call_code_generation_ai("generate")

    assert network["sent"] == []


async def test_code_generation_with_nothing_configured_is_simulated(
    service, select, network, oneshot
) -> None:
    select("claude", chosen=False)

    answer = await service._call_code_generation_ai("generate")

    assert answer == service._mock_code_generation()
    assert service._simulated is True
    assert network["sent"] == []


# --- Figma ----------------------------------------------------------------------


async def test_strict_offline_skips_the_figma_sync(
    service, strict, network, monkeypatch
) -> None:
    monkeypatch.setenv(
        "FIGMA_ACCESS_TOKEN", "figd-test-0000"
    )  # pragma: allowlist secret

    status = await service._sync_figma("AbC123xyz", None, [])

    assert status == {"status": "skipped", "reason": STRICT_OFFLINE_REFUSAL}
    assert network["sent"] == []


async def test_the_figma_sync_still_runs_outside_strict_offline(
    service, monkeypatch
) -> None:
    monkeypatch.delenv("FIGMA_ACCESS_TOKEN", raising=False)

    status = await service._sync_figma("AbC123xyz", None, [])

    assert status == {"status": "skipped", "reason": "No FIGMA_ACCESS_TOKEN set"}
