"""Shared local-provider endpoints and fail-closed offline policy enforcement."""

from __future__ import annotations

import ipaddress
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

LOCAL_PROVIDERS = ("ollama", "lm-studio", "llama-cpp")
_ALIASES = {"lmstudio": "lm-studio", "local": "ollama"}


def local_endpoint(provider: str) -> str:
    """Resolve each runtime independently; offline endpoints must be loopback."""
    provider = _ALIASES.get(provider, provider)
    settings = {
        "ollama": ("OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
        "lm-studio": ("LMSTUDIO_BASE_URL", "http://127.0.0.1:1234"),
        "llama-cpp": ("LLAMA_CPP_BASE_URL", "http://127.0.0.1:8080"),
    }
    if provider not in settings:
        raise ValueError(f"Offline mode requires a local provider: {provider}")
    variable, default = settings[provider]
    endpoint = os.environ.get(variable) or default
    parsed = urlsplit(endpoint)
    host = parsed.hostname or ""
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host == "localhost"
    if (
        parsed.scheme not in {"http", "https"}
        or not loopback
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(f"Offline mode requires a loopback endpoint for {provider}")
    root = endpoint.rstrip("/")
    for suffix in ("/v1/chat/completions", "/chat/completions", "/v1", "/api"):
        if root.endswith(suffix):
            root = root[: -len(suffix)]
            break
    return root


def project_policies(*paths: Path | str | None) -> list[dict]:
    """Check both worktree and original spec ancestors, without hiding corrupt policy."""
    policies = []
    seen: set[Path] = set()
    for path in paths:
        if path is None:
            continue
        start = Path(path).resolve()
        for directory in (start, *start.parents):
            candidate = directory / ".workpilot" / "offline-mode.json"
            if candidate in seen:
                continue
            seen.add(candidate)
            if candidate.exists():
                policy = json.loads(candidate.read_text(encoding="utf-8"))
                if not isinstance(policy, dict) or not isinstance(
                    policy.get("airgapStrict", False), bool
                ):
                    raise ValueError("Invalid offline policy")
                policies.append(policy)
    return policies


def guard_cloud_client(*paths: Path | str | None) -> None:
    if any(policy.get("airgapStrict") for policy in project_policies(*paths)):
        raise ValueError(
            "Offline mode blocks this cloud-only operation. "
            "Use an operation supporting a local agent client."
        )


def resolve_offline_route(
    project_dir: Path, spec_dir: Path, task: str, provider: str, model: str
) -> tuple[str, str, str | None]:
    policies = project_policies(project_dir, spec_dir)
    strict = any(policy.get("airgapStrict") for policy in policies)
    selected = next((p for p in policies if p.get("airgapStrict")), None)
    if selected is None:
        selected = policies[0] if policies else {}
    route = selected.get("routing", {}).get(task)
    if not route and strict:
        default_provider = selected.get("defaultProvider")
        route = next(
            (
                entry
                for entry in selected.get("routing", {}).values()
                if entry.get("provider") == default_provider and entry.get("model")
            ),
            None,
        )
    from phase_config import is_hosted_only_model

    # Offline routes are defaults for callers that have no local selection.
    # A phase's local provider/model pair is more specific than the project
    # default, including the fallback borrowed from another phase in strict mode.
    # Keep invalid local choices too: validation below must reject them rather
    # than silently running a different model.
    selected_local_model = (
        _ALIASES.get(provider, provider) in LOCAL_PROVIDERS
        and bool(model)
        and not is_hosted_only_model(model)
    )
    if route and not selected_local_model:
        provider, model = route["provider"], route["model"]
    if not strict and not route:
        return provider, model, None
    provider = _ALIASES.get(provider, provider)
    if provider not in LOCAL_PROVIDERS:
        if strict:
            raise ValueError(
                f"Offline mode blocks cloud provider {provider} for {task}"
            )
        return provider, model, None
    from ollama_model_detector import is_embedding_model

    if not model or is_embedding_model(model):
        raise ValueError(f"Select a local generation model for {task}")
    endpoint = local_endpoint(provider)
    from core.local_model_catalog import detect_runtime

    runtime = detect_runtime(provider)
    if not runtime.get("available") or model not in {
        entry["name"] for entry in runtime.get("models", [])
    }:
        raise ValueError(f"Local model {model} is unavailable on {provider}")
    return provider, model, endpoint
