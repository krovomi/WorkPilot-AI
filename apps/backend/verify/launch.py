"""Start an application, wait until it answers, and say what it printed.

The launch is the step every provider gets identically, so it is code, not a
prompt. Its contract:

* the command comes from detection or from a learned recipe — text a model
  wrote reaches it only through the `verifier`'s own Bash tool, which the
  security hook already gates;
* the app runs in its **own process group** with its output in a log file, so
  a teardown takes the dev server *and* the watcher it forked, and any process
  — the build, the MCP server — can read what it printed (`verify.state`);
* "ready" means *something answered HTTP* on the port: a 404 on `/` is a Web
  API that is up. The port is ours to choose when the stack takes one
  (`{port}`, `PORT`, `ASPNETCORE_URLS`…); otherwise the first loopback URL the
  app prints is believed, which is how Vite announces itself when its default
  port is taken;
* the app's death, a timeout and a refusal are three different answers, each
  with the log tail that explains it.
"""

from __future__ import annotations

import logging
import os
import re
import shlex
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .detect import Target, free_port
from .errors import VerifyError, collect_errors
from .state import is_alive, live_process, save_process, stop_process

logger = logging.getLogger(__name__)

__all__ = ["LaunchResult", "launch", "probe", "read_log", "LOGS_DIRNAME"]

LOGS_DIRNAME = "logs"
_LOG_TAIL_BYTES = 200_000

# The first loopback URL an app prints: `Local: http://localhost:5173/`,
# `Now listening on: http://127.0.0.1:5000`, `Uvicorn running on http://…`.
_URL_IN_LOG = re.compile(
    r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(?P<port>\d{2,5}))(?P<path>/[^\s\"'<>]*)?",
    re.I,
)


@dataclass
class LaunchResult:
    target: str
    #: ``ready``, ``exited``, ``timeout``, ``refused`` or ``reused``.
    status: str
    url: str = ""
    pid: int | None = None
    log_path: str = ""
    exit_code: int | None = None
    seconds: float = 0.0
    command: str = ""
    errors: list[VerifyError] = field(default_factory=list)
    log_tail: str = ""
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.status in ("ready", "reused")

    def to_dict(self) -> dict:
        data = asdict(self)
        data["errors"] = [e.to_dict() for e in self.errors]
        return data


def _fill(text: str, port: int) -> str:
    return text.replace("{port}", str(port))


def _log_path(base: Path, name: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "app"
    directory = base / LOGS_DIRNAME
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{safe}.log"


def read_log(path: Path | str, tail_bytes: int = _LOG_TAIL_BYTES) -> str:
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - tail_bytes))
            return handle.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def probe(url: str, timeout: float = 2.0) -> int | None:
    """The HTTP status ``url`` answers with, or None when nothing answers.

    Loopback only, and never through a proxy: the app under test is on this
    machine, and `HTTPS_PROXY` must not see a request meant for it.
    """
    if not re.match(
        r"^https?://(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:/|$)", url
    ):
        return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(
            urllib.request.Request(url, method="GET"), timeout=timeout
        ) as resp:
            return int(resp.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)
    except (urllib.error.URLError, OSError, ValueError):
        return None


def _url_from_log(text: str) -> str:
    match = _URL_IN_LOG.search(text or "")
    if not match:
        return ""
    return f"http://127.0.0.1:{match.group('port')}"


def _popen(command: str, cwd: Path, env: dict[str, str], log) -> subprocess.Popen:
    kwargs: dict = {
        "cwd": str(cwd),
        "env": env,
        "stdout": log,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
    }
    if os.name == "nt":  # pragma: no cover - Windows leg
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
        return subprocess.Popen(command, shell=True, **kwargs)  # noqa: S602 - detected command
    kwargs["start_new_session"] = True
    return subprocess.Popen(shlex.split(command), **kwargs)  # noqa: S603 - detected command


