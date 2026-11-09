"""Walk an implementation plan over a snapshot and report what would break.

The walk follows the order the build follows: phases after the phases they
depend on, subtasks in the order they are written. Each file a subtask creates
is added to the snapshot, so a later subtask may modify it; a file modified
before anything creates it is the classic plan bug this catches. Everything is
reported as findings with a stable ``code`` and ``params``: the desktop app
translates them, the English text below is only for logs and the CLI.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any

from . import api_mocks
from .snapshot import Snapshot, normalise_plan_path
from .toolchains import check_command

ERROR = "error"
WARNING = "warning"
INFO = "info"

MESSAGES: dict[str, str] = {
    "plan_empty": "The plan has no subtask to run.",
    "plan_unreadable": "implementation_plan.json cannot be read: {reason}",
    "phase_unknown_dependency": "Phase {phase} depends on phase {dependency}, which the plan does not define.",
    "phase_cycle": "Phases {phases} depend on each other: none of them can start.",
    "subtask_duplicate_id": "Subtask id {id} is used more than once.",
    "path_outside_project": "{path} is outside the project.",
    "file_missing": "{path} is modified but exists neither in {ref} nor in an earlier subtask.",
    "file_modified_before_created": "{path} is modified before subtask {creator} creates it.",
    "file_created_by_unrelated_phase": "{path} comes from phase {phase}, which this phase does not depend on: it breaks if phases run in parallel.",
    "file_already_exists": "{path} already exists in {ref}: creating it overwrites it.",
    "file_created_twice": "{path} is already created by subtask {creator}.",
    "path_is_directory": "{path} is a folder, not a file.",
    "pattern_missing": "Pattern file {path} does not exist.",
    "parallel_conflict": "{path} is also changed by subtask {other} in the same parallel phase.",
    "binary_file": "{path} is a binary file: it has no diff preview.",
    "no_files": "This subtask names no file.",
    "no_verification": "This subtask has no verification.",
    "command_dir_missing": "The verification enters {dir}, which does not exist.",
    "command_manifest_missing": "`{command}` needs {manifest}, which the project does not have.",
    "command_script_missing": '{manifest} has no "{script}" script.',
    "api_status_undeclared": "The contract does not declare this status for {method} {url}.",
    "api_endpoint_undeclared": "No contract of the project describes {method} {url}.",
    "api_no_contract": "The project has no OpenAPI contract: {method} {url} is answered with an empty mock.",
    "timeout": "The rehearsal stopped after {seconds} s: the remaining subtasks were not checked.",
}

_BINARY_SUFFIXES = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".icns",
    ".bmp",
    ".tif",
    ".tiff",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    ".pdf",
    ".zip",
    ".gz",
    ".tar",
    ".7z",
    ".jar",
    ".dll",
    ".exe",
    ".so",
    ".dylib",
    ".mp3",
    ".mp4",
    ".wav",
    ".mov",
    ".psd",
}


@dataclass(frozen=True)
class Finding:
    level: str
    code: str
    params: dict[str, Any] = field(default_factory=dict)

    @property
    def message(self) -> str:
        template = MESSAGES.get(self.code, self.code)
        try:
            return template.format(**self.params)
        except (KeyError, IndexError):
            return template

    def to_dict(self) -> dict[str, Any]:
        return {
            "level": self.level,
            "code": self.code,
            "params": self.params,
            "message": self.message,
        }


@dataclass
class StepReport:
    index: int
    subtask_id: str
    phase: str
    description: str
    status: str = "success"
    findings: list[Finding] = field(default_factory=list)
    mocks: list[api_mocks.MockResult] = field(default_factory=list)
    files_created: list[str] = field(default_factory=list)
    files_modified: list[str] = field(default_factory=list)
    duration_ms: int = 0

    def settle(self) -> None:
        levels = {finding.level for finding in self.findings}
        if self.status == "skipped":
            return
        self.status = (
            "error"
            if ERROR in levels
            else "warning"
            if WARNING in levels
            else "success"
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "subtaskId": self.subtask_id,
            "phase": self.phase,
            "description": self.description,
            "status": self.status,
            "durationMs": self.duration_ms,
            "tokensUsed": 0,
            "mockApiCalls": [mock.to_dict() for mock in self.mocks],
            "warnings": [f.message for f in self.findings if f.level == WARNING],
            "errors": [f.message for f in self.findings if f.level == ERROR],
            "findings": [f.to_dict() for f in self.findings],
            "filesCreated": self.files_created,
            "filesModified": self.files_modified,
        }


@dataclass
class Rehearsal:
    plan_findings: list[Finding]
    steps: list[StepReport]
    created: dict[str, str]  # path -> subtask id
    modified: dict[str, str]
    partial: bool


def _phase_key(raw: dict[str, Any], position: int) -> int:
    value = raw.get("phase")
    return value if isinstance(value, int) else position + 1


def _order_phases(
    phases: list[dict[str, Any]], findings: list[Finding]
) -> tuple[list[tuple[int, dict[str, Any]]], dict[int, set[int]]]:
    """Phases in run order, and each phase's transitive dependencies."""
    keyed = [(_phase_key(raw, i), raw) for i, raw in enumerate(phases)]
    known = {key for key, _ in keyed}
    direct: dict[int, set[int]] = {}
    for key, raw in keyed:
        deps = set()
        for dep in raw.get("depends_on") or []:
            if dep in known:
                deps.add(dep)
            else:
                findings.append(
                    Finding(
                        ERROR,
                        "phase_unknown_dependency",
                        {"phase": key, "dependency": dep},
                    )
                )
        direct[key] = deps

    ordered: list[tuple[int, dict[str, Any]]] = []
    done: set[int] = set()
    pending = list(keyed)
    while pending:
        ready = [(k, r) for k, r in pending if direct[k] <= done]
        if not ready:
            stuck = sorted(k for k, _ in pending)
            findings.append(
                Finding(ERROR, "phase_cycle", {"phases": ", ".join(map(str, stuck))})
            )
            ordered.extend(pending)  # still walked, in written order
            break
        first = ready[0]  # keep the written order among ready phases
        ordered.append(first)
        done.add(first[0])
        pending.remove(first)

    closure: dict[int, set[int]] = {}

    def deps_of(key: int, seen: frozenset[int] = frozenset()) -> set[int]:
        if key in closure:
            return closure[key]
        result: set[int] = set()
        for dep in direct.get(key, set()):
            if dep in seen:
                continue
            result.add(dep)
            result |= deps_of(dep, seen | {key})
        closure[key] = result
        return result

    for key in known:
        deps_of(key)
    return ordered, closure


