"""How a provider's context can be managed, from ``capabilities/providers.yaml``.

The matrix is the source of truth (its ``context`` block). The one thing it
cannot say is decided by the client: ``openai`` runs on ``CodexCliAgentClient``
when Codex is the auth mode, and Codex threads compact natively.
"""

from __future__ import annotations

from dataclasses import dataclass

# Client-level facts the provider matrix cannot express (see module docstring).
# `pi-rpc`: a persistent pi process compacts on demand (`compact` over RPC)
# where `pi --mode json` cannot; see core/agent_clients/pi_cli.py.
_NATIVE_CLIENTS = {"openai-codex-cli", "pi-rpc"}

# `provider_name()` of a client -> key of the provider matrix.
_CLIENT_TO_PROVIDER = {
    "openai-codex-cli": "openai",
    "pi-rpc": "pi",
    "gemini": "google",
    "xai": "grok",
    "lm-studio": "lmstudio",
}


@dataclass(frozen=True)
class ContextCapabilities:
    provider: str
    compact: str  # "native" | "emulated"
    usage: str  # "exact" | "reported" | "estimated"

    @property
    def native_compact(self) -> bool:
        return self.compact == "native"


def context_capabilities(client_provider: str | None) -> ContextCapabilities:
    """Capabilities for the provider a client reports. Never raises."""
    name = (client_provider or "").strip().lower()
    provider = _CLIENT_TO_PROVIDER.get(name, name)
    compact, usage = "emulated", "estimated"
    try:
        from skills_registry.providers import get_provider_capabilities

        caps = get_provider_capabilities(provider)
        compact, usage = caps.context_compact, caps.context_usage
    except Exception:  # noqa: BLE001 - the conservative answer stands
        pass
    if name in _NATIVE_CLIENTS:
        compact = "native"
    return ContextCapabilities(provider=provider, compact=compact, usage=usage)
