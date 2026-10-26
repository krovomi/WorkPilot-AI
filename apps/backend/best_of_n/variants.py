"""The variants of a task: their engines, their spec directories, their state.

A best-of-N run builds one task N times, each time in its own worktree with its
own provider, model and effort. Each variant is a sibling spec directory,
``<parent>-bon<k>``, copied from the parent before anything is built, with the
engine written in its ``task_metadata.json`` (``engineLocked``) and a
``bestOfN`` marker that keeps it off the Kanban board. ``run.py`` then builds
it like any task: its own worktree (``.workpilot/worktrees/tasks/<variant>``),
its own branch (``workpilot/<variant>``), its own cost lines.

The state of the run is ``<parent>/best_of_n.json``. The main process updates
the variants' exits there, the ranking writes its table there, and an adoption
or a discard closes it.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

__all__ = [
    "MAX_VARIANTS",
    "MIN_VARIANTS",
    "STATE_FILENAME",
    "BestOfNError",
    "Variant",
    "copy_parent_spec",
    "parse_variants",
    "read_state",
    "variant_spec_id",
    "write_state",
]

STATE_FILENAME = "best_of_n.json"
MIN_VARIANTS = 2
MAX_VARIANTS = 4
ENGINE_PHASES = ("spec", "planning", "coding", "qa")

_PROVIDER = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_EFFORT = re.compile(r"^[a-z][a-z_-]{0,31}$")
_MODEL_MAX = 200

# What a build writes into a spec directory. The parent has not been built, so
# none should be there; if one is, it is not copied into a fresh variant.
_BUILD_OUTPUTS = {
    STATE_FILENAME,
    "task_logs.json",
    "pause_state.json",
    "goal_result.json",
    "qa_report.md",
    "QA_FIX_REQUEST.md",
    "build-progress.txt",
    "attempt_history.json",
    "memory",
    "logs",
    "events.jsonl",
}


class BestOfNError(ValueError):
    """A run that cannot start or a request that cannot be carried out."""


@dataclass(frozen=True)
class Variant:
    provider: str
    model: str
    effort: str

    def engine_metadata(self) -> dict:
        """The task metadata that makes this trio the variant's own engine.

        The same keys ``buildEngineMetadata`` writes in the renderer: every
        phase, and the coding phase's trio as the task-wide values.
        """
        return {
            "engineLocked": True,
            "isAutoProfile": True,
            "provider": self.provider,
            "model": self.model,
            "thinkingLevel": self.effort,
            "phaseProviders": dict.fromkeys(ENGINE_PHASES, self.provider),
            "phaseModels": dict.fromkeys(ENGINE_PHASES, self.model),
            "phaseThinking": dict.fromkeys(ENGINE_PHASES, self.effort),
        }

    def to_dict(self) -> dict:
        return asdict(self)


def parse_variants(raw) -> list[Variant]:
    """The variants of a request. Raises ``BestOfNError``."""
    if not isinstance(raw, list):
        raise BestOfNError("variants must be a list")
    if not MIN_VARIANTS <= len(raw) <= MAX_VARIANTS:
        raise BestOfNError(
            f"a best-of-N run has between {MIN_VARIANTS} and {MAX_VARIANTS} variants"
        )
    variants: list[Variant] = []
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            raise BestOfNError(f"variant {index} must be an object")
        provider = item.get("provider")
        model = item.get("model")
        effort = item.get("effort")
        if not isinstance(provider, str) or not _PROVIDER.match(provider):
            raise BestOfNError(f"variant {index} has no valid provider")
        if (
            not isinstance(model, str)
            or not model.strip()
            or len(model) > _MODEL_MAX
            or any(ord(c) < 32 for c in model)
        ):
            raise BestOfNError(f"variant {index} has no valid model")
        if not isinstance(effort, str) or not _EFFORT.match(effort):
            raise BestOfNError(f"variant {index} has no valid effort")
        variants.append(Variant(provider, model.strip(), effort))
    return variants


def variant_spec_id(parent: str, index: int) -> str:
    """``<parent>-bon<k>``, within the 128 characters a spec name may have."""
    suffix = f"-bon{index}"
    return parent[: 128 - len(suffix)] + suffix


def _read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _write_json(path: Path, data: dict) -> None:
    partial = path.with_name(path.name + ".partial")
    partial.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(partial, path)


def copy_parent_spec(
    parent_dir: Path, variant_dir: Path, parent_id: str, index: int, variant: Variant
) -> None:
    """Make ``variant_dir`` a copy of the parent spec that runs on ``variant``.

    Symbolic links are refused: a spec directory holds files the person and
    the spec pipeline wrote, and a link would carry a path from elsewhere into
    a worktree the agents can read.
    """
    if variant_dir.exists() or variant_dir.is_symlink():
        raise BestOfNError(f"{variant_dir.name} already exists")
    for entry in parent_dir.rglob("*"):
        if entry.is_symlink():
            raise BestOfNError(
                f"the spec contains a symbolic link ({entry.relative_to(parent_dir)})"
            )

    def ignore(directory: str, names: list[str]) -> set[str]:
        if Path(directory) == parent_dir:
            return {n for n in names if n in _BUILD_OUTPUTS or n.endswith(".partial")}
        return set()

    shutil.copytree(parent_dir, variant_dir, ignore=ignore)
    metadata = _read_json(parent_dir / "task_metadata.json") or {}
    for key in ("archivedAt", "archivedInVersion", "prUrl", "paused"):
        metadata.pop(key, None)
    metadata.update(variant.engine_metadata())
    metadata["bestOfN"] = {"parent": parent_id, "index": index}
    _write_json(variant_dir / "task_metadata.json", metadata)


def read_state(parent_dir: Path) -> dict | None:
    path = parent_dir / STATE_FILENAME
    if path.is_symlink():
        return None
    return _read_json(path)


def write_state(parent_dir: Path, state: dict) -> None:
    path = parent_dir / STATE_FILENAME
    if path.is_symlink():
        raise BestOfNError(f"{STATE_FILENAME} is a symbolic link")
    state["updatedAt"] = datetime.now(UTC).isoformat()
    _write_json(path, state)
