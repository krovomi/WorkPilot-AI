"""
Design-to-Code providers
========================

Which provider "Import Design" may call, and whether the project lets the call
leave the machine.

Two rules, answered here once for every network call of the pipeline:

* **Only the provider the person chose.** Its own key is read, and when it is
  missing the error names that provider: no other provider's key is tried in
  its place.
* **Strict offline is respected.** Under ``airgapStrict`` only a model running
  on this machine is called (``offline_policy.local_endpoint``, loopback only);
  any cloud call is refused with a fixed message. A policy that cannot be read
  counts as strict, as everywhere else in the backend.
"""

from __future__ import annotations

import os
from pathlib import Path

from offline_policy import STRICT_EXIT_HINT, airgap_status

STRICT_OFFLINE_REFUSAL = (
    "Strict offline mode is on for this project: design-to-code only calls a "
    "model running on this machine (Ollama, LM Studio or llama.cpp). "
    + STRICT_EXIT_HINT
)
UNREADABLE_POLICY_REFUSAL = (
    "The project's offline policy (.workpilot/offline-mode.json) could not be "
    "read, so design-to-code calls no cloud provider. Fix or remove that file."
)

#: The environment variables that hold each provider's own key, in order.
PROVIDER_KEYS: dict[str, tuple[str, ...]] = {
    "claude": ("ANTHROPIC_API_KEY",),
    "openai": ("OPENAI_API_KEY",),
    "google": ("GOOGLE_API_KEY", "GEMINI_API_KEY"),
}
_LABELS = {"claude": "Claude", "openai": "OpenAI", "google": "Google Gemini"}
_ALIASES = {"anthropic": "claude", "gemini": "google"}


class CloudCallRefused(RuntimeError):
    """The project's offline policy keeps this call on the machine."""


def normalize_provider(provider: str | None) -> str:
    """One spelling per provider: ``anthropic`` is ``claude``, ``gemini`` is ``google``."""
    name = (provider or "").strip().lower()
    return _ALIASES.get(name, name)


def cloud_refusal(project_path: Path | str) -> str | None:
    """The fixed reason a cloud call may not leave this project, or None."""
    try:
        status = airgap_status(project_path)
    except (OSError, ValueError):
        return UNREADABLE_POLICY_REFUSAL
    return STRICT_OFFLINE_REFUSAL if status["airgapStrict"] else None


def guard_cloud(project_path: Path | str) -> None:
    """Raise `CloudCallRefused` when the project keeps its calls on the machine."""
    refusal = cloud_refusal(project_path)
    if refusal:
        raise CloudCallRefused(refusal)


def provider_key(provider: str) -> str | None:
    """The chosen provider's own key, never another provider's."""
    for variable in PROVIDER_KEYS.get(provider, ()):
        value = os.environ.get(variable)
        if value:
            return value
    return None


def missing_credentials(provider: str, step: str) -> str:
    """Why ``step`` cannot run with ``provider``, naming that provider."""
    variables = PROVIDER_KEYS.get(provider)
    if not variables:
        return (
            f"Design-to-code {step} has no direct call for {provider or 'this provider'}, "
            "the provider selected. Choose Claude, OpenAI, Google Gemini or a local "
            "model; no other provider is used in its place."
        )
    hint = " or ".join(variables)
    if provider == "claude":
        hint += ", or sign in to Claude Code"
    return (
        f"Design-to-code {step} needs {_LABELS[provider]}, the provider selected, "
        f"and it is not configured: set {hint}. No other provider is used in its place."
    )
