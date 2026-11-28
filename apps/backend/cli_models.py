"""The models a coding-agent CLI can call, read from the CLI itself.

OpenCode, pi and Antigravity pick their model among the providers the person
signed in to *inside the CLI* (``opencode auth login``, pi's ``auth.json``,
the Antigravity sign-in). WorkPilot cannot know that list: the catalogue used
to offer nothing for these providers, so a phase's model dropdown showed only
the model it already had. Each CLI prints its own list:

- ``opencode models``: one ``provider/model`` per line, the providers it has
  credentials for (https://opencode.ai/docs/cli/#models);
- ``pi --list-models``: a table whose first two columns are the provider and
  the model, only providers with a configured key;
- ``agy models``: one model slug per line (the id ``--model`` takes).

Gemini CLI has no listing command: it takes Gemini ids, so its list is the
Google catalogue's ``gemini-`` models.

The output is data from another program: only ids that pass
:data:`_MODEL_ID` are kept (they later reach a command line), and a CLI that is
missing, slow or failing gives ``[]`` so the caller falls back.

A unit of its own, like ``copilot_models``: it imports only ``foundation`` and
the public registry, so the model catalogue reads it without joining ``core``.
"""

from __future__ import annotations

import logging
import re
import subprocess
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

#: The sentinel that leaves the choice to the CLI (``phase_config.CLI_DEFAULT_MODEL``).
CLI_DEFAULT_MODEL = "default"

#: Providers whose model list this module answers.
CLI_PROVIDERS = frozenset({"opencode", "pi", "antigravity", "gemini-cli"})

#: What an id may look like: the characters ``validated_option`` accepts for a
#: launcher argument, no leading dash (it would read as an option).
_MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+#-]{0,199}$")

_LIST_TIMEOUT_SECONDS = 15
_MAX_MODELS = 2000

_DEFAULT_LABELS = {
    "opencode": "OpenCode default",
    "pi": "pi default",
    "antigravity": "Antigravity default",
    "gemini-cli": "Gemini CLI default (auto)",
}


def _run(executable: str, args: list[str]) -> str:
    """The CLI's stdout, or ``""`` when it cannot answer."""
    from foundation.platform import build_windows_command

    try:
        result = subprocess.run(
            build_windows_command(executable, args),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_LIST_TIMEOUT_SECONDS,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError) as error:
        logger.info("[cli_models] %s %s failed: %s", executable, args, error)
        return ""
    if result.returncode != 0:
        logger.info("[cli_models] %s %s exited %s", executable, args, result.returncode)
        return ""
    return result.stdout or ""


def _valid(model_id: str) -> bool:
    return bool(_MODEL_ID.fullmatch(model_id)) and model_id != CLI_DEFAULT_MODEL


def parse_opencode(output: str) -> list[str]:
    """``provider/model`` ids, one per line, in order and without repeats."""
    ids: list[str] = []
    for line in output.splitlines():
        candidate = line.strip()
        if "/" in candidate and _valid(candidate) and candidate not in ids:
            ids.append(candidate)
    return ids[:_MAX_MODELS]


def parse_pi(output: str) -> list[str]:
    """``provider/model`` ids from the first two columns of pi's table."""
    ids: list[str] = []
    for line in output.splitlines():
        columns = line.split()
        if len(columns) < 2 or columns[0].lower() == "provider":
            continue
        candidate = f"{columns[0]}/{columns[1]}"
        if _valid(candidate) and candidate not in ids:
            ids.append(candidate)
    return ids[:_MAX_MODELS]


def parse_slugs(output: str) -> list[str]:
    """Bare slugs: the first word of each line that is one."""
    ids: list[str] = []
    for line in output.splitlines():
        columns = line.split()
        if not columns:
            continue
        candidate = columns[0]
        if _valid(candidate) and candidate.lower() not in {"model", "models", "id"}:
            if candidate not in ids:
                ids.append(candidate)
    return ids[:_MAX_MODELS]


#: provider → (executable, arguments, parser).
_LISTINGS: dict[str, tuple[str, list[str], Callable[[str], list[str]]]] = {
    "opencode": ("opencode", ["models"], parse_opencode),
    "pi": ("pi", ["--list-models"], parse_pi),
    "antigravity": ("agy", ["models"], parse_slugs),
}


def _registry_names() -> dict[str, dict[str, Any]]:
    """``provider/model`` → registry record, from the cached registry only."""
    try:
        import public_model_registry
    except ImportError:  # pragma: no cover - always importable from the backend root
        return {}
    records: dict[str, dict[str, Any]] = {}
    for provider in public_model_registry.PROVIDER_IDS:
        found = public_model_registry.models_for(provider)
        if not found:
            continue
        cli_prefix = public_model_registry.PROVIDER_IDS[provider]
        for record in found[0]:
            records[f"{cli_prefix}/{record['id']}"] = record
            records.setdefault(f"{provider}/{record['id']}", record)
    return records


def _label(model_id: str, records: dict[str, dict[str, Any]]) -> str:
    record = records.get(model_id)
    name = record.get("name") if record else None
    if isinstance(name, str) and name.strip():
        prefix = model_id.split("/", 1)[0] if "/" in model_id else ""
        return f"{name.strip()} ({prefix})" if prefix else name.strip()
    return model_id


def _entry(
    model_id: str, records: dict[str, dict[str, Any]], tier_for: Callable[[str], str]
) -> dict[str, Any]:
    record = records.get(model_id) or {}
    label = _label(model_id, records)
    return {
        "value": model_id,
        "label": label,
        "tier": tier_for(model_id.rsplit("/", 1)[-1]),
        "supportsThinking": record.get("reasoning") is True,
    }


def default_entry(provider: str) -> dict[str, Any]:
    """The row that hands the choice back to the CLI."""
    return {
        "value": CLI_DEFAULT_MODEL,
        "label": _DEFAULT_LABELS.get(provider, "CLI default"),
        "tier": "standard",
        "supportsThinking": False,
    }


def list_cli_models(
    provider: str,
    *,
    tier_for: Callable[[str], str],
    google_models: Callable[[], list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """The catalogue entries for ``provider``'s CLI, ``default`` first.

    ``[]`` when the CLI is not installed or gives no usable id: the caller
    then serves its static list. ``tier_for`` and ``google_models`` come from
    the catalogue, which owns those rules.
    """
    if provider == "gemini-cli":
        gemini = [
            {**m, "value": m["value"].removeprefix("models/")}
            for m in google_models()
            if isinstance(m.get("value"), str)
            and m["value"].removeprefix("models/").startswith("gemini-")
        ]
        return [default_entry(provider), *gemini] if gemini else []
    listing = _LISTINGS.get(provider)
    if listing is None:
        return []
    name, args, parse = listing
    from foundation.platform import find_executable

    executable = find_executable(name)
    if not executable:
        return []
    ids = parse(_run(executable, args))
    if not ids:
        return []
    records = _registry_names()
    logger.info("[cli_models] %s lists %d models", provider, len(ids))
    return [default_entry(provider), *(_entry(i, records, tier_for) for i in ids)]


__all__ = [
    "CLI_DEFAULT_MODEL",
    "CLI_PROVIDERS",
    "default_entry",
    "list_cli_models",
    "parse_opencode",
    "parse_pi",
    "parse_slugs",
]
