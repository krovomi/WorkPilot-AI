"""Running a worktree's recipe: once at creation, again only when the recipe changed.

`prepare_worktree` runs after the checkout and the build-output excludes,
before the first session. A step that fails does not stop the task (an agent
can often finish the job, and it is better placed to repair a half-ready
environment than nothing is): the record says what failed, and the subtask
prompt carries it (`setup_prompt_section`) so the agent reads it first
instead of meeting it at its first build.

The record and the log live in the worktree's `.workpilot/` (ignored by
git): `worktree-setup.json` and `worktree-setup.log`. The log keeps the tail
of each command's output; files copied in are named, never shown.

A recipe written in `.workpilot/worktree.toml` is the project's, so it runs
only once the person approved that exact content (`approve_recipe`,
`.workpilot/worktree-approved.json`); the agents can write neither file
(`security/path_guard.py`). The recipe detected from the stack is WorkPilot's
own and needs no approval.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from foundation.git_executable import run_git
from foundation.platform import find_executable
from security.child_env import env_without_credentials

from .ports import BLOCK, release_ports, reserve_ports, reserved_port
from .recipe import Recipe, recipe_for

__all__ = [
    "APPROVAL_FILE",
    "SetupReport",
    "approve_recipe",
    "is_approved",
    "prepare_worktree",
    "read_setup_record",
    "setup_prompt_section",
    "teardown_worktree",
]

logger = logging.getLogger(__name__)

APPROVAL_FILE = "worktree-approved.json"
RECORD_FILE = "worktree-setup.json"
LOG_FILE = "worktree-setup.log"
_TAIL = 4000
_TEARDOWN_TIMEOUT = 120


@dataclass
class Step:
    command: list[str]
    status: str  # "ok" | "failed" | "skipped" | "timeout"
    detail: str = ""
    seconds: float = 0.0


@dataclass
class SetupReport:
    status: (
        str  # "ready" | "partial" | "awaiting-approval" | "invalid" | "nothing-to-do"
    )
    source: str = ""
    digest: str = ""
    port: int | None = None
    port_count: int = 0
    steps: list[Step] = field(default_factory=list)
    copied: list[str] = field(default_factory=list)
    linked: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    at: str = ""

    @property
    def failed(self) -> list[Step]:
        return [s for s in self.steps if s.status in ("failed", "timeout")]


# ── approval ─────────────────────────────────────────────────────────────────


def _approval_path(project_dir: Path) -> Path:
    return Path(project_dir) / ".workpilot" / APPROVAL_FILE


def is_approved(project_dir: Path | str, recipe: Recipe) -> bool:
    if recipe.source != "file":
        return True
    try:
        data = json.loads(_approval_path(Path(project_dir)).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and data.get("digest") == recipe.digest


def approve_recipe(project_dir: Path | str, *, by: str = "the person") -> Recipe:
    """Approve the project's recipe file as it is now. Raises ValueError if invalid."""
    recipe = recipe_for(project_dir)
    if recipe.errors:
        raise ValueError("; ".join(recipe.errors))
    path = _approval_path(Path(project_dir))
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "digest": recipe.digest,
        "approved_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "approved_by": by,
    }
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return recipe


# ── running ──────────────────────────────────────────────────────────────────


def _record_dir(worktree: Path) -> Path:
    return Path(worktree) / ".workpilot"


def read_setup_record(worktree: Path | str) -> dict | None:
    try:
        data = json.loads(
            (_record_dir(Path(worktree)) / RECORD_FILE).read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _write_record(worktree: Path, report: SetupReport) -> None:
    folder = _record_dir(worktree)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / RECORD_FILE).write_text(
        json.dumps(asdict(report), indent=2), encoding="utf-8"
    )


def _variables(
    project_dir: Path, worktree: Path, spec_name: str, port: int | None, count: int
) -> dict[str, str]:
    values = {
        "WORKPILOT_WORKTREE_PATH": str(worktree),
        "WORKPILOT_ROOT_PATH": str(project_dir),
        "WORKPILOT_TASK_SLUG": re.sub(r"[^a-z0-9-]", "-", spec_name.lower())[:60],
    }
    if port is not None:
        values["WORKPILOT_PORT"] = str(port)
        values["WORKPILOT_PORT_COUNT"] = str(count)
    return values


