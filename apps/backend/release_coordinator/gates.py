"""Run one step of the train: a command, or a call to a health URL.

A command is the argument list the approved train file gives, its
placeholders replaced by checked values (``{environment}``, ``{version}``,
``{previous_version}``, ``{service}``). It runs without a shell (S4), in the
service's folder inside the project, in its own process group so a timeout
also stops what it started, with the app's environment stripped of its
credentials plus the variables the file names in ``pass_env``. A program
named by a path (``./deploy.sh``) must be a file inside the project; a bare
name (``gh``, ``kubectl``) is looked up on ``PATH``.

An exposure step reads the service's build output with REA's static audit
(`rea`, the pinned release, never run on the artifact): it passes when no
check is exposed at its ``fail_on`` or above, ``unknown`` and ``not_assessed``
included; an artifact that is missing or outside the project, or REA unable to
run here, is an error (nothing was decided). Under the project's strict offline
policy only an installed REA runs.

A URL step sends GET requests until the expected status answers or the
retries run out, a few seconds apart. Redirects are not followed: the status
read is the one the address gave.

What a step printed is kept (its last 4,000 characters) with secrets masked,
for the run's journal.
"""

from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from pathlib import Path

from foundation.log_redaction import redact_text
from foundation.platform import build_windows_command, is_windows
from offline_policy import airgap_status
from rea import ReaRun, locate, run_rea
from rea.exposure import blocking_checks
from security.child_env import env_without_credentials

from .train_file import PLACEHOLDER, Step

OUTPUT_TAIL = 4000
VALUE = re.compile(r"^[\w.+-]{1,80}$")
RETRY_DELAY_S = 5.0
URL_TIMEOUT_S = 15


class GateError(ValueError):
    """A step that cannot be run as written (nothing was started)."""


@dataclass
class StepResult:
    status: str
    """``passed``, ``failed`` (ran and said no), ``timeout`` or ``error`` (not run)."""
    detail: str = ""
    exit_code: int | None = None
    http_status: int | None = None
    attempts: int = 1
    duration_s: float = 0.0
    output: str = ""

    @property
    def ok(self) -> bool:
        return self.status == "passed"

    def to_dict(self) -> dict[str, object]:
        data = asdict(self)
        data["exitCode"] = data.pop("exit_code")
        data["httpStatus"] = data.pop("http_status")
        data["durationS"] = data.pop("duration_s")
        return data


def substitute(text: str, values: Mapping[str, str]) -> str:
    def one(match: re.Match[str]) -> str:
        key = match.group(1)
        value = values.get(key, "")
        if not value:
            raise GateError(f"no value for {{{key}}}")
        if not VALUE.match(value):
            raise GateError(f"{{{key}}} has characters a command does not take")
        return value

    return PLACEHOLDER.sub(one, text)


def service_folder(root: Path, path: str) -> Path:
    """The folder the service's commands run in, inside the project."""
    base = root.resolve()
    folder = (base / path).resolve() if path else base
    if folder != base and base not in folder.parents:
        raise GateError("the service folder is outside the project")
    if not folder.is_dir():
        raise GateError(f"the service folder {path or '.'} does not exist")
    return folder


def resolve_program(program: str, cwd: Path, root: Path, env: Mapping[str, str]) -> str:
    if "/" in program or "\\" in program:
        base = root.resolve()
        candidate = (cwd / program).resolve()
        if base not in candidate.parents:
            raise GateError(f"{program} is outside the project")
        names = [candidate]
        if is_windows() and not candidate.suffix:
            names += [candidate.with_suffix(ext) for ext in (".exe", ".cmd", ".bat")]
        for name in names:
            if name.is_file():
                return str(name)
        raise GateError(f"{program} does not exist in the project")
    found = shutil.which(program, path=env.get("PATH"))
    if not found:
        raise GateError(f"{program} is not installed (not found on PATH)")
    return found


def command_env(
    pass_env: list[str], source: Mapping[str, str] | None = None
) -> dict[str, str]:
    source = os.environ if source is None else source
    env = env_without_credentials(source, extra={"CI": "1", "NO_COLOR": "1"})
    for name in pass_env:
        if name in source:
            env[name] = source[name]
    return env


def _stop(process: subprocess.Popen) -> None:
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
        except OSError:
            return
        try:
            process.wait(timeout=5)
            return
        except subprocess.TimeoutExpired:
            continue


def _tail(raw: bytes | None) -> str:
    text = (raw or b"").decode("utf-8", errors="replace")
    return redact_text(text[-OUTPUT_TAIL:])


def run_command(
    step: Step,
    *,
    root: Path,
    folder: str,
    values: Mapping[str, str],
    pass_env: list[str],
    source_env: Mapping[str, str] | None = None,
    popen: Callable[..., subprocess.Popen] = subprocess.Popen,
) -> StepResult:
    """Run ``step.command`` once. Never raises."""
    started = time.monotonic()
    try:
        cwd = service_folder(root, folder)
        env = command_env(pass_env, source_env)
        argv = [substitute(arg, values) for arg in step.command]
        program = resolve_program(argv[0], cwd, root, env)
    except GateError as exc:
        return StepResult("error", detail=str(exc))
    argv = (
        build_windows_command(program, argv[1:])
        if is_windows()
        else [program, *argv[1:]]
    )
    kwargs: dict[str, object] = {
        "cwd": str(cwd),
        "env": env,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
    }
    if is_windows():  # pragma: no cover - Windows leg
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    else:
        kwargs["start_new_session"] = True
    try:
        process = popen(argv, **kwargs)  # noqa: S603 - argv list from the approved file, no shell
    except (OSError, ValueError) as exc:
        return StepResult(
            "error", detail=f"the command could not start: {type(exc).__name__}"
        )
    try:
        output, _ = process.communicate(timeout=step.timeout)
    except subprocess.TimeoutExpired:
        _stop(process)
        try:
            output, _ = process.communicate(timeout=10)
        except (subprocess.TimeoutExpired, OSError, ValueError):
            output = b""
        return StepResult(
            "timeout",
            detail=f"stopped after {step.timeout}s",
            duration_s=round(time.monotonic() - started, 2),
            output=_tail(output),
        )
    code = process.returncode
    return StepResult(
        "passed" if code == 0 else "failed",
        detail="" if code == 0 else f"exit code {code}",
        exit_code=code,
        duration_s=round(time.monotonic() - started, 2),
        output=_tail(output),
    )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:  # type: ignore[override]
        return None


