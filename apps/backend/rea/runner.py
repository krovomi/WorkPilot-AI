"""Run one static REA reader and read its JSON.

Closed on every side, because what REA reads is untrusted (S2) and what it
runs is a downloaded tool (S8):

* the command comes from `COMMANDS`: readers that never start the target, the
  network or a device (no capture, browser, adb, debugger, environment build);
* each positional is a path that exists, resolved to absolute, so it can never
  read as an option; each option and its values are listed per command;
* the process gets ``[node, <script>, …]`` without a shell, the backend's
  environment without its credentials (`security.child_env`), and a fresh
  temporary directory as its working directory, so no project ``.npmrc`` or
  ``node_modules`` decides what npx runs;
* the answer is data: `ReaRun.result` is REA's ``normalized_result``, never a
  prompt, and a caller quotes it as untrusted before a model reads it.

REA exits 3 when ``--fail_on`` is met; that is an answer, not a failure.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from offline_policy import airgap_status
from security.child_env import env_without_credentials

from .locate import ReaLauncher, ReaUnavailable, locate
from .pin import Pin, load_pin

__all__ = ["COMMANDS", "EXPOSED_EXIT", "ReaRun", "run_rea"]

#: Exit status of a completed audit whose exposed check met ``--fail_on``.
EXPOSED_EXIT = 3

#: Static readers WorkPilot may run, with their positional count and options.
COMMANDS: Mapping[str, tuple[int, Mapping[str, frozenset[str]]]] = {
    "audit-release-exposure": (1, {"--fail_on": frozenset({"high", "medium", "low"})}),
    "inspect-electron-fuses": (1, {}),
    "inspect-binary-hardening": (1, {}),
    "inspect-managed-members": (1, {}),
    "compare-managed-members": (2, {}),
}

DEFAULT_TIMEOUT = 900
_STDERR_TAIL = 2000


@dataclass(frozen=True)
class ReaRun:
    ok: bool
    """REA answered with a result (exit 0, or 3 for a met ``--fail_on``)."""
    exit_code: int | None = None
    result: dict | None = None
    """REA's ``normalized_result`` (the report), untrusted data."""
    evidence_id: str | None = None
    error: str | None = None
    """``unavailable``, ``refused``, ``timeout``, ``failed`` or ``bad_output``."""
    detail: str = ""
    unavailable: ReaUnavailable | None = None
    launcher: ReaLauncher | None = field(default=None, repr=False)


class _Refused(ValueError):
    pass


def _arguments(
    command: str, positionals: Sequence[Path | str], options: Mapping[str, str]
) -> list[str]:
    spec = COMMANDS.get(command)
    if spec is None:
        raise _Refused(f"{command!r} is not a static REA reader WorkPilot runs")
    count, allowed = spec
    if len(positionals) != count:
        raise _Refused(f"{command} takes {count} path(s), got {len(positionals)}")
    args = [command]
    for raw in positionals:
        path = Path(raw)
        if not path.is_absolute():
            raise _Refused(f"{command}: {raw!s} is not an absolute path")
        resolved = path.resolve()
        if not resolved.exists():
            raise _Refused(f"{command}: {resolved} does not exist")
        args.append(os.fspath(resolved))
    for name, value in options.items():
        values = allowed.get(name)
        if values is None or value not in values:
            raise _Refused(f"{command}: option {name}={value!r} is not allowed")
        args.extend([name, value])
    args.append("--json")
    return args


def _parse(stdout: str) -> tuple[dict | None, str | None]:
    text = stdout.strip()
    start = text.find("{")
    if start < 0:
        return None, None
    try:
        parsed = json.loads(text[start:])
    except ValueError:
        return None, None
    if not isinstance(parsed, dict):
        return None, None
    result = parsed.get("normalized_result", parsed)
    evidence = parsed.get("evidence_id")
    return (
        result if isinstance(result, dict) else None,
        evidence if isinstance(evidence, str) else None,
    )


def run_rea(
    command: str,
    positionals: Sequence[Path | str],
    options: Mapping[str, str] | None = None,
    *,
    project_dir: Path | str | None = None,
    pin: Pin | None = None,
    launcher: ReaLauncher | ReaUnavailable | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> ReaRun:
    """Run ``rea <command> <paths> [options] --json`` and return its result.

    ``project_dir`` names the project the run is for: under its strict offline
    policy only an installed REA runs, npx would download it. ``launcher`` is
    the result of `locate` when the caller already has it.
    """
    try:
        argv_tail = _arguments(command, positionals, options or {})
    except _Refused as refused:
        return ReaRun(ok=False, error="refused", detail=str(refused))

    if launcher is None:
        offline = bool(project_dir) and airgap_status(project_dir)["airgapStrict"]
        launcher = locate(pin or load_pin(), allow_download=not offline)
    if isinstance(launcher, ReaUnavailable):
        return ReaRun(
            ok=False, error="unavailable", detail=launcher.detail, unavailable=launcher
        )

    workdir = tempfile.mkdtemp(prefix="workpilot-rea-")
    try:
        completed = subprocess.run(
            [*launcher.argv, *argv_tail],
            cwd=workdir,
            env=env_without_credentials(extra={"npm_config_yes": "true"}),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return ReaRun(
            ok=False,
            error="timeout",
            detail=f"{command} ran past {timeout}s",
            launcher=launcher,
        )
    except OSError as error:
        return ReaRun(ok=False, error="failed", detail=str(error), launcher=launcher)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    if completed.returncode not in (0, EXPOSED_EXIT):
        return ReaRun(
            ok=False,
            exit_code=completed.returncode,
            error="failed",
            detail=(completed.stderr or completed.stdout)[-_STDERR_TAIL:],
            launcher=launcher,
        )
    result, evidence = _parse(completed.stdout)
    if result is None:
        return ReaRun(
            ok=False,
            exit_code=completed.returncode,
            error="bad_output",
            detail="REA printed no JSON result",
            launcher=launcher,
        )
    return ReaRun(
        ok=True,
        exit_code=completed.returncode,
        result=result,
        evidence_id=evidence,
        launcher=launcher,
    )
