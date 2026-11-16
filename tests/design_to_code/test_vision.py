"""Which model may look at the pictures, and the catalogue's say in it."""

from __future__ import annotations

import pytest
from design_to_code.vision import Credentials, decide_route
from models_registry import REGISTRY, vision_support

MODELS = {
    "claude_api": "api-vision-model",
    "claude_subscription": "subscription-vision-model",
    "openai": "",
    "google": "",
    "ollama": "local-vision-model",
}
#: Read from the catalogue rather than named here.
TEXT_ONLY = next(
    e.model_id
    for e in REGISTRY
    if e.provider == "ollama" and e.supports_vision is False
)
UNRECORDED = next(
    e.model_id for e in REGISTRY if e.provider == "ollama" and e.supports_vision is None
)


def _route(provider, *, strict=False, models=MODELS, **creds):
    return decide_route(
        provider, airgap_strict=strict, credentials=Credentials(**creds), models=models
    )


@pytest.mark.parametrize(
    ("provider", "creds", "route"),
    [
        ("", {"anthropic_key": True}, "claude_api"),
        ("anthropic", {"claude_signed_in": True}, "claude_subscription"),
        ("copilot", {"openai_key": True}, "openai"),
        ("gemini", {"google_key": True}, "google"),
        ("ollama", {}, "ollama"),
    ],
)
def test_each_provider_takes_its_own_route(provider, creds, route) -> None:
    decided = _route(provider, **creds)
    assert decided.route == route and decided.refusal is None
    assert decided.model == MODELS[route]


def test_a_provider_with_no_vision_route_is_refused_not_substituted() -> None:
    decided = _route("deepseek", anthropic_key=True)
    assert decided.refusal == "no_vision_route" and decided.route is None


@pytest.mark.parametrize("provider", ["claude", "openai", "google"])
def test_a_route_without_its_credential_is_refused(provider) -> None:
    # Another provider's key is never used instead.
    others = {
        "claude": {"openai_key": True},
        "openai": {"anthropic_key": True},
        "google": {"openai_key": True},
    }
    assert _route(provider, **others[provider]).refusal == "no_credentials"


def test_strict_offline_mode_keeps_the_pictures_on_the_machine() -> None:
    decided = _route("anthropic", strict=True, anthropic_key=True)
    assert decided.route == "ollama"


def test_a_text_only_model_is_refused_with_its_name() -> None:
    decided = _route("ollama", models={**MODELS, "ollama": f"{TEXT_ONLY}:latest"})
    assert decided.refusal == "model_without_vision"
    assert decided.model == f"{TEXT_ONLY}:latest"


def test_the_catalogue_knows_text_only_models_and_admits_what_it_does_not_know() -> (
    None
):
    assert vision_support("ollama", TEXT_ONLY.upper()) is False
    assert vision_support("ollama", UNRECORDED) is None
    assert vision_support("ollama", "not-a-model") is None