def http_status(url: str) -> int:
    """The status ``url`` answers a GET with; 0 when nothing answered."""
    opener = urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(
        url, headers={"User-Agent": "WorkPilot-release-train"}
    )
    try:
        with opener.open(request, timeout=URL_TIMEOUT_S) as response:  # noqa: S310 - http(s) only, checked by the train file
            return int(response.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return 0


def check_url(
    step: Step,
    values: Mapping[str, str],
    *,
    fetch: Callable[[str], int] = http_status,
    sleep: Callable[[float], None] = time.sleep,
) -> StepResult:
    """Call ``step.url`` until it answers ``expect_status``. Never raises."""
    started = time.monotonic()
    try:
        url = substitute(step.url, values)
    except GateError as exc:
        return StepResult("error", detail=str(exc))
    status = 0
    for attempt in range(1, step.retries + 1):
        status = fetch(url)
        if status == step.expect_status:
            return StepResult(
                "passed",
                http_status=status,
                attempts=attempt,
                duration_s=round(time.monotonic() - started, 2),
            )
        if attempt < step.retries:
            sleep(RETRY_DELAY_S)
    return StepResult(
        "failed",
        detail=f"expected {step.expect_status}, got {status or 'no answer'}",
        http_status=status or None,
        attempts=step.retries,
        duration_s=round(time.monotonic() - started, 2),
    )


def _offline(root: Path) -> bool:
    try:
        return bool(airgap_status(root)["airgapStrict"])
    except (OSError, KeyError, ValueError):
        return True  # an unreadable policy: no download on doubt


def run_exposure(
    step: Step,
    *,
    root: Path,
    folder: str,
    rea_runner: Callable[..., ReaRun] = run_rea,
    locator: Callable[..., object] = locate,
) -> StepResult:
    """REA's audit of ``step.artifact``, inside the service folder. Never raises."""
    started = time.monotonic()
    try:
        cwd = service_folder(root, folder)
    except GateError as exc:
        return StepResult("error", detail=str(exc))
    base = root.resolve()
    artifact = (cwd / step.artifact).resolve()
    if artifact != base and base not in artifact.parents:
        return StepResult("error", detail=f"{step.artifact} is outside the project")
    if not artifact.exists():
        return StepResult(
            "error", detail=f"{step.artifact} does not exist: build the service first"
        )
    fail_on = step.fail_on or "high"
    run = rea_runner(
        "audit-release-exposure",
        [artifact],
        {"--fail_on": fail_on},
        project_dir=root,
        launcher=locator(allow_download=not _offline(root)),
        timeout=step.timeout,
    )
    duration = round(time.monotonic() - started, 2)
    if not run.ok or run.result is None:
        return StepResult(
            "timeout" if run.error == "timeout" else "error",
            detail=f"REA did not answer ({run.error}): {redact_text(run.detail)[:300]}",
            exit_code=run.exit_code,
            duration_s=duration,
        )
    checks = [c for c in run.result.get("checks") or [] if isinstance(c, dict)]
    exposed = blocking_checks(checks, fail_on)
    summary = ", ".join(f"{c.get('id')}={c.get('status')}" for c in checks[:20])
    if exposed:
        names = ", ".join(f"{c.get('id')} ({c.get('severity')})" for c in exposed[:5])
        return StepResult(
            "failed",
            detail=f"exposed at {fail_on} or above: {names}",
            exit_code=run.exit_code,
            duration_s=duration,
            output=redact_text(summary)[-OUTPUT_TAIL:],
        )
    return StepResult(
        "passed",
        exit_code=run.exit_code,
        duration_s=duration,
        output=redact_text(summary)[-OUTPUT_TAIL:],
    )


def run_step(
    step: Step,
    *,
    root: Path,
    folder: str,
    values: Mapping[str, str],
    pass_env: list[str],
    source_env: Mapping[str, str] | None = None,
    popen: Callable[..., subprocess.Popen] = subprocess.Popen,
    fetch: Callable[[str], int] = http_status,
    sleep: Callable[[float], None] = time.sleep,
) -> StepResult:
    """An exposure audit; else the command when the step has one, then its URL."""
    if step.artifact:
        return run_exposure(step, root=root, folder=folder)
    if step.command:
        result = run_command(
            step,
            root=root,
            folder=folder,
            values=values,
            pass_env=pass_env,
            source_env=source_env,
            popen=popen,
        )
        if not result.ok or not step.url:
            return result
    return check_url(step, values, fetch=fetch, sleep=sleep)


__all__ = [
    "GateError",
    "StepResult",
    "check_url",
    "command_env",
    "http_status",
    "resolve_program",
    "run_command",
    "run_exposure",
    "run_step",
    "service_folder",
    "substitute",
]