def _paths(raw: Any) -> list[str]:
    return (
        [item for item in raw if isinstance(item, str)] if isinstance(raw, list) else []
    )


def _checked_paths(raw: Any, step: StepReport) -> list[str]:
    """The plan paths of a list, normalised; the ones outside the repo are findings."""
    kept: list[str] = []
    for raw_path in _paths(raw):
        norm = normalise_plan_path(raw_path)
        if norm is None:
            step.findings.append(
                Finding(ERROR, "path_outside_project", {"path": raw_path})
            )
            continue
        if PurePosixPath(norm).suffix.lower() in _BINARY_SUFFIXES:
            step.findings.append(Finding(INFO, "binary_file", {"path": norm}))
        kept.append(norm)
    return kept


def rehearse(
    plan: dict[str, Any],
    snapshot: Snapshot,
    read_tracked: Callable[[str], str | None],
    contracts: api_mocks.ContractIndex,
    deadline: float | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> Rehearsal:
    plan_findings: list[Finding] = []
    phases = [p for p in plan.get("phases") or [] if isinstance(p, dict)]
    ordered, depends = _order_phases(phases, plan_findings)

    tracked = set(snapshot.files)
    created: dict[str, tuple[str, int]] = {}  # path -> (subtask id, phase)
    modified: dict[str, str] = {}
    seen_ids: set[str] = set()
    steps: list[StepReport] = []
    partial = False

    # Which subtask creates each file, over the whole plan: lets a premature
    # modification name the subtask it should have waited for.
    future_creator: dict[str, str] = {}
    for _key, raw in ordered:
        for sub in raw.get("subtasks") or raw.get("chunks") or []:
            if isinstance(sub, dict):
                for path in _paths(sub.get("files_to_create")):
                    norm = normalise_plan_path(path)
                    if norm:
                        future_creator.setdefault(norm, str(sub.get("id", "?")))

    for key, raw in ordered:
        subtasks = [
            s
            for s in raw.get("subtasks") or raw.get("chunks") or []
            if isinstance(s, dict)
        ]
        phase_name = str(raw.get("name") or f"Phase {key}")
        touched_in_phase: dict[str, str] = {}
        for sub in subtasks:
            sub_id = str(sub.get("id") or f"{key}.{len(steps) + 1}")
            step = StepReport(
                index=len(steps) + 1,
                subtask_id=sub_id,
                phase=phase_name,
                description=str(sub.get("description") or sub_id),
            )
            steps.append(step)
            if deadline is not None and clock() > deadline:
                step.status = "skipped"
                partial = True
                continue
            started = clock()
            if sub_id in seen_ids:
                plan_findings.append(
                    Finding(WARNING, "subtask_duplicate_id", {"id": sub_id})
                )
            seen_ids.add(sub_id)

            to_modify = _checked_paths(sub.get("files_to_modify"), step)
            to_create = _checked_paths(sub.get("files_to_create"), step)

            for path in to_modify:
                if snapshot.is_directory(path) and not snapshot.exists(path):
                    step.findings.append(
                        Finding(WARNING, "path_is_directory", {"path": path})
                    )
                elif path in created:
                    creator, phase = created[path]
                    if phase != key and phase not in depends.get(key, set()):
                        step.findings.append(
                            Finding(
                                WARNING,
                                "file_created_by_unrelated_phase",
                                {"path": path, "phase": phase},
                            )
                        )
                elif path not in tracked:
                    if path in future_creator:
                        step.findings.append(
                            Finding(
                                ERROR,
                                "file_modified_before_created",
                                {"path": path, "creator": future_creator[path]},
                            )
                        )
                    else:
                        step.findings.append(
                            Finding(
                                ERROR,
                                "file_missing",
                                {"path": path, "ref": snapshot.ref},
                            )
                        )
                modified.setdefault(path, sub_id)
                step.files_modified.append(path)

            for path in to_create:
                if path in created:
                    step.findings.append(
                        Finding(
                            WARNING,
                            "file_created_twice",
                            {"path": path, "creator": created[path][0]},
                        )
                    )
                elif path in tracked:
                    step.findings.append(
                        Finding(
                            WARNING,
                            "file_already_exists",
                            {"path": path, "ref": snapshot.ref},
                        )
                    )
                created.setdefault(path, (sub_id, key))
                snapshot.add(path)
                step.files_created.append(path)

            for path in _paths(sub.get("patterns_from")):
                norm = normalise_plan_path(path)
                if (
                    norm
                    and not snapshot.exists(norm)
                    and not snapshot.is_directory(norm)
                ):
                    step.findings.append(
                        Finding(WARNING, "pattern_missing", {"path": norm})
                    )

            if raw.get("parallel_safe"):
                for path in [*to_modify, *to_create]:
                    other = touched_in_phase.get(path)
                    if other and other != sub_id:
                        step.findings.append(
                            Finding(
                                WARNING,
                                "parallel_conflict",
                                {"path": path, "other": other},
                            )
                        )
                    touched_in_phase.setdefault(path, sub_id)

            if not to_modify and not to_create and not sub.get("expected_output"):
                step.findings.append(Finding(INFO, "no_files"))

            _check_verification(
                sub.get("verification"), step, snapshot, read_tracked, contracts
            )
            step.duration_ms = int((clock() - started) * 1000)

    if not steps:
        plan_findings.append(Finding(ERROR, "plan_empty"))
    for step in steps:
        step.settle()
    return Rehearsal(
        plan_findings=plan_findings,
        steps=steps,
        created={path: owner for path, (owner, _phase) in created.items()},
        modified=modified,
        partial=partial,
    )


def _check_verification(
    verification: Any,
    step: StepReport,
    snapshot: Snapshot,
    read_tracked: Callable[[str], str | None],
    contracts: api_mocks.ContractIndex,
) -> None:
    if not isinstance(verification, dict):
        step.findings.append(Finding(INFO, "no_verification"))
        return
    kind = str(verification.get("type") or "")
    command = verification.get("run") or verification.get("command")
    if isinstance(command, str) and command.strip():
        for found in check_command(command, snapshot, read_tracked):
            step.findings.append(Finding(WARNING, found.code, dict(found.params)))
    if kind == "api" and isinstance(verification.get("url"), str):
        status = verification.get("expect_status")
        result = api_mocks.mock(
            contracts,
            str(verification.get("method") or "GET"),
            verification["url"],
            status if isinstance(status, int) else None,
        )
        step.mocks.append(result)
        if result.finding:
            level = INFO if result.finding == "api_no_contract" else WARNING
            if result.contract and result.contract in (
                step.files_modified + step.files_created
            ):
                level = INFO  # the subtask updates that contract itself
            if result.finding == "api_endpoint_undeclared" and any(
                c in step.files_modified + step.files_created
                for c in contracts.contracts
            ):
                level = INFO
            step.findings.append(
                Finding(
                    level, result.finding, {"method": result.method, "url": result.url}
                )
            )
