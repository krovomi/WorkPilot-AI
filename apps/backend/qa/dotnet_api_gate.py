"""The public API of a .NET task's libraries in QA: what a consumer would lose.

Run once the reviewer has approved, with the other gates that can overturn an
approval (`qa/loop.py`). For a task whose change set touches .NET (sources,
project files, ``Directory.Build.*``, ``global.json``), each library project
it reaches is built twice, each time in a disposable copy (never the task's
worktree): at the task's base commit and as QA reviewed it. REA then pairs the
two assemblies' members without loading either (`rea.managed_api`). The base
builds are kept under ``<spec_dir>/dotnet-api/base/<sha>/``, so a second QA
pass rebuilds only the task's side. It writes ``dotnet_public_api.json`` on
every run: the record the hard gate ``public-api-stable`` reads.

Building runs the project's MSBuild, as the reviewer's own ``dotnet build``
does, with the backend's environment stripped of its credentials
(`security.child_env`).

When it blocks, by ``WORKPILOT_QA_DOTNET_API``:

- ``warn`` (the default): never; a public member removed, hidden, renamed or
  whose signature changed is printed and logged. Only an REA already installed
  at the pinned version runs, and nothing is built without it: QA does not
  download a tool on its own;
- ``strict``: a break rejects the pass, and the fixer gets a
  `QA_FIX_REQUEST.md` listing each member. npx may fetch the pinned release,
  except under strict offline mode;
- ``off``: never runs; the record says so and the hard gate reads it as
  unknown.

A .NET migration the preflight staged (`dotnet_upgrade`, one hop or a chain),
or a workflow that declares the hard gate ``public-api-stable``, runs it
``strict`` unless the variable is ``off``: moving a library to the next
release must not change what its consumers call. A value that is none of these
reads as ``warn``. A build that fails, a missing SDK, a member REA could not
pair: ``unchecked``, never a pass, and never a block.
"""

from __future__ import annotations

import os
import re
import subprocess
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from foundation.change_scope import ChangeScope
from foundation.debug import debug, debug_warning
from foundation.git_executable import run_git
from foundation.platform import find_executable
from mutation_gate.sandbox import scratch_copy
from offline_policy import airgap_status
from rea import locate
from rea.dotnet_api import (
    FAIL,
    MAX_PROJECTS,
    NONE,
    UNCHECKED,
    ApiReport,
    DotnetBuilder,
    ProjectOutputs,
    affected_projects,
    cached_outputs,
    compare_outputs,
    dotnet_files,
    projects_in,
    store_outputs,
    write_record,
)
from rea.locate import ReaUnavailable
from rea.runner import run_rea
from security.untrusted import quote_untrusted

__all__ = [
    "DOTNET_API_ENV",
    "GATE_NAME",
    "ISSUE_TYPE",
    "TIMEOUT_ENV",
    "check",
    "dotnet_api_gate",
    "gate_mode",
    "render_fix_request",
]

DOTNET_API_ENV = "WORKPILOT_QA_DOTNET_API"
TIMEOUT_ENV = "WORKPILOT_QA_DOTNET_API_TIMEOUT"
GATE_NAME = "public-api-stable"
ISSUE_TYPE = "public_api_break"
CACHE_DIR = "dotnet-api"
_MODES = ("off", "warn", "strict")
_DEFAULT_TIMEOUT = 600
_PROJECT_SUFFIXES = (".csproj", ".fsproj", ".vbproj")
_SKIP_DIRS = frozenset({"bin", "obj", "node_modules", ".git", ".vs", ".workpilot"})
_SHA = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")


def _declared(spec_dir: Path) -> bool:
    from workflows.hard_gates import gate_names
    from workflows.registry import load_workflow_for_spec
    from workflows.spec import WorkflowError

    try:
        workflow = load_workflow_for_spec(spec_dir)
    except (OSError, WorkflowError):  # an unreadable workflow declares nothing
        return False
    return any(
        GATE_NAME in gate_names(getattr(phase, "hard_gate", None))
        for phase in getattr(workflow, "phases", ())
    )


def _migration(spec_dir: Path) -> bool:
    """The preflight staged a .NET migration for this task (not mere adoption)."""
    from dotnet_upgrade.preflight import read_result

    record = read_result(spec_dir)
    return bool(
        record
        and record.get("status") == "staged"
        and record.get("mode") in ("migrate", "chain")
    )


def gate_mode(spec_dir: Path) -> str:
    raw = os.environ.get(DOTNET_API_ENV, "").strip().lower()
    mode = raw if raw in _MODES else "warn"
    if mode == "warn" and (_migration(spec_dir) or _declared(spec_dir)):
        return "strict"
    return mode


def _timeout() -> int:
    try:
        value = int(os.environ.get(TIMEOUT_ENV, "") or _DEFAULT_TIMEOUT)
    except ValueError:
        return _DEFAULT_TIMEOUT
    return min(max(value, 60), 3600)


