"""The spec pipeline's model and effort, read again before each phase.

`spec_runner` gets the spec model and effort on its command line once, at
launch. The card's engine can change while the spec runs: the dropdown persists
the change to `task_metadata.json` and writes `HOT_SWAP.json`, which the coder
and the QA loop pick up — the spec pipeline never read either. On 2026-11-28 a
card switched to Haiku 5.5 with no thinking 26 s after launch still ran its
five spec phases on Sonnet 5 with 4 096 thinking tokens: 96 % of its cost.

Before each phase the orchestrator now asks `pending_change` what the card
says, read the way the frontend builds the launch arguments
(`apps/frontend/src/main/agent/spec-launch-config.ts`): a task that owns its
engine (`engineLocked`) reads its `spec` row, a legacy one its `planning` row
first. A provider change is not applied here: it needs other credentials and
another client, which a restart of the phase gives.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

#: Effort names the spec runner accepts (`--thinking-level`).
_EFFORTS = frozenset({"none", "low", "medium", "high", "ultrathink"})


@dataclass(frozen=True)
class EngineChange:
    """What differs from the running spec pipeline; a field left None is unchanged."""

    model: str | None = None
    effort: str | None = None

    def describe(self) -> str:
        parts = []
        if self.model:
            parts.append(f"model={self.model}")
        if self.effort:
            parts.append(f"effort={self.effort}")
        return ", ".join(parts)


def _read_metadata(spec_dir: Path) -> dict:
    try:
        data = json.loads(
            (Path(spec_dir) / "task_metadata.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _same_provider(asked: str | None, running: str | None) -> bool:
    def norm(value: str | None) -> str:
        value = (value or "").strip().lower()
        return "claude" if value == "anthropic" else value

    return not asked or not running or norm(asked) == norm(running)


def _resolve(model: str, provider: str | None) -> str:
    from phase_config import _resolve_provider_model, resolve_model_id

    norm = (provider or "").strip().lower()
    if norm and norm not in ("anthropic", "claude"):
        return _resolve_provider_model(model, norm)
    return resolve_model_id(model)


def card_spec_engine(spec_dir: Path) -> tuple[str | None, str | None, str | None]:
    """(provider, model, effort) the card names for its spec, any may be None."""
    metadata = _read_metadata(spec_dir)
    if not metadata:
        return None, None, None
    rows = (
        ("spec", "planning") if metadata.get("engineLocked") else ("planning", "spec")
    )

    def pick(key: str) -> str | None:
        table = metadata.get(key)
        table = table if isinstance(table, dict) else {}
        for row in rows:
            value = table.get(row)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    provider = pick("phaseProviders") or metadata.get("provider")
    model = pick("phaseModels") or metadata.get("model")
    effort = pick("phaseThinking") or metadata.get("thinkingLevel")
    return (
        provider if isinstance(provider, str) else None,
        model if isinstance(model, str) and model else None,
        effort if effort in _EFFORTS else None,
    )


def pending_change(
    spec_dir: Path, model: str | None, effort: str | None
) -> EngineChange | None:
    """The card's spec model and effort where they differ from the running ones."""
    provider, asked_model, asked_effort = card_spec_engine(spec_dir)
    if not _same_provider(provider, os.environ.get("SELECTED_LLM_PROVIDER")):
        return None
    new_model = None
    if asked_model:
        resolved = _resolve(asked_model, provider)
        if resolved and resolved != model:
            new_model = resolved
    new_effort = asked_effort if asked_effort and asked_effort != effort else None
    if not (new_model or new_effort):
        return None
    return EngineChange(model=new_model, effort=new_effort)


__all__ = ["EngineChange", "card_spec_engine", "pending_change"]
