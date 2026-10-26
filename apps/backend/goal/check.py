"""Run the goal's command and read its exit code.

The verdict is the exit code, nothing else: no output is parsed, no model is
asked. Three answers, never confused:

* ``met``   — the command ran to the end and exited with the expected code;
* ``unmet`` — it exited with another code, or ran past its timeout (a hang is
  something the code can cause, so it goes to the fixer like a failure);
* ``error`` — it could not be run at all (program not found, not allowed).
  Nothing the fixer writes can answer that; a person must.

The command runs in the task's worktree, without a shell, in its own process
group (a timeout takes the test runner *and* what it forked), with the
backend's environment stripped of its credentials.
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

from foundation.platform import is_windows, split_command
from security.child_env import env_without_credentials

from .spec import GoalSpec

__all__ = ["GoalRun", "command_script", "run_goal"]

OUTPUT_TAIL_CHARS = 8000


@dataclass(frozen=True)
class GoalRun:
    status: str
    """``met``, ``unmet`` or ``error``."""
    exit_code: int | None = None
    timed_out: bool = False
    duration_s: float = 0.0
    output_tail: str = ""
    detail: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def command_script(spec: GoalSpec, worktree: Path) -> str | None:
    """The repository file the command runs, relative to the worktree, if any.

    ``./scripts/check.sh`` or ``tools\\goal.ps1`` is part of the goal: a task
    that rewrites it rewrites the definition of done, so the gate protects it
    like a declared path. ``npm test`` names no file of the repository.
    """
    try:
        argv = split_command(spec.command, worktree)
    except ValueError:
        return None
    for token in argv[:3]:
        if "/" not in token and "\\" not in token:
            continue
        candidate = (worktree / token).resolve()
        try:
            relative = candidate.relative_to(worktree.resolve())
        except ValueError:
            continue
        if candidate.is_file():
            return relative.as_posix()
    return None


def _kill_group(process: subprocess.Popen) -> None:
    if is_windows():  # pragma: no cover - Windows leg
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(process.pid)],
            capture_output=True,
            check=False,
        )
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sig)
        except (ProcessLookupError, PermissionError, OSError):
            return
        try:
            process.wait(timeout=5)
            return
        except subprocess.TimeoutExpired:
            continue


def _tail(raw: bytes | str | None) -> str:
    if raw is None:
        return ""
    text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
    return text[-OUTPUT_TAIL_CHARS:]


def run_goal(
    spec: GoalSpec,
    worktree: Path,
    *,
    popen: Callable[..., subprocess.Popen] = subprocess.Popen,
) -> GoalRun:
    """Run the goal once in ``worktree``. Never raises."""
    try:
        argv = split_command(spec.command, worktree)
    except ValueError as exc:
        return GoalRun("error", detail=f"the command cannot be parsed: {exc}")
    if not argv:
        return GoalRun("error", detail="the command is empty")

    kwargs: dict = {
        "cwd": str(worktree),
        "env": env_without_credentials(extra={"CI": "1", "NO_COLOR": "1"}),
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
    }
    if is_windows():  # pragma: no cover - Windows leg
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    else:
        kwargs["start_new_session"] = True

    started = time.monotonic()
    try:
        process = popen(argv, **kwargs)  # noqa: S603 - argv list, no shell
    except (OSError, ValueError) as exc:
        return GoalRun("error", detail=f"the command could not start: {exc}")

    try:
        output, _ = process.communicate(timeout=spec.timeout_s)
    except subprocess.TimeoutExpired:
        _kill_group(process)
        try:
            output, _ = process.communicate(timeout=10)
        except (subprocess.TimeoutExpired, OSError, ValueError):
            output = b""
        return GoalRun(
            "unmet",
            exit_code=None,
            timed_out=True,
            duration_s=round(time.monotonic() - started, 2),
            output_tail=_tail(output),
            detail=f"the command ran past its {spec.timeout_s}s timeout",
        )

    code = process.returncode
    duration = round(time.monotonic() - started, 2)
    if code == spec.expected_exit:
        return GoalRun(
            "met", exit_code=code, duration_s=duration, output_tail=_tail(output)
        )
    return GoalRun(
        "unmet",
        exit_code=code,
        duration_s=duration,
        output_tail=_tail(output),
        detail=f"exit code {code}, expected {spec.expected_exit}",
    )
