"""
Offline-Mode Runner
===================

Powers the offline-first routing dashboard. It introspects the local
environment for offline-capable tooling (Ollama, Llama.cpp, lm-studio)
and reads/writes a JSON policy file at
``<projectPath>/.workpilot/offline-mode.json`` describing the task
routing: which task type maps to which model, whether airgap-strict is
enabled, etc.

Commands
--------

``status``       — detect local runtimes + list installed models.
``list-models``  — same as status but focused on the model list (same
                   JSON shape, `models` key).
``get-policy``   — read the current routing policy.
``set-policy``   — write a new routing policy (supplied via --policy-json).
``report``       — audit of last N routing decisions (from the
                   policy's `history` array).

Output: one JSON object on stdout per invocation.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.local_model_catalog import detect_runtime
from core.offline_policy import LOCAL_PROVIDERS
from ollama_model_detector import is_embedding_model

SCAN_CACHE_TTL_SECONDS = 900  # 15 minutes

SCAN_CACHE_VERSION = 2
TASKS = ("commit_message", "summary", "triage", "planner", "coder", "qa_reviewer")


def _default_policy(project_path: Path) -> dict:
    providers = _scan_models(project_path)["providers"]
    provider = next((p for p in LOCAL_PROVIDERS if providers.get(p)), "ollama")
    models = providers.get(provider, [])
    return {
        "version": 1,
        "airgapStrict": True,
        "defaultProvider": provider,
        "routing": {
            task: {"provider": provider, "model": models[0] if models else ""}
            for task in TASKS
        },
        "history": [],
    }


def _policy_path(project_path: Path) -> Path:
    return project_path / ".workpilot" / "offline-mode.json"


def _load_policy(project_path: Path) -> dict:
    p = _policy_path(project_path)
    if not p.exists():
        return _default_policy(project_path)
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(
            "Cannot read offline policy; repair it before continuing"
        ) from exc


def _save_policy(project_path: Path, policy: dict) -> None:
    if not isinstance(policy.get("airgapStrict"), bool):
        raise ValueError("airgapStrict must be a boolean")
    if policy.get("defaultProvider") not in LOCAL_PROVIDERS:
        raise ValueError("Select a local default provider")
    routing = policy.get("routing")
    if not isinstance(routing, dict):
        raise ValueError("routing must be an object")
    previous = _load_policy(project_path) if _policy_path(project_path).exists() else {}
    disabling_only = (
        previous.get("airgapStrict") is True
        and policy["airgapStrict"] is False
        and previous.get("routing") == routing
        and previous.get("defaultProvider") == policy["defaultProvider"]
    )
    if not disabling_only:
        if policy["airgapStrict"] and not any(
            isinstance(entry, dict)
            and entry.get("provider") == policy["defaultProvider"]
            for entry in routing.values()
        ):
            raise ValueError("Configure a model route for the default local provider")
        providers = _scan_models(project_path, force=True)["providers"]
        for task, entry in routing.items():
            if (
                not isinstance(entry, dict)
                or entry.get("provider") not in LOCAL_PROVIDERS
            ):
                raise ValueError(f"Select a local provider for {task}")
            if (
                not entry.get("model")
                or entry["model"] not in providers[entry["provider"]]
            ):
                raise ValueError(f"Select an available generation model for {task}")
    p = _policy_path(project_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    # Do not leave a truncated policy if the process exits during the write.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=p.parent, delete=False
        ) as handle:
            temporary = Path(handle.name)
            json.dump(policy, handle, indent=2)
        os.replace(temporary, p)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _detect_ollama() -> dict:
    return detect_runtime("ollama")


def _detect_llama_cpp() -> dict:
    return detect_runtime("llama-cpp")


def _detect_lm_studio() -> dict:
    return detect_runtime("lm-studio")


def _cache_path(project_path: Path) -> Path:
    return project_path / ".workpilot" / "offline-mode-cache.json"


def _scan_models(project_path: Path, force: bool = False) -> dict:
    cache_file = _cache_path(project_path)
    now = datetime.now(timezone.utc)
    if not force and cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            cached_at = datetime.fromisoformat(cached["cachedAt"])
            age = (now - cached_at).total_seconds()
            if (
                cached.get("version") == SCAN_CACHE_VERSION
                and 0 <= age < SCAN_CACHE_TTL_SECONDS
            ):
                cached["fromCache"] = True
                cached["ageSeconds"] = int(age)
                return cached
        except (
            OSError,
            json.JSONDecodeError,
            KeyError,
            ValueError,
            TypeError,
            AttributeError,
        ):
            # A missing or invalid cache is rebuilt from the running local services.
            pass

    ollama = _detect_ollama()
    lm_studio = _detect_lm_studio()
    llama_cpp = _detect_llama_cpp()
    providers = {
        provider: sorted(
            {
                m["name"]
                for m in runtime.get("models", [])
                if not is_embedding_model(m["name"])
            }
        )
        if runtime.get("available")
        else []
        for provider, runtime in (
            ("ollama", ollama),
            ("lm-studio", lm_studio),
            ("llama-cpp", llama_cpp),
        )
    }

    result = {
        "version": SCAN_CACHE_VERSION,
        "cachedAt": now.isoformat(),
        "ttlSeconds": SCAN_CACHE_TTL_SECONDS,
        "providers": providers,
        "local": {
            "ollama": ollama.get("available", False),
            "lmStudio": lm_studio.get("available", False),
            "llamaCpp": llama_cpp.get("available", False),
        },
        "fromCache": False,
        "ageSeconds": 0,
    }

    try:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(result, indent=2), encoding="utf-8")
    except OSError:
        # Caching is optional: return the detected models even on read-only projects.
        pass

    return result


def _status() -> dict:
    ollama = _detect_ollama()
    llama_cpp = _detect_llama_cpp()
    lm_studio = _detect_lm_studio()
    local_models = [
        f"{provider}:{m['name']}"
        for provider, runtime in (
            ("ollama", ollama),
            ("lm-studio", lm_studio),
            ("llama-cpp", llama_cpp),
        )
        for m in runtime.get("models", [])
        if not is_embedding_model(m["name"])
    ]
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "runtimes": {
            "ollama": ollama,
            "llamaCpp": llama_cpp,
            "lmStudio": lm_studio,
        },
        "localModels": local_models,
        "offlineReady": bool(local_models),
    }


def _report(project_path: Path) -> dict:
    policy = _load_policy(project_path) if _policy_path(project_path).exists() else {}
    history = policy.get("history", [])
    counts: dict[str, int] = {}
    for entry in history:
        provider = entry.get("provider", "unknown")
        counts[provider] = counts.get(provider, 0) + 1
    total = sum(counts.values()) or 1
    mix = {k: round(v / total, 3) for k, v in counts.items()}
    return {
        "total": sum(counts.values()),
        "providers": counts,
        "mix": mix,
        "history": history[-50:],
        "confidentialityLevel": (
            "local"
            if counts and set(counts) <= {"ollama", "llama-cpp", "lm-studio", "local"}
            else ("mixed" if counts else "unknown")
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Offline Mode Runner")
    parser.add_argument(
        "--command",
        required=True,
        choices=[
            "status",
            "list-models",
            "scan-models",
            "get-policy",
            "set-policy",
            "report",
        ],
    )
    parser.add_argument("--project-path", required=True)
    parser.add_argument("--policy-json", default=None)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    project_path = Path(args.project_path)
    if not project_path.exists():
        print(json.dumps({"error": f"Project not found: {project_path}"}), flush=True)
        sys.exit(1)

    try:
        if args.command in {"status", "list-models"}:
            print(json.dumps(_status()), flush=True)
            return

        if args.command == "scan-models":
            print(json.dumps(_scan_models(project_path, force=args.force)), flush=True)
            return

        if args.command == "get-policy":
            print(
                json.dumps(
                    {
                        "policy": _load_policy(project_path),
                        "persisted": _policy_path(project_path).exists(),
                    }
                ),
                flush=True,
            )
            return

        if args.command == "set-policy":
            if not args.policy_json:
                raise ValueError("--policy-json is required")
            new_policy = json.loads(args.policy_json)
            if not isinstance(new_policy, dict):
                raise ValueError("policy must be a JSON object")
            _save_policy(project_path, new_policy)
            print(json.dumps({"policy": new_policy}), flush=True)
            return

        if args.command == "report":
            print(json.dumps(_report(project_path)), flush=True)
            return
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
