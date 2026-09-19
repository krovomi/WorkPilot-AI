"""
Plan Recovery
=============

Where is the implementation plan, and what shape is it in?

`Planning failed: the model did not produce a valid implementation_plan.json`
used to be the answer to a question nobody had asked: the validator reads one
path, in one shape, and reports what it did not find there. Three other things
are true far more often than "the model produced nothing", and every one of them
is recoverable without spending another planning session:

* **It wrote the plan somewhere else.** PHASE 3 of `prompts/planner.md` spells
  the destination as ``implementation_plan.json``, and a relative path resolves
  against the worktree root, not the spec directory. `_cleanup_stray_root_plan`
  already knew this file existed — it deleted it. A model that invents a name
  (``plan.json``, ``tasks.json``) lands in the same place.
* **It wrote the right file in a shape the schema does not name.** ``tasks``
  instead of ``phases``, one level of ``{"implementation_plan": {…}}`` wrapping,
  ``phases`` as an object keyed by phase id, a subtask that is a bare string.
  Every one of those is a plan somebody could read.
* **It never called Write and the JSON is in the transcript**, usually inside a
  ```json fence with a sentence either side.

So this module answers the question in two halves, and both are reusable on
their own:

``normalize_plan_shape``
    a parsed *anything* → the schema's shape, or ``None`` when there is no
    subtask in it at all. Used by `validate_pkg.auto_fix` on the file the
    validator reads, so the CLI and the spec pipeline get it too.
``recover_plan``
    the same normalization applied to every place the plan could be, in
    descending order of how much the location proves, writing the winner to the
    one path WorkPilot reads.

**Shape recovery is not invention.** A normalized plan is one whose subtasks the
model wrote; the only things added are the keys the schema requires and the
model left implicit (``status: pending``, a phase to hold a flat list, ids).
When nothing carries a single subtask, this returns ``None`` and planning fails
the way it did before — a plan WorkPilot made up would be worse than the error
message, because the coder would spend a full build implementing it.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# The plan, wrapped. A model asked for `implementation_plan.json` hands back
# `{"implementation_plan": {...}}` often enough to be worth one unwrap.
_WRAPPER_KEYS = ("implementation_plan", "implementationPlan", "plan")

# What the phases list can be called.
_PHASES_KEYS = ("phases", "stages", "milestones", "workstreams")

# What a list of subtasks can be called, at the top level or inside a phase.
# `subtasks` and `chunks` are WorkPilot's own current and legacy names; the rest
# are what a model reaches for when it is writing a plan rather than filling in
# a schema.
_SUBTASKS_KEYS = ("subtasks", "chunks", "tasks", "steps", "items", "actions")

# How deep `_unwrap` will dig before deciding the document is not a plan.
_MAX_UNWRAP_DEPTH = 3

# The asked-for name, spelled the three ways a model spells it. These are the
# only names looked for outside the spec directory: nothing in a project is
# already called `implementation_plan.json`, so a file with that name at the
# worktree root can only be the one the planner just wrote.
_ASKED_FOR_NAMES = (
    "implementation_plan.json",
    "implementation-plan.json",
    "implementationPlan.json",
)

# Names a planner invents instead. Searched **only inside the spec directory**,
# which is WorkPilot's own: `tasks.json` and `plan.json` are ordinary filenames
# that a real project can already have at its root, and reading one of those as
# a plan would build somebody's task-runner config.
_INVENTED_NAMES = ("plan.json", "tasks.json", "subtasks.json")

# Keys the frontend writes into `implementation_plan.json` to track the card
# while the plan itself does not exist yet (`persistPlanStatusAndReasonSync`).
# A recovered plan is merged *over* that shell rather than replacing it: the
# status and the XState snapshot describe the task, not the plan, and dropping
# them would reset a card that is visibly running.
_SHELL_KEYS = (
    "created_at",
    "status",
    "planStatus",
    "reviewReason",
    "xstateState",
    "executionPhase",
    "lastEvent",
)


@dataclass
class RecoveredPlan:
    """A plan found somewhere other than the shape the validator reads."""

    plan: dict[str, Any]
    # Where it came from, for the line the build prints. A path, or "the
    # planner's response" when it was salvaged from the transcript.
    origin: str
    # The file it was read from, when it was a file. Promoted plans that came
    # from outside the spec directory are removed by the caller.
    source_file: Path | None = None
    subtask_count: int = 0
    notes: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# JSON out of prose
# --------------------------------------------------------------------------- #


def extract_json_document(text: str) -> Any | None:
    """The first complete JSON object or array in ``text``, or ``None``.

    Handles the three ways a model hands back JSON that ``json.loads`` refuses:
    a ```json fence, a sentence before it ("Here is the plan:"), and a sentence
    after it. Scans with a brace/bracket depth counter that ignores everything
    inside string literals, so a `"description": "map[0] of {x}"` does not close
    the document early.

    Returns the *first* complete document rather than the largest: a planner's
    response that shows the plan and then an example of one subtask should be
    read as the plan.
    """
    if not text:
        return None

    # A whole document that already parses needs none of this.
    stripped = text.strip()
    try:
        return json.loads(stripped)
    except (ValueError, TypeError):
        pass

    for start, opener in _document_starts(stripped):
        closer = "}" if opener == "{" else "]"
        depth = 0
        in_string = False
        escaped = False
        for i in range(start, len(stripped)):
            char = stripped[i]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == opener:
                depth += 1
            elif char == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(stripped[start : i + 1])
                    except ValueError:
                        break  # this candidate is malformed; try the next one
    return None


def _document_starts(text: str) -> list[tuple[int, str]]:
    """Offsets where a JSON document plausibly begins, best first.

    A fenced block is the strongest signal a model can give about which braces
    it meant, so those offsets come first; bare offsets follow in reading order.
    """
    starts: list[tuple[int, str]] = []
    seen: set[int] = set()

    for fence in ("```json", "```JSON", "```"):
        cursor = 0
        while (opening := text.find(fence, cursor)) != -1:
            body = opening + len(fence)
            for offset in range(body, min(body + 200, len(text))):
                if text[offset] in "{[":
                    if offset not in seen:
                        seen.add(offset)
                        starts.append((offset, text[offset]))
                    break
                if not text[offset].isspace():
                    break
            cursor = body

    for offset, char in enumerate(text):
        if char in "{[" and offset not in seen:
            seen.add(offset)
            starts.append((offset, char))

    return starts


