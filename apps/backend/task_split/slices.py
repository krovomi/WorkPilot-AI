"""Cut a plan into slices that each fit one small pull request.

Pure: a plan (the ``implementation_plan.json`` dict) and a policy in, slices
out. Nothing here reads a file, a provider or a language: what a slice weighs
is what the plan says it will change, so the cut is the same with every model
and every stack.

**Weight.** A subtask weighs the lines a person will have to review
(``review_load``): its ``estimated_lines`` when the planner gave a whole
number, otherwise a count from the files it names (a created file weighs more
than a modified one), each weighed by the kind of its files (code 1, tests
and docs half, generated files and lockfiles nothing). A phase weighs its
subtasks, and touches the union of their files that a person reviews.

**Units.** A phase is the smallest unit the cut keeps whole, because its
subtasks were planned to land together. A phase heavier than the ceiling on
its own is cut into runs of consecutive subtasks, each run waiting for the one
before.

**Packing.** Units are packed in plan order while the slice stays under both
ceilings. A phase the planner labelled with a ``slice`` name keeps company
only with phases of the same label (or none): the planner knows which phases
make sense to review together, and the ceilings still hold.

**Order.** A phase without ``depends_on`` is read as depending on the one
before it, and an integration or test phase as depending on every earlier
one: a declared ``depends_on: []`` is the only way to be independent, so a
plan that says nothing never yields a card built without the code it needs.
The slices that depend on others, or that others depend on, form one chain in
plan order (each one ``after`` the previous); an independent slice has no
``after`` and starts from the trunk at once.
"""

from __future__ import annotations

import copy
import math
from dataclasses import dataclass, field

from .policy import SplitPolicy
from .review_load import file_weight

__all__ = [
    "LINES_PER_EMPTY_SUBTASK",
    "LINES_PER_MODIFIED_FILE",
    "LINES_PER_NEW_FILE",
    "MAX_SLICES",
    "Slice",
    "plan_slices",
    "subtask_lines",
]

LINES_PER_NEW_FILE = 80
LINES_PER_MODIFIED_FILE = 30
LINES_PER_EMPTY_SUBTASK = 20
#: More cards than this is a board nobody follows: the ceiling is raised until
#: the plan fits in this many slices.
MAX_SLICES = 10
_ESTIMATE_MAX = 100_000
_AFTER_ALL = {"integration", "verification", "test", "testing", "qa"}


def _files(subtask: dict, key: str) -> list[str]:
    value = subtask.get(key)
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, dict):
            item = item.get("path") or item.get("file")
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
    return out


def subtask_lines(subtask: dict) -> int:
    """The lines of a subtask a person will have to review."""
    created = _files(subtask, "files_to_create")
    modified = _files(subtask, "files_to_modify")
    estimate = subtask.get("estimated_lines")
    if (
        isinstance(estimate, int)
        and not isinstance(estimate, bool)
        and 0 < estimate <= _ESTIMATE_MAX
    ):
        named = created + modified
        if not named:
            return estimate
        factor = sum(file_weight(f) for f in named) / len(named)
        return math.ceil(estimate * factor)
    if not created and not modified:
        return LINES_PER_EMPTY_SUBTASK
    load = sum(LINES_PER_NEW_FILE * file_weight(f) for f in created) + sum(
        LINES_PER_MODIFIED_FILE * file_weight(f) for f in modified
    )
    return math.ceil(load)


def _subtask_files(subtask: dict) -> set[str]:
    """The files of a subtask a person reviews (generated ones aside)."""
    named = set(_files(subtask, "files_to_create")) | set(
        _files(subtask, "files_to_modify")
    )
    return {f for f in named if file_weight(f) > 0}


@dataclass
class _Unit:
    key: str
    phase: dict
    label: str | None
    lines: int
    files: set[str]
    deps: set[str]


@dataclass
class Slice:
    """One future card: the phases it builds and the slice it waits for."""

    index: int
    phases: list[dict]
    lines: int
    files: list[str]
    label: str | None = None
    #: Index of the slice this one is built on, or None (starts from trunk).
    after: int | None = None
    depends_on: list[int] = field(default_factory=list)

    @property
    def name(self) -> str:
        if self.label:
            return self.label
        names = [str(p.get("name") or "").strip() for p in self.phases]
        names = [n for n in names if n]
        if not names:
            return f"Part {self.index}"
        return names[0] if len(names) == 1 else f"{names[0]} (+{len(names) - 1})"


def _phase_key(phase: dict, position: int) -> str:
    for key in ("id", "phase"):
        value = phase.get(key)
        if isinstance(value, (str, int)) and not isinstance(value, bool):
            if str(value).strip():
                return str(value).strip()
    return f"#{position}"


