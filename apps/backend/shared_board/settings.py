"""A server card's settings: its engine, priority, category and goal.

On the desktop a card carries the provider, model and effort it runs with
(``task_metadata.json``, ``engineLocked``), a priority and a category, and a
goal (``.workpilot-goal.json``, written only by the app, never by an agent).
A server card had none of them: the app dropped them when it created the card
on the server, and an edit made in the task panel landed in the app's mirror,
which the server never reads. These are the same fields, validated here and
written where the build reads them.

The engine names a provider of the capability matrix
(``capabilities/providers.yaml``); its credentials are the deployment's, as
for every run on the server. The goal is validated by ``goal.spec`` and its
command runs inside the run, confined like the run itself
(``server/services/run_isolation.py``): setting one gives a member nothing an
agent of their card could not already do.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger(__name__)

#: What a reader is told of a goal file that is there but unusable. The cause
#: (a parse error, an OS error naming a path) stays in the server's log.
GOAL_UNREADABLE = "The goal file cannot be used; set the goal again"

Level = Literal["none", "low", "medium", "high", "ultrathink"]
Phase = Literal["spec", "planning", "coding", "qa"]
Priority = Literal["low", "medium", "high", "urgent"]
Category = Literal[
    "feature",
    "bug_fix",
    "refactoring",
    "documentation",
    "security",
    "performance",
    "ui_ux",
    "infrastructure",
    "testing",
]

#: A model id as providers spell them: ``claude-opus-4-8``, ``gpt-5.5``,
#: ``qwen3:32b``, ``anthropic/claude-sonnet-4.6``, ``meta.llama4@v1``.
MODEL_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$"
#: The engine fields this module owns in ``task_metadata.json``.
ENGINE_KEYS = (
    "provider",
    "model",
    "thinkingLevel",
    "isAutoProfile",
    "phaseModels",
    "phaseThinking",
    "phaseProviders",
    "engineLocked",
)


def _known_provider(name: str) -> str:
    from skills_registry.providers import get_provider_capabilities, load_providers

    known = load_providers()
    if name in known or get_provider_capabilities(name).name in known:
        return name
    raise ValueError(f"unknown provider {name!r}")


class CardEngine(BaseModel):
    """The provider, model and effort a card runs with, as the desktop writes them."""

    provider: str = Field(min_length=1, max_length=40)
    model: str | None = Field(default=None, pattern=MODEL_PATTERN)
    thinkingLevel: Level | None = None
    isAutoProfile: bool = False
    phaseModels: dict[Phase, str] | None = None
    phaseThinking: dict[Phase, Level] | None = None
    phaseProviders: dict[Phase, str] | None = None

    @field_validator("provider")
    @classmethod
    def _provider(cls, value: str) -> str:
        return _known_provider(value)

    @field_validator("phaseModels")
    @classmethod
    def _phase_models(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        for model in (value or {}).values():
            if not re.match(MODEL_PATTERN, model):
                raise ValueError(f"invalid model id {model!r}")
        return value

    @field_validator("phaseProviders")
    @classmethod
    def _phase_providers(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        for provider in (value or {}).values():
            _known_provider(provider)
        return value

    def as_metadata(self) -> dict[str, Any]:
        data = {k: v for k, v in self.model_dump().items() if v not in (None, {})}
        # The task owns its engine: nothing global replaces it at run time.
        data["engineLocked"] = True
        return data


class CardSettings(BaseModel):
    """What a card may set besides its text. A field left out is kept; ``null`` clears it."""

    engine: CardEngine | None = None
    priority: Priority | None = None
    category: Category | None = None
    goal: dict[str, Any] | None = None


def _goal_json(raw: dict[str, Any]) -> dict[str, Any]:
    """The goal as the app writes it, once ``goal.spec`` accepts it."""
    from goal.spec import GoalConfigError, parse_goal

    try:
        return goal_dict(parse_goal(raw))
    except GoalConfigError as e:
        raise HTTPException(status_code=422, detail=f"Invalid goal: {e}") from e


def _write_goal(directories: list[Path], goal: dict[str, Any] | None) -> None:
    """Write (or remove) the goal in each copy of the spec folder.

    Write then rename: the build never reads half a file, and a link planted at
    the name is replaced, not followed.
    """
    from goal.spec import GOAL_FILENAME

    for directory in directories:
        path = directory / GOAL_FILENAME
        if goal is None:
            if path.is_symlink() or path.exists():
                path.unlink()
            continue
        temp = directory / f"{GOAL_FILENAME}.{os.getpid()}.tmp"
        temp.write_text(json.dumps(goal, indent=2), encoding="utf-8")
        os.replace(temp, path)


def _metadata(directory: Path) -> dict[str, Any]:
    try:
        value = json.loads(
            (directory / "task_metadata.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _copies(root: Path, directory: Path) -> list[Path]:
    """The spec folder, then its copy in the card's build workspace if there is one."""
    from shared_board.listing import card_source

    source = card_source(root, directory)
    return [directory] if source == directory else [directory, source]


def checked_goal(settings: CardSettings) -> dict[str, Any] | None:
    """The goal the request sets, validated (422) before anything is written."""
    if "goal" not in settings.model_fields_set or settings.goal is None:
        return None
    return _goal_json(settings.goal)


def apply_settings(root: Path, directory: Path, settings: CardSettings) -> None:
    """Write the fields the request names into every copy of the card."""
    given = settings.model_fields_set
    if not given:
        return
    goal = checked_goal(settings)
    copies = _copies(root, directory)
    for copy in copies:
        metadata = _metadata(copy)
        if "engine" in given:
            for key in ENGINE_KEYS:
                metadata.pop(key, None)
            if settings.engine is not None:
                metadata.update(settings.engine.as_metadata())
        for key in ("priority", "category"):
            if key in given:
                value = getattr(settings, key)
                if value is None:
                    metadata.pop(key, None)
                else:
                    metadata[key] = value
        (copy / "task_metadata.json").write_text(
            json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    if "goal" in given:
        _write_goal(copies, goal)


def read_settings(root: Path, directory: Path) -> dict[str, Any]:
    """The card's settings as the build will read them."""
    from goal.spec import GoalConfigError, load_goal

    metadata = _metadata(directory)
    engine = (
        {k: metadata[k] for k in ENGINE_KEYS if k in metadata}
        if metadata.get("provider")
        else None
    )
    result: dict[str, Any] = {
        "engine": engine,
        "priority": metadata.get("priority"),
        "category": metadata.get("category"),
        "goal": None,
        "goalError": None,
    }
    try:
        goal = load_goal(*_copies(root, directory))
    except GoalConfigError as e:
        logger.warning("card %s: unusable goal: %s", directory.name, e)
        result["goalError"] = GOAL_UNREADABLE
    else:
        if goal is not None:
            result["goal"] = goal_dict(goal)
    return result


def goal_dict(goal: Any) -> dict[str, Any]:
    """A loaded goal back in the file's camelCase form."""
    data: dict[str, Any] = {
        "command": goal.command,
        "expectedExit": goal.expected_exit,
        "timeoutSeconds": goal.timeout_s,
    }
    if goal.max_rounds is not None:
        data["maxRounds"] = goal.max_rounds
    if goal.max_cost_usd is not None:
        data["maxCostUsd"] = goal.max_cost_usd
    if goal.protected:
        data["protected"] = list(goal.protected)
    return data