# --------------------------------------------------------------------------- #
# Any shape -> the schema's shape
# --------------------------------------------------------------------------- #


def normalize_plan_shape(data: Any) -> dict[str, Any] | None:
    """A parsed document → a plan with ``phases[].subtasks[]``, or ``None``.

    ``None`` means "there is no subtask in here", which is the one case where
    planning genuinely has nothing to go on. Everything else is renaming and
    re-nesting what the model already decided.
    """
    document = _unwrap(data)
    if document is None:
        return None

    if isinstance(document, list):
        phases = _phases_from_list(document)
        plan: dict[str, Any] = {}
    else:
        plan = {k: v for k, v in document.items() if k not in _PHASES_KEYS}
        raw_phases = _first_present(document, _PHASES_KEYS)
        if raw_phases is not None:
            phases = _phases_from_list(_as_phase_list(raw_phases))
        else:
            # No phases at all: a flat list of subtasks under any of its names.
            flat = _first_present(document, _SUBTASKS_KEYS)
            if not isinstance(flat, list):
                return None
            for key in _SUBTASKS_KEYS:
                plan.pop(key, None)
            phases = _phases_from_list([{"subtasks": flat}])

    phases = [phase for phase in phases if phase.get("subtasks")]
    if not phases:
        return None

    plan["phases"] = phases
    if not isinstance(plan.get("feature"), str) or not plan["feature"].strip():
        title = plan.get("title") or plan.get("name") or plan.get("description")
        plan["feature"] = (
            title.strip()
            if isinstance(title, str) and title.strip()
            else "Unnamed Feature"
        )
    if "workflow_type" not in plan:
        plan["workflow_type"] = "feature"
    return plan