def _units(phases: list[dict], policy: SplitPolicy) -> list[_Unit]:
    keys = [_phase_key(p, i + 1) for i, p in enumerate(phases)]
    units: list[_Unit] = []
    for position, phase in enumerate(phases):
        key = keys[position]
        earlier = set(keys[:position])
        declared = phase.get("depends_on")
        if str(phase.get("type") or "").strip().lower() in _AFTER_ALL:
            deps = set(earlier)
        elif isinstance(declared, list):
            deps = set()
            for dep in declared:
                ref = str(dep).strip()
                # An unknown reference is read as "everything before", not
                # dropped: a dependency the cut cannot place is not a licence
                # to start without it.
                deps |= {ref} if ref in earlier else set(earlier)
        else:
            deps = {keys[position - 1]} if position > 0 else set()
        label = phase.get("slice")
        label = label.strip()[:80] if isinstance(label, str) and label.strip() else None
        subtasks = [s for s in phase.get("subtasks") or [] if isinstance(s, dict)]
        weights = [subtask_lines(s) for s in subtasks]
        files = [_subtask_files(s) for s in subtasks]
        total = sum(weights)
        touched = set().union(*files) if files else set()
        if (total <= policy.max_lines and len(touched) <= policy.max_files) or len(
            subtasks
        ) <= 1:
            units.append(_Unit(key, phase, label, total, touched, deps))
            continue
        # Too heavy alone: runs of consecutive subtasks, each after the last.
        runs: list[list[int]] = [[]]
        run_lines = 0
        run_files: set[str] = set()
        for i, (weight, owned) in enumerate(zip(weights, files, strict=True)):
            if runs[-1] and (
                run_lines + weight > policy.max_lines
                or len(run_files | owned) > policy.max_files
            ):
                runs.append([])
                run_lines, run_files = 0, set()
            runs[-1].append(i)
            run_lines += weight
            run_files |= owned
        previous: str | None = None
        for number, run in enumerate(runs, start=1):
            part = copy.deepcopy(phase)
            part["subtasks"] = [copy.deepcopy(subtasks[i]) for i in run]
            part.pop("chunks", None)
            if part.get("name"):
                part["name"] = f"{part['name']} ({number}/{len(runs)})"
            unit_key = f"{key}#{number}"
            units.append(
                _Unit(
                    unit_key,
                    part,
                    label,
                    sum(weights[i] for i in run),
                    set().union(*(files[i] for i in run)),
                    {previous} if previous else set(deps),
                )
            )
            previous = unit_key
        # Whatever depended on the phase depends on its last run.
        for later in phases[position + 1 :]:
            refs = later.get("depends_on")
            if isinstance(refs, list) and key in {str(r).strip() for r in refs}:
                later["depends_on"] = [
                    previous if str(r).strip() == key else r for r in refs
                ]
        keys[position] = previous or key
    return units


def _pack(units: list[_Unit], max_lines: int, max_files: int) -> list[list[_Unit]]:
    packs: list[list[_Unit]] = []
    lines = 0
    files: set[str] = set()
    label: str | None = None
    for unit in units:
        if packs:
            fits = (
                lines + unit.lines <= max_lines and len(files | unit.files) <= max_files
            )
            same = unit.label is None or label is None or unit.label == label
            if fits and same:
                packs[-1].append(unit)
                lines += unit.lines
                files |= unit.files
                label = label or unit.label
                continue
        packs.append([unit])
        lines, files, label = unit.lines, set(unit.files), unit.label
    return packs


def plan_slices(plan: dict, policy: SplitPolicy) -> list[Slice] | None:
    """The slices of ``plan``, or None when it stays one card."""
    if not policy.enabled or not isinstance(plan, dict):
        return None
    raw = plan.get("phases")
    if not isinstance(raw, list):
        return None
    phases = [copy.deepcopy(p) for p in raw if isinstance(p, dict)]
    if not phases:
        return None
    for phase in phases:
        for subtask in phase.get("subtasks") or []:
            status = subtask.get("status") if isinstance(subtask, dict) else None
            if status not in (None, "", "pending"):
                return None  # the build has started: its branch already exists
    units = _units(phases, policy)
    max_lines, max_files = policy.max_lines, policy.max_files
    packs = _pack(units, max_lines, max_files)
    while len(packs) > MAX_SLICES:
        max_lines, max_files = max_lines * 2, max_files * 2
        packs = _pack(units, max_lines, max_files)
    if len(packs) <= 1:
        return None

    where = {unit.key: n for n, pack in enumerate(packs, start=1) for unit in pack}
    slices: list[Slice] = []
    for n, pack in enumerate(packs, start=1):
        deps = {where[d] for unit in pack for d in unit.deps if d in where} - {n}
        files = sorted(set().union(*(u.files for u in pack)))
        label = next((u.label for u in pack if u.label), None)
        slices.append(
            Slice(
                index=n,
                phases=[u.phase for u in pack],
                lines=sum(u.lines for u in pack),
                files=files,
                label=label,
                depends_on=sorted(deps),
            )
        )
    linked = {s.index for s in slices if s.depends_on} | {
        d for s in slices for d in s.depends_on
    }
    previous: int | None = None
    for item in slices:
        if item.index in linked:
            item.after = previous
            previous = item.index
    return slices
