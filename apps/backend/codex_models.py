"""Read Codex's non-secret account model inventory, never the API catalog."""

import json
import os
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from core.codex_catalog_rpc import discover_models as _discover_models
from core.offline_policy import airgap_status
from core.platform import find_executable

_catalog_lock = threading.Lock()
_catalogs: dict[tuple[str, str, str, int, int], tuple[float, dict[str, Any]]] = {}


def resolve_codex_model(model: str | None) -> str | None:
    """Preserve Codex account model IDs, including small/fast models."""
    return model


def _model_tier(model: str, label: str = "") -> str:
    name = f"{model} {label}".lower()
    if any(marker in name for marker in ("mini", "nano", "small", "fast", "lite")):
        return "fast"
    if any(marker in name for marker in ("pro", "opus", "flagship")):
        return "flagship"
    return "standard"


def _cached_catalog() -> dict[str, Any]:
    """Read only the current runtime's non-secret cache as an offline fallback."""
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    models = []
    fetched_at = None
    try:
        with (home / "models_cache.json").open(encoding="utf-8") as handle:
            data = json.load(handle)
        timestamp = data.get("fetched_at")
        if isinstance(timestamp, str):
            try:
                fetched_at = datetime.fromisoformat(
                    timestamp.replace("Z", "+00:00")
                ).timestamp()
            except ValueError:
                fetched_at = None
        for entry in data.get("models", []):
            if not isinstance(entry, dict) or entry.get("visibility") != "list":
                continue
            slug = entry.get("slug")
            if not isinstance(slug, str) or not slug.strip():
                continue
            models.append(
                {
                    "value": slug,
                    "label": entry.get("display_name") or slug,
                    "tier": _model_tier(slug, entry.get("display_name") or ""),
                    "supportsThinking": True,
                }
            )
    except (OSError, ValueError, AttributeError, TypeError):
        # The CLI cache is optional and can be partially written during refresh.
        # Discard partial results and use the conservative fallback below.
        models = []
    return {
        "provider": "openai-codex",
        "models": models
        or [
            {
                "value": "gpt-5.5",
                "label": "GPT-5.5",
                "tier": "flagship",
                "supportsThinking": True,
            }
        ],
        "source": "cache" if models else "static",
        "fetchedAt": fetched_at if models else None,
        "error": None,
    }


def codex_model_catalog(*, force_refresh: bool = False) -> dict[str, Any]:
    """Discover account models without starting a turn or reading credentials.

    Cache successful discovery for 15 minutes, failures for 30 seconds. Explicit
    refresh (including after a CLI update) always bypasses this process cache.
    """
    if airgap_status(Path.cwd())["airgapStrict"]:
        return _cached_catalog()
    # A CLI update can unlock new account models even while PATH stays identical.
    # Resolve symlinks so replacing a package-manager target also invalidates it.
    executable = find_executable("codex")
    cli_path = ""
    modified_at = size = 0
    if executable:
        try:
            resolved = Path(executable).resolve()
            stat = resolved.stat()
            cli_path = str(resolved)
            modified_at, size = stat.st_mtime_ns, stat.st_size
        except OSError:
            cli_path = executable
    key = (
        str(Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")),
        os.environ.get("PATH", ""),
        cli_path,
        modified_at,
        size,
    )
    with _catalog_lock:
        cached = _catalogs.get(key)
        if not force_refresh and cached and time.monotonic() < cached[0]:
            return cached[1]
        try:
            models = _discover_models()
            result = {
                "provider": "openai-codex",
                "models": models,
                "source": "live",
                "fetchedAt": time.time(),
                "error": None,
            }
            ttl = 15 * 60
        except (OSError, ValueError, TimeoutError, subprocess.SubprocessError):
            result = _cached_catalog()
            # Never expose CLI stderr or account details through the catalog API.
            result["error"] = (
                "Codex model discovery unavailable; using the local fallback. Check or update Codex CLI and refresh."
            )
            ttl = 30
        _catalogs[key] = (time.monotonic() + ttl, result)
        return result