def _unwrap(data: Any) -> dict[str, Any] | list[Any] | None:
    """Strip ``{"implementation_plan": {…}}``-style wrapping, bounded."""
    current = data
    for _ in range(_MAX_UNWRAP_DEPTH):
        if isinstance(current, list):
            return current
        if not isinstance(current, dict):
            return None
        # Already the plan: it names its phases or its subtasks itself.
        if any(key in current for key in (*_PHASES_KEYS, *_SUBTASKS_KEYS)):
            return current
        inner = _first_present(current, _WRAPPER_KEYS)
        if inner is None:
            return None
        current = inner
    return None


def _first_present(mapping: dict[str, Any], keys: tuple[str, ...]) -> Any | None:
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


def _as_phase_list(raw: Any) -> list[Any]:
    """``phases`` as the schema wants it: a list.

    A model that keys phases by id (``{"phase-1": {...}}``) has said something
    the list form cannot: which id belongs to which phase. That is carried over
    rather than discarded, and the insertion order is the declared order.
    """
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        phases = []
        for key, value in raw.items():
            if isinstance(value, dict):
                phase = dict(value)
                phase.setdefault("id", str(key))
                phase.setdefault("name", str(key))
                phases.append(phase)
            elif isinstance(value, list):
                phases.append({"id": str(key), "name": str(key), "subtasks": value})
        return phases
    return []


def _phases_from_list(raw_phases: list[Any]) -> list[dict[str, Any]]:
    """Normalize a list that is either phases, or subtasks wearing the name.

    A model asked for phases containing subtasks often produces one flat list of
    work items under ``phases``. They are told apart by whether any entry holds
    a list of its own: a phase has subtasks, a subtask does not.
    """
    entries = [entry for entry in raw_phases if entry is not None]
    if not entries:
        return []

    looks_like_phases = any(
        isinstance(entry, dict)
        and isinstance(_first_present(entry, _SUBTASKS_KEYS), list)
        for entry in entries
    )
    if not looks_like_phases:
        entries = [{"subtasks": entries}]

    phases: list[dict[str, Any]] = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        phase = {k: v for k, v in entry.items() if k not in _SUBTASKS_KEYS}
        raw_subtasks = _first_present(entry, _SUBTASKS_KEYS)
        subtasks = raw_subtasks if isinstance(raw_subtasks, list) else []

        phase.setdefault("id", str(entry.get("phase") or f"phase-{index + 1}"))
        if not isinstance(phase.get("name"), str) or not phase["name"].strip():
            title = entry.get("title") or entry.get("phase_name")
            phase["name"] = (
                title
                if isinstance(title, str) and title.strip()
                else f"Phase {index + 1}"
            )
        phase["subtasks"] = [
            normalized
            for position, subtask in enumerate(subtasks)
            if (normalized := _normalize_subtask(subtask, index, position)) is not None
        ]
        phases.append(phase)
    return phases


def _normalize_subtask(
    subtask: Any, phase_index: int, index: int
) -> dict[str, Any] | None:
    """One subtask, in whatever the model produced.

    A bare string is a real answer — "Add the missing namespaces to Foo.cs" is
    the description and nothing else was ever going to be in it — so it becomes
    a subtask rather than being dropped. `auto_fix_plan` fills in the ids and
    statuses afterwards; what this must not do is invent a *description*, which
    is the only field carrying the model's decision.
    """
    if isinstance(subtask, str):
        text = subtask.strip()
        if not text:
            return None
        subtask = {"description": text}
    if not isinstance(subtask, dict):
        return None
    normalized = dict(subtask)
    description = normalized.get("description")
    if not isinstance(description, str) or not description.strip():
        for alias in ("title", "name", "task", "summary", "goal"):
            value = normalized.get(alias)
            if isinstance(value, str) and value.strip():
                normalized["description"] = value.strip()
                break
    if not isinstance(normalized.get("description"), str):
        return None
    normalized.setdefault("id", f"subtask-{phase_index + 1}-{index + 1}")
    return normalized


def count_subtasks(plan: dict[str, Any]) -> int:
    phases = plan.get("phases")
    if not isinstance(phases, list):
        return 0
    return sum(
        len(phase["subtasks"])
        for phase in phases
        if isinstance(phase, dict) and isinstance(phase.get("subtasks"), list)
    )