def _offline(project_dir: Path) -> bool:
    try:
        return bool(airgap_status(project_dir)["airgapStrict"])
    except (OSError, KeyError, ValueError):
        # An unreadable offline policy is read as strict: no download on doubt.
        return True


def _commit(project_dir: Path, base: str) -> str:
    """``base`` as a full commit id. Raises ``OSError``."""
    if not base or base.startswith("-"):
        raise OSError(f"not a revision: {base!r}")
    resolved = run_git(
        ["rev-parse", "--verify", "--quiet", f"{base}^{{commit}}"],
        cwd=project_dir,
        timeout=60,
    )
    sha = resolved.stdout.strip()
    if resolved.returncode != 0 or not _SHA.match(sha):
        raise OSError(f"the base {base!r} is not a commit here")
    return sha


def _base_projects(project_dir: Path, base: str) -> list[str]:
    """The project files git holds at commit ``base``. Raises ``OSError``."""
    listed = run_git(
        ["ls-tree", "-r", "--name-only", "-z", base], cwd=project_dir, timeout=120
    )
    if listed.returncode != 0:
        raise OSError(f"git ls-tree failed: {listed.stderr.strip()[:200]}")
    found = []
    for name in listed.stdout.split("\0"):
        parts = PurePosixPath(name).parts
        if name.lower().endswith(_PROJECT_SUFFIXES) and not any(
            p.lower() in _SKIP_DIRS for p in parts[:-1]
        ):
            found.append(name)
    return found


def check(
    spec_dir: Path,
    project_dir: Path,
    scope: ChangeScope,
    *,
    mode: str,
    launcher,
    builder: Callable[[Path, str], ProjectOutputs] | None = None,
    copier=scratch_copy,
    runner=run_rea,
) -> ApiReport:
    """Build, read and compare. Raises ``OSError`` when a copy cannot be made."""
    if not dotnet_files(scope.files):
        report = ApiReport(mode=mode, status=NONE)
        report.notes.append("no .NET source or project file in the change set")
        return report
    if isinstance(launcher, ReaUnavailable):
        return ApiReport(
            mode=mode,
            unchecked=f"REA cannot run here ({launcher.reason}): {launcher.detail}",
        )
    timeout = _timeout()
    if builder is None:
        dotnet = find_executable("dotnet")
        if not dotnet:
            return ApiReport(
                mode=mode, unchecked="the .NET SDK (dotnet) is not on PATH"
            )
        builder = DotnetBuilder(dotnet, timeout=timeout)

    base = _commit(project_dir, scope.base)
    at_base = _base_projects(project_dir, base)
    now = projects_in(project_dir)
    chosen = affected_projects(set(at_base) | set(now), scope.files)
    beyond = chosen[MAX_PROJECTS:]
    chosen = chosen[:MAX_PROJECTS]
    if not chosen:
        report = ApiReport(mode=mode, status=NONE)
        report.notes.append("the change set reaches no library project")
        return report

    cache = Path(spec_dir) / CACHE_DIR / "base" / base
    before: dict[str, ProjectOutputs] = {}
    missing = []
    for project in (p for p in chosen if p in at_base):
        found = cached_outputs(cache, project)
        if found is None:
            missing.append(project)
        else:
            before[project] = found
    if missing:
        with copier(project_dir, revision=base) as base_tree:
            for project in missing:
                before[project] = store_outputs(
                    cache, project, builder(base_tree, project)
                )

    with copier(project_dir) as task_tree:
        after = {
            project: builder(task_tree, project)
            for project in chosen
            if (Path(task_tree) / project).is_file()
        }
        report = compare_outputs(
            before,
            after,
            chosen,
            launcher=launcher,
            project_dir=project_dir,
            runner=runner,
            timeout=timeout,
        )
    report.mode = mode
    if beyond and report.status != FAIL:
        report.status = UNCHECKED
        report.unchecked = (
            f"{len(beyond)} more project(s) beyond the first {MAX_PROJECTS} "
            "were not compared" + (f"; {report.unchecked}" if report.unchecked else "")
        )
    return report