def launch(
    target: Target,
    project_dir: Path | str,
    base: Path,
    *,
    timeout: float = 120.0,
    command: str | None = None,
    restart: bool = False,
) -> LaunchResult:
    """Launch ``target`` (or reuse it when it already runs). Never raises."""
    project = Path(project_dir)
    started = time.time()
    if target.kind == "mobile":
        return LaunchResult(
            target.name, "refused", detail="mobile targets launch through verify.mobile"
        )

    existing = live_process(base, target.name)
    if (
        existing
        and not restart
        and existing.get("url")
        and probe(existing["url"]) is not None
    ):
        log = read_log(existing.get("log", ""))
        return LaunchResult(
            target.name,
            "reused",
            url=existing["url"],
            pid=existing.get("pid"),
            log_path=existing.get("log", ""),
            command=existing.get("command", ""),
            errors=collect_errors(log, project, source=f"log:{target.name}"),
            log_tail=log[-4000:],
        )
    if existing:
        stop_process(base, target.name)

    raw_command = (command or target.command or "").strip()
    if not raw_command:
        return LaunchResult(target.name, "refused", detail="no launch command detected")

    port = free_port(target.port) if target.port else free_port()
    cwd = (project / target.root).resolve()
    try:
        cwd.relative_to(project.resolve())
    except ValueError:
        return LaunchResult(
            target.name, "refused", detail="target root escapes the project"
        )
    if not cwd.is_dir():
        return LaunchResult(
            target.name, "refused", detail=f"{target.root} is not a directory"
        )

    final_command = _fill(raw_command, port)
    if target.kind == "desktop" and "--remote-debugging-port" not in final_command:
        # Electron accepts Chromium switches after `--`: the debugging port is
        # what lets Chrome DevTools MCP attach for the trace and the clicks.
        final_command += f" -- --remote-debugging-port={port}"

    env = {**os.environ}
    for key, value in target.env.items():
        env[key] = _fill(value, port)
    for key in target.port_env:
        env[key] = str(port)
    env.setdefault("CI", "1")  # no interactive prompts, no browser auto-open
    env.setdefault("BROWSER", "none")
    env.setdefault("NO_COLOR", "1")
    env.setdefault("FORCE_COLOR", "0")

    log_path = _log_path(base, target.name)
    try:
        handle = open(log_path, "wb")  # noqa: SIM115 - handed to the child
    except OSError as exc:
        return LaunchResult(
            target.name, "refused", detail=f"cannot write the log: {exc}"
        )
    try:
        process = _popen(final_command, cwd, env, handle)
    except (OSError, ValueError) as exc:
        handle.close()
        return LaunchResult(
            target.name,
            "exited",
            command=final_command,
            log_path=str(log_path),
            detail=f"could not start: {exc}",
            errors=[
                VerifyError(
                    "launch",
                    f"could not start `{final_command}`: {exc}",
                    source="launch",
                )
            ],
        )
    finally:
        # The child holds its own descriptor; ours is not needed any more.
        if not handle.closed:
            handle.close()

    pgid = None
    if os.name != "nt":
        try:
            pgid = os.getpgid(process.pid)
        except OSError:
            pgid = process.pid
    preferred = f"http://127.0.0.1:{port}"
    ready_path = target.ready_path if target.ready_path.startswith("/") else "/"
    entry = {
        "pid": process.pid,
        "pgid": pgid,
        "url": "",
        "log": str(log_path),
        "command": final_command,
        "kind": target.kind,
        "root": target.root,
        "started_at": started,
        "owner_pid": os.getpid(),
    }
    save_process(base, target.name, entry)

    deadline = started + timeout
    url = ""
    while time.time() < deadline:
        code = process.poll()
        if code is not None:
            log = read_log(log_path)
            stop_process(base, target.name)
            return LaunchResult(
                target.name,
                "exited",
                pid=process.pid,
                log_path=str(log_path),
                exit_code=code,
                seconds=round(time.time() - started, 1),
                command=final_command,
                errors=collect_errors(log, project, source=f"log:{target.name}")
                or [
                    VerifyError(
                        "crash", f"the process exited with code {code}", source="launch"
                    )
                ],
                log_tail=log[-4000:],
                detail=f"exited with code {code} before answering",
            )
        candidates = [preferred]
        logged = _url_from_log(read_log(log_path, 20_000))
        if logged and logged not in candidates:
            candidates.append(logged)
        for candidate in candidates:
            status = probe(candidate + ready_path, timeout=1.5)
            if status is not None:
                url = candidate
                break
        if url:
            break
        time.sleep(0.5)

    log = read_log(log_path)
    if not url:
        stop_process(base, target.name)
        return LaunchResult(
            target.name,
            "timeout",
            pid=process.pid,
            log_path=str(log_path),
            seconds=round(time.time() - started, 1),
            command=final_command,
            errors=collect_errors(log, project, source=f"log:{target.name}"),
            log_tail=log[-4000:],
            detail=f"nothing answered on {preferred} within {int(timeout)}s",
        )

    entry["url"] = url
    save_process(base, target.name, entry)
    # Give the app a moment to print what it prints right after binding
    # (EF migrations, the first request's exception) before judging it.
    time.sleep(1.0)
    log = read_log(log_path)
    status = probe(url + ready_path)
    errors = collect_errors(log, project, source=f"log:{target.name}")
    if status is not None and status >= 500:
        errors.append(
            VerifyError("http", f"GET {ready_path} answered {status}", source="probe")
        )
    return LaunchResult(
        target.name,
        "ready",
        url=url,
        pid=process.pid if is_alive(process.pid) else None,
        log_path=str(log_path),
        seconds=round(time.time() - started, 1),
        command=final_command,
        errors=errors,
        log_tail=log[-4000:],
    )