# --------------------------------------------------------------------------- #
# Everywhere the plan could be
# --------------------------------------------------------------------------- #


def candidate_files(spec_dir: Path, project_dir: Path | None) -> list[Path]:
    """The files to look in, most-proving first.

    The spec directory is searched before the project root because a file there
    is one the model aimed at; a file at the root is one a relative path landed
    on. The two directories are not searched for the same names — see
    `_INVENTED_NAMES`.
    """
    seen: set[Path] = set()
    files: list[Path] = []
    directories: list[tuple[Path, tuple[str, ...]]] = [
        (spec_dir, (*_ASKED_FOR_NAMES, *_INVENTED_NAMES))
    ]
    if project_dir is not None and not _same_path(project_dir, spec_dir):
        directories.append((project_dir, _ASKED_FOR_NAMES))

    for directory, names in directories:
        for name in names:
            path = directory / name
            try:
                resolved = path.resolve()
            except OSError:
                resolved = path
            if resolved in seen:
                continue
            seen.add(resolved)
            if path.is_file():
                files.append(path)
    return files


def recover_plan(
    spec_dir: Path,
    project_dir: Path | None = None,
    response_text: str | None = None,
) -> RecoveredPlan | None:
    """Find a plan the model produced, wherever and in whatever shape.

    Returns ``None`` when nothing anywhere carries a subtask — which is the
    point at which "the model did not produce a valid plan" is a true sentence.
    Never raises: this runs on a build that has already failed validation, and
    an unreadable candidate is one fewer candidate, not a second failure.
    """
    spec_dir = Path(spec_dir)
    plan_path = spec_dir / "implementation_plan.json"

    for path in candidate_files(spec_dir, project_dir):
        try:
            document = extract_json_document(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError) as exc:
            logger.debug("plan candidate unreadable (%s): %s", path, exc)
            continue
        plan = normalize_plan_shape(document)
        if plan is None:
            continue
        same_file = _same_path(path, plan_path)
        return RecoveredPlan(
            plan=plan,
            origin=("its own shape" if same_file else str(path)),
            source_file=None if same_file else path,
            subtask_count=count_subtasks(plan),
        )

    if response_text:
        plan = normalize_plan_shape(extract_json_document(response_text))
        if plan is not None:
            return RecoveredPlan(
                plan=plan,
                origin="the planner's response",
                source_file=None,
                subtask_count=count_subtasks(plan),
            )
    return None


def _same_path(left: Path, right: Path) -> bool:
    try:
        return left.resolve() == right.resolve()
    except OSError:
        return left == right


def write_recovered_plan(spec_dir: Path, recovered: RecoveredPlan) -> bool:
    """Write the recovered plan to the one path WorkPilot reads.

    Merged *over* whatever is already there, so the status bookkeeping the
    frontend keeps in this file (`persistPlanStatusAndReasonSync` creates it
    before the plan exists) survives a plan arriving underneath it. Removes the
    file it was promoted from when that file is outside the spec directory —
    leaving `implementation_plan.json` at the worktree root is what
    `_cleanup_stray_root_plan` exists to prevent, and a copy of the real plan is
    worse than a truncated one: it is the file a later read could pick up.
    """
    from core.file_utils import write_json_atomic

    spec_dir = Path(spec_dir)
    plan_path = spec_dir / "implementation_plan.json"

    merged: dict[str, Any] = {}
    try:
        existing = json.loads(plan_path.read_text(encoding="utf-8"))
        if isinstance(existing, dict):
            merged = {k: v for k, v in existing.items() if k in _SHELL_KEYS}
    except (OSError, ValueError, UnicodeDecodeError):
        merged = {}
    merged.update(recovered.plan)

    try:
        write_json_atomic(plan_path, merged, indent=2, ensure_ascii=False)
    except OSError as exc:
        logger.warning("could not write the recovered plan to %s: %s", plan_path, exc)
        return False

    if recovered.source_file is not None:
        try:
            recovered.source_file.unlink()
        except OSError:
            # The promotion is what mattered; a leftover copy is cosmetic.
            pass
    return True