def render_fix_request(report: ApiReport, spec_dir: Path | None = None) -> str:
    """`QA_FIX_REQUEST.md` for the public members a consumer would lose."""
    lines = [
        "# QA Fix Request — The public API of a library changed",
        "",
        "**Status**: REJECTED (public API)",
        f"**Date**: {datetime.now(UTC).isoformat(timespec='seconds')}",
        f"**Reader**: {report.rea}",
        "",
        "Each library the task touched was built at the task's base and as it is",
        "now; REA compared the two assemblies. Code compiled against the base",
        "version calls these members, and would no longer build or run.",
        "",
        "## To fix (blocking)",
        "",
    ]
    for n, (assembly, change) in enumerate(report.blocking, start=1):
        where = f"{assembly.project}" + (
            f" ({assembly.before} → {assembly.after})"
            if assembly.before and assembly.before != assembly.after
            else f" ({assembly.after})"
            if assembly.after
            else ""
        )
        lines.append(f"{n}. {change.get('kind')} in `{where}`")
    members = "\n".join(
        f"{change.get('kind')}: {change.get('member')}"
        + (f" -> {change.get('detail')}" if change.get("detail") else "")
        for _, change in report.blocking
    )
    if members:
        lines += [
            "",
            "## The members, as REA named them",
            "",
            quote_untrusted(
                members, kind="tool_output", source="rea", spec_dir=spec_dir
            ),
        ]
    lines += [
        "",
        "Keep each public type and member with its name, its declaring type and",
        "its signature. To replace one, add the new member and keep the old one",
        "(marked `[Obsolete]` if it must go later). If the new .NET release",
        "itself forces the change, say so in the build summary: a person decides.",
        "Do not make a library internal, delete a project or switch the gate off",
        "to make the check pass.",
        "",
    ]
    return "\n".join(lines)


def _issues(report: ApiReport) -> list[dict]:
    return [
        {
            "title": "Public API of a library changed",
            "description": f"{change.get('kind')}: {change.get('member')} ({assembly.project})",
            "type": ISSUE_TYPE,
        }
        for assembly, change in report.blocking
    ]


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


def _say(report: ApiReport, task_logger=None) -> None:
    if report.status == NONE:
        return
    if report.unchecked and not report.assemblies:
        message = f"🔌 .NET public API: not checked — {report.unchecked}"
    else:
        lines = []
        for a in report.assemblies:
            tfm = a.after or "?"
            if a.breaking:
                lines += [
                    f"  ✗ {a.project} ({tfm}): {c.get('kind')} {c.get('member')}"
                    for c in a.breaking[:20]
                ]
            elif a.status == "compatible":
                lines.append(
                    f"  ✓ {a.project} ({tfm}): {a.public_members} public member(s) kept"
                    + (f", {a.added} added" if a.added else "")
                )
            else:
                lines.append(f"  ? {a.project} ({tfm}): {a.detail}")
        if report.unchecked:
            lines.append(f"  ? {report.unchecked}")
        message = f"🔌 .NET public API ({report.rea}):\n" + "\n".join(lines)
    if task_logger is None:
        print("\n" + message)
        return
    from task_logger import LogEntryType, LogPhase

    kind = LogEntryType.ERROR if report.status == FAIL else LogEntryType.INFO
    task_logger.log(message, kind, LogPhase.VALIDATION)


def dotnet_api_gate(
    spec_dir: Path,
    project_dir: Path,
    qa_iteration: int,
    review_scope: ChangeScope | None,
    *,
    task_logger=None,
    locator=locate,
    builder: Callable[[Path, str], ProjectOutputs] | None = None,
    copier=scratch_copy,
    runner=run_rea,
) -> tuple[list[dict], str] | None:
    """The issues and verdict of a rejection, or None. Never raises."""
    spec_dir, project_dir = Path(spec_dir), Path(project_dir)
    mode = "warn"
    try:
        mode = gate_mode(spec_dir)
        if mode == "off":
            report = ApiReport(mode=mode, unchecked=f"disabled by {DOTNET_API_ENV}=off")
        elif review_scope is None or not review_scope.base:
            report = ApiReport(mode=mode, unchecked="the change set is unknown")
        elif not dotnet_files(review_scope.files):
            report = ApiReport(mode=mode, status=NONE)
            report.notes.append("no .NET source or project file in the change set")
        else:
            allow_download = mode == "strict" and not _offline(project_dir)
            report = check(
                spec_dir,
                project_dir,
                review_scope,
                mode=mode,
                launcher=locator(allow_download=allow_download),
                builder=builder,
                copier=copier,
                runner=runner,
            )
        write_record(spec_dir, report)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        debug_warning("qa_loop", f".NET public API skipped (non-blocking): {exc}")
        try:
            write_record(spec_dir, ApiReport(mode=mode, unchecked=str(exc)[:400]))
        except OSError as write_error:
            # The hard gate reads a missing record as unknown too.
            debug_warning(
                "qa_loop", f".NET public API record not written: {write_error}"
            )
        return None
    _say(report, task_logger)
    if report.status != FAIL or mode != "strict":
        debug("qa_loop", ".NET public API", status=report.status, mode=mode)
        return None
    issues = _issues(report)
    try:
        (spec_dir / "QA_FIX_REQUEST.md").write_text(
            render_fix_request(report, spec_dir), encoding="utf-8"
        )
        _mark_signoff_rejected(spec_dir, issues)
    except OSError as exc:
        debug_warning(
            "qa_loop", f".NET public API could not write the fix request: {exc}"
        )
    return issues, (
        f"QA pass #{qa_iteration} rejected: {len(issues)} public member(s) of a "
        ".NET library removed or changed"
    )