def _expand(argument: str, variables: dict[str, str]) -> str:
    """`${WORKPILOT_*}` only: nothing else of the environment leaks into an argument."""
    return re.sub(
        r"\$\{(WORKPILOT_[A-Z_]+)\}",
        lambda m: variables.get(m.group(1), m.group(0)),
        argument,
    )


def _environment(recipe: Recipe, variables: dict[str, str]) -> dict[str, str]:
    env = env_without_credentials(extra=variables)
    for name in recipe.pass_env:
        if name in os.environ:
            env[name] = os.environ[name]
    return env


def _run(
    command: tuple[str, ...], cwd: Path, env: dict[str, str], timeout: float, log
) -> Step:
    program = find_executable(command[0]) if not Path(command[0]).parent.parts else None
    if program is None and not (cwd / command[0]).exists():
        return Step(list(command), "skipped", f"{command[0]} is not installed")
    # A relative program (`./gradlew`, `.venv/bin/python`) is the worktree's.
    argv = [program or str(cwd / command[0]), *command[1:]]
    started = time.monotonic()
    log.write(f"\n$ {' '.join(command)}\n")
    try:
        done = subprocess.run(  # noqa: S603 - a validated argument list, no shell (rule 6)
            argv,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=max(1.0, timeout),
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return Step(
            list(command),
            "timeout",
            "the recipe's time ran out",
            time.monotonic() - started,
        )
    except OSError as exc:
        return Step(list(command), "failed", str(exc), time.monotonic() - started)
    output = (done.stdout or "") + (done.stderr or "")
    log.write(output[-_TAIL:])
    seconds = time.monotonic() - started
    if done.returncode != 0:
        tail = output.strip().splitlines()[-5:]
        return Step(
            list(command),
            "failed",
            f"exit {done.returncode}: " + " | ".join(tail)[-600:],
            seconds,
        )
    return Step(list(command), "ok", "", seconds)


def _ignored(project_dir: Path, rel: str) -> bool:
    """Whether git ignores ``rel`` in the project: only then may it be brought in.

    The task's branch commits what the agent leaves uncommitted
    (`WorktreeManager.commit_pending_changes`): a copied `.env` that git does
    not ignore would land in the branch, and the pull request after it.
    """
    result = run_git(["check-ignore", "-q", "--no-index", "--", rel], cwd=project_dir)
    return result.returncode == 0


def _bring(
    paths: tuple[str, ...],
    project_dir: Path,
    worktree: Path,
    errors: list[str],
    *,
    link: bool,
) -> list[str]:
    brought = []
    for rel in paths:
        source, target = project_dir / rel, worktree / rel
        present = source.is_dir() if link else source.is_file()
        if not present or target.exists() or target.is_symlink():
            continue
        if not _ignored(project_dir, rel):
            errors.append(
                f"{rel} was not {'linked' if link else 'copied'}: git does not "
                "ignore it, so the task's branch would commit it"
            )
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            if link:
                target.symlink_to(source, target_is_directory=True)
            else:
                shutil.copy2(source, target)
        except OSError as exc:
            errors.append(f"{rel}: {exc.strerror or exc}")
            continue
        brought.append(rel)
    return brought


def prepare_worktree(
    project_dir: Path | str,
    worktree: Path | str,
    spec_name: str,
    recipe: Recipe | None = None,
) -> SetupReport:
    """Run the recipe in ``worktree`` unless it already ran as it is. Never raises."""
    project_dir, worktree = Path(project_dir), Path(worktree)
    recipe = recipe or recipe_for(project_dir)
    previous = read_setup_record(worktree)
    if (
        previous
        and previous.get("digest") == recipe.digest
        and previous.get("status") in ("ready", "partial")
    ):
        return SetupReport(
            **{**previous, "steps": [Step(**s) for s in previous.get("steps", [])]}
        )
    report = SetupReport(
        "ready",
        recipe.source,
        recipe.digest,
        at=datetime.now(UTC).isoformat(timespec="seconds"),
    )
    if recipe.errors:
        report.status, report.errors = "invalid", list(recipe.errors)
    elif not is_approved(project_dir, recipe):
        report.status = "awaiting-approval"
    elif recipe.empty:
        report.status = "nothing-to-do"
    else:
        _execute(recipe, project_dir, worktree, spec_name, report)
    try:
        _write_record(worktree, report)
    except OSError as exc:
        # The worktree is still usable; only the prompt section is lost.
        logger.warning("[worktree-recipe] could not write the setup record: %s", exc)
    return report


def _execute(
    recipe: Recipe,
    project_dir: Path,
    worktree: Path,
    spec_name: str,
    report: SetupReport,
) -> None:
    if recipe.ports:
        try:
            report.port = reserve_ports(project_dir, spec_name, recipe.ports)
            report.port_count = min(recipe.ports, BLOCK)
        except (OSError, TimeoutError) as exc:
            report.errors.append(f"no port block reserved: {exc}")
    report.copied = _bring(
        recipe.copy, project_dir, worktree, report.errors, link=False
    )
    report.linked = _bring(recipe.link, project_dir, worktree, report.errors, link=True)
    variables = _variables(
        project_dir, worktree, spec_name, report.port, report.port_count
    )
    env = _environment(recipe, variables)
    deadline = time.monotonic() + recipe.timeout_seconds
    _record_dir(worktree).mkdir(parents=True, exist_ok=True)
    with open(_record_dir(worktree) / LOG_FILE, "w", encoding="utf-8") as log:
        for command in recipe.setup:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                report.steps.append(
                    Step(list(command), "timeout", "the recipe's time ran out")
                )
                continue
            expanded = tuple(_expand(a, variables) for a in command)
            report.steps.append(_run(expanded, worktree, env, remaining, log))
    if report.failed or report.errors:
        report.status = "partial"


def teardown_worktree(
    project_dir: Path | str, worktree: Path | str, spec_name: str
) -> list[Step]:
    """The recipe's teardown, then the port block back. Never raises."""
    project_dir, worktree = Path(project_dir), Path(worktree)
    steps: list[Step] = []
    recipe = recipe_for(project_dir)
    record = read_setup_record(worktree) if worktree.exists() else None
    if (
        recipe.teardown
        and not recipe.errors
        and is_approved(project_dir, recipe)
        and worktree.exists()
    ):
        port = (record or {}).get("port") or reserved_port(project_dir, spec_name)
        variables = _variables(
            project_dir,
            worktree,
            spec_name,
            port,
            (record or {}).get("port_count") or 0,
        )
        env = _environment(recipe, variables)
        with open(os.devnull, "w", encoding="utf-8") as sink:
            for command in recipe.teardown:
                expanded = tuple(_expand(a, variables) for a in command)
                steps.append(_run(expanded, worktree, env, _TEARDOWN_TIMEOUT, sink))
    try:
        release_ports(project_dir, spec_name)
    except (OSError, TimeoutError) as exc:
        # Removal goes on: a block left reserved only narrows the range.
        logger.warning("[worktree-recipe] could not release the task's ports: %s", exc)
    return steps


def setup_prompt_section(worktree: Path | str) -> str:
    """What the agent must know about its worktree's preparation; "" when nothing."""
    record = read_setup_record(worktree)
    if not record:
        return ""
    lines: list[str] = []
    port, count = record.get("port"), record.get("port_count") or 0
    if port:
        last = port + max(count, 1) - 1
        lines.append(
            f"- This task's ports are {port}–{last} (`WORKPILOT_PORT`={port}). "
            "Start servers there, not on a fixed port another task may hold."
        )
    status = record.get("status")
    if status == "awaiting-approval":
        lines.append(
            "- `.workpilot/worktree.toml` was not run: the person has not approved "
            "it yet. Install what you need yourself."
        )
    elif status == "invalid":
        lines.append(
            "- `.workpilot/worktree.toml` is invalid and was not run: "
            + "; ".join(record.get("errors") or [])
        )
    for step in record.get("steps") or []:
        if step.get("status") in ("failed", "timeout", "skipped"):
            lines.append(
                f"- Setup step `{' '.join(step.get('command') or [])}` {step.get('status')}: {step.get('detail', '')}"
            )
    for error in record.get("errors") or []:
        if status != "invalid":
            lines.append(f"- {error}")
    if not lines:
        return ""
    return (
        "## Worktree environment\n\n"
        "WorkPilot prepared this worktree before your session "
        "(log: `.workpilot/worktree-setup.log`).\n\n" + "\n".join(lines) + "\n"
    )
