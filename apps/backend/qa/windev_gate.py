"""The WinDev integrity check as a QA gate: what only the editor writes stays the editor's.

Run once the reviewer has approved, with the other gates that can overturn an
approval (`qa/loop.py`). Each WinDev file of the change set is compared with
its version at the task's base (`windev.integrity`): a binary element
modified, an element created or deleted, an ``internal_properties`` or
``identifier`` value invented or gone, a duplicated ``procedure_id``, a file
that no longer parses. Every finding is a fact read from both versions, so
every finding rejects the pass: the fixer gets a `QA_FIX_REQUEST.md` saying
what to put back. A project with no WinDev file in the change set is not
concerned, and a change set git could not read is recorded as unchecked,
never as a pass.

It writes `windev_integrity.json` on every run where WinDev files changed.
No model and no network: the same answer on every provider.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

from foundation.change_scope import ChangeScope
from foundation.debug import debug, debug_warning
from foundation.git_executable import get_git_executable, get_isolated_git_env
from windev.files import is_windev_path
from windev.integrity import FileChange, IntegrityReport, check_changes

__all__ = [
    "ISSUE_TYPE",
    "RECORD",
    "render_fix_request",
    "windev_changes",
    "windev_gate",
    "windev_only",
]

ISSUE_TYPE = "windev_integrity"
RECORD = "windev_integrity.json"
#: Larger WinDev files exist (a big window), but not past this.
_MAX_BYTES = 32 * 1024 * 1024

_ADVICE = {
    "binary-element": "Put the file back exactly as it was: `git checkout {base} -- {path}`.",
    "element-created": (
        "Delete this file. If the task needs a new element, add a subtask "
        "`À faire dans l'éditeur WinDev :` saying how to create it in the editor."
    ),
    "element-deleted": (
        "Restore it (`git checkout {base} -- {path}`): an element is deleted in "
        "the editor, which removes it from the project."
    ),
    "header": "Restore the first lines of the file exactly as they were.",
    "info": "Restore the `info` block exactly as it was.",
    "internal_properties-written": (
        "Remove the `internal_properties` lines you wrote: only the editor "
        "produces them. Change code blocks only."
    ),
    "internal_properties-removed": (
        "Restore the `internal_properties` lines exactly as they were, with the "
        "control or element they belong to."
    ),
    "identifier-written": (
        "Remove the `identifier` lines you wrote: a control or an element is "
        "created in the editor."
    ),
    "identifier-removed": (
        "Restore the control or element you removed, with its `identifier`, "
        "exactly as it was."
    ),
    "procedure_id": (
        "Give each new procedure its own numeric `procedure_id`, different from "
        "every other one in the file; never change an existing one."
    ),
    "yaml": (
        "Fix the indentation: every line of a `code : |1+` block is indented one "
        "space deeper than the `code` key."
    ),
}


def _git_blob(root: Path, base: str, relative: str) -> tuple[bool, bytes | None]:
    """Whether git could answer, and the file's bytes at ``base`` (None: absent).

    Bytes, not text: a native element is compressed binary, and a decoded copy
    would differ from the file on disk.
    """
    git, env = get_git_executable(), get_isolated_git_env()
    try:
        listed = subprocess.run(
            [git, "ls-tree", "--name-only", base, "--", relative],
            cwd=root,
            capture_output=True,
            timeout=30,
            env=env,
        )
        if listed.returncode != 0:
            return False, None
        if not listed.stdout.strip():
            return True, None
        blob = subprocess.run(
            [git, "cat-file", "blob", f"{base}:{relative}"],
            cwd=root,
            capture_output=True,
            timeout=60,
            env=env,
        )
    except (OSError, subprocess.SubprocessError):
        return False, None
    if blob.returncode != 0 or len(blob.stdout) > _MAX_BYTES:
        return False, None
    return True, blob.stdout


def _disk(root: Path, relative: str) -> tuple[bool, bytes | None]:
    """Whether the path is safe to read, and its bytes now (None: absent)."""
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        return False, None
    if not path.is_file():
        return True, None
    try:
        if path.stat().st_size > _MAX_BYTES:
            return False, None
        return True, path.read_bytes()
    except OSError:
        return False, None


def windev_changes(
    project_dir: Path, files: tuple[str, ...] | list[str], base: str
) -> tuple[list[FileChange], list[str]]:
    """The WinDev files among ``files`` before and after, and the unreadable ones."""
    root = Path(project_dir).resolve()
    changes: list[FileChange] = []
    unreadable: list[str] = []
    seen: set[str] = set()
    for raw in files:
        relative = str(raw).replace("\\", "/").lstrip("/")
        # change_scope lists a binary diff a second time with this suffix.
        relative = relative.removesuffix(".binary")
        if (
            not relative
            or relative in seen
            or ".." in relative.split("/")
            or not is_windev_path(relative)
        ):
            continue
        seen.add(relative)
        known, before = _git_blob(root, base, relative)
        safe, after = _disk(root, relative)
        if not known or not safe:
            unreadable.append(relative)
            continue
        changes.append(FileChange(relative, before, after))
    return changes, unreadable


def render_fix_request(report: IntegrityReport, base: str) -> str:
    """`QA_FIX_REQUEST.md` for the WinDev files the editor would no longer open."""
    lines = [
        "# QA Fix Request — WinDev element written outside the editor",
        "",
        "**Status**: REJECTED (WinDev integrity)",
        f"**Date**: {datetime.now(UTC).isoformat(timespec='seconds')}",
        "",
        "These WinDev files were changed in a way only the WinDev editor can",
        "produce. As they are, the editor may refuse to open the project.",
        "Change WLangage only inside the `code : |1+` / `code : |1-` blocks.",
        "",
        "## To fix (blocking)",
        "",
    ]
    for n, problem in enumerate(report.problems, start=1):
        advice = _ADVICE.get(problem.rule, "").format(base=base, path=problem.path)
        lines.append(f"{n}. `{problem.path}`: {problem.detail}. {advice}".rstrip())
    lines += [
        "",
        "Do not delete a file, a control or a procedure to make this check pass.",
        "What the task needs from the editor goes in the report, under",
        "`À faire dans l'éditeur WinDev`.",
        "",
    ]
    return "\n".join(lines)


def _issues(report: IntegrityReport) -> list[dict]:
    return [
        {
            "title": "WinDev element written outside the editor",
            "description": f"{p.path}: {p.detail}",
            "type": ISSUE_TYPE,
        }
        for p in report.problems
    ]


def _write_record(
    spec_dir: Path, report: IntegrityReport, unchecked: list[str], base: str
) -> None:
    record = {
        "status": "fail" if report.problems else "unknown" if unchecked else "ok",
        "base": base,
        "checked": report.checked,
        "unchecked": unchecked,
        "codeLinesChanged": report.code_lines_changed,
        "problems": [asdict(p) for p in report.problems],
    }
    spec_dir.mkdir(parents=True, exist_ok=True)
    (spec_dir / RECORD).write_text(
        json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def _mark_signoff_rejected(spec_dir: Path, issues: list[dict]) -> None:
    """The reviewer wrote "approved"; a later run must not read that and stop."""
    from .criteria import load_implementation_plan, save_implementation_plan

    plan = load_implementation_plan(spec_dir)
    if not plan:
        return
    signoff = plan.get("qa_signoff")
    signoff = signoff if isinstance(signoff, dict) else {}
    kept = [
        i
        for i in signoff.get("issues_found") or []
        if not (isinstance(i, dict) and i.get("type") == ISSUE_TYPE)
    ]
    signoff.update(
        status="rejected", ready_for_qa_revalidation=False, issues_found=kept + issues
    )
    plan["qa_signoff"] = signoff
    save_implementation_plan(spec_dir, plan)


def _say(report: IntegrityReport, unchecked: list[str], task_logger=None) -> None:
    if not report.problems and not unchecked:
        return
    lines = [f"  ✗ {p.path}: {p.detail}" for p in report.problems]
    lines += [f"  ? {path}: could not be read, not checked" for path in unchecked]
    message = "🧩 WinDev integrity:\n" + "\n".join(lines)
    if task_logger is None:
        print("\n" + message)
        return
    from task_logger import LogEntryType, LogPhase

    kind = LogEntryType.ERROR if report.problems else LogEntryType.WARNING
    task_logger.log(message, kind, LogPhase.VALIDATION)


def windev_only(review_scope: ChangeScope | None) -> bool:
    """Whether every code file of the change set is a WinDev file.

    Then no coverage can be measured: the WinDev test scenarios run in the
    editor only, so the coverage gate has nothing to demand.
    """
    if review_scope is None:
        return False
    code = [f.removesuffix(".binary") for f in review_scope.code_files]
    return bool(code) and all(is_windev_path(f) for f in code)


def windev_gate(
    spec_dir: Path,
    project_dir: Path,
    qa_iteration: int,
    review_scope: ChangeScope | None,
    *,
    task_logger=None,
) -> tuple[list[dict], str] | None:
    """The issues and verdict of a rejection, or None. Never raises."""
    spec_dir = Path(spec_dir)
    if review_scope is None or not review_scope.base:
        debug("qa_loop", "WinDev integrity not checked: the change set is unknown")
        return None
    if not any(is_windev_path(f.removesuffix(".binary")) for f in review_scope.files):
        return None
    base = review_scope.base
    try:
        changes, unchecked = windev_changes(project_dir, review_scope.files, base)
        report = check_changes(changes)
        _write_record(spec_dir, report, unchecked, base)
    except (OSError, ValueError) as exc:
        debug_warning("qa_loop", f"WinDev integrity skipped (non-blocking): {exc}")
        return None
    _say(report, unchecked, task_logger)
    if report.ok:
        debug("qa_loop", "WinDev integrity", checked=len(report.checked))
        return None
    issues = _issues(report)
    try:
        (spec_dir / "QA_FIX_REQUEST.md").write_text(
            render_fix_request(report, base), encoding="utf-8"
        )
        _mark_signoff_rejected(spec_dir, issues)
    except OSError as exc:
        debug_warning(
            "qa_loop", f"WinDev integrity could not write the fix request: {exc}"
        )
    return issues, (
        f"QA pass #{qa_iteration} rejected: {len(issues)} WinDev change(s) only "
        "the editor can make"
    )
