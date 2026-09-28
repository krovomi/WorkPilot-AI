"""Read Codex's non-secret account model inventory, never the API catalog."""

import json
import logging
import os
from pathlib import Path
from typing import Any


def resolve_codex_model(model: str | None) -> str | None:
    """Repair the legacy API-tier fallback persisted by WorkPilot profiles."""
    if model == "gpt-5.5-mini":
        logging.getLogger(__name__).warning(
            "Replacing legacy gpt-5.5-mini with gpt-5.5 for Codex ChatGPT authentication"
        )
        return "gpt-5.5"
    return model


def codex_model_catalog() -> dict[str, Any]:
    """Use the CLI inventory when available, with a conservative offline fallback."""
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    models = []
    try:
        with (home / "models_cache.json").open(encoding="utf-8") as handle:
            data = json.load(handle)
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
                    "tier": "flagship",
                    "supportsThinking": True,
                }
            )
    except (OSError, ValueError, AttributeError, TypeError):
        pass
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
        "fetchedAt": None,
        "error": None,
    }
