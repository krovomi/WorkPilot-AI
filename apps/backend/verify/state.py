"""Where a verification keeps its files, and which processes it owns.

Two processes can drive one verification: the build (`verify.loop`) and, on
the Claude path, the `workpilot-verify` MCP server the SDK launched for the
`verifier` session. They share nothing in memory, so what one launched the
other must be able to find, reuse and — at teardown — stop. That is this file:
`<spec_dir>/verify/state.json`, one entry per launched target (process group,
URL, log path).

Without a spec directory (the MCP server attached to a project by a person,
the CLI on a bare project) the same layout lives under
`<project>/.workpilot/verify/`.
"""

from __future__ import annotations

import json
import os
import signal
import time
from pathlib import Path

__all__ = [
    "work_dir",
    "load_state",
    "save_process",
    "forget_process",
    "live_process",
    "stop_process",
    "stop_all",
    "is_alive",
]

STATE_FILE = "state.json"


def work_dir(project_dir: Path | str, spec_dir: Path | str | None) -> Path:
    base = (
        Path(spec_dir) / "verify"
        if spec_dir
        else Path(project_dir) / ".workpilot" / "verify"
    )
    base.mkdir(parents=True, exist_ok=True)
    return base


def _path(base: Path) -> Path:
    return base / STATE_FILE


def load_state(base: Path) -> dict:
    try:
        data = json.loads(_path(base).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"processes": {}}
    if not isinstance(data, dict) or not isinstance(data.get("processes"), dict):
        return {"processes": {}}
    return data


def _write(base: Path, data: dict) -> None:
    target = _path(base)
    partial = target.with_suffix(".json.partial")
    try:
        partial.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(partial, target)
    except OSError:
        pass


def is_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def save_process(base: Path, name: str, entry: dict) -> None:
    data = load_state(base)
    data["processes"][name] = {**entry, "updated_at": time.time()}
    _write(base, data)


def forget_process(base: Path, name: str) -> None:
    data = load_state(base)
    if data["processes"].pop(name, None) is not None:
        _write(base, data)


def live_process(base: Path, name: str) -> dict | None:
    """The recorded entry for ``name`` when its process still runs."""
    entry = load_state(base)["processes"].get(name)
    if isinstance(entry, dict) and is_alive(entry.get("pid")):
        return entry
    return None


def _terminate(pid: int, pgid: int | None) -> None:
    if os.name == "nt":  # pragma: no cover - exercised on the Windows CI leg
        import subprocess

        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True,
            check=False,
        )
        return
    target_group = pgid or pid
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(target_group, sig)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                os.kill(pid, sig)
            except (ProcessLookupError, PermissionError, OSError):
                return
        deadline = time.time() + 5
        while time.time() < deadline:
            if not is_alive(pid):
                return
            time.sleep(0.1)


def stop_process(base: Path, name: str) -> bool:
    entry = load_state(base)["processes"].get(name)
    if not isinstance(entry, dict):
        return False
    pid = entry.get("pid")
    if isinstance(pid, int) and is_alive(pid):
        _terminate(pid, entry.get("pgid"))
    forget_process(base, name)
    return True


def stop_all(base: Path) -> list[str]:
    """Stop every process this verification launched, whoever launched it."""
    stopped = []
    for name in list(load_state(base)["processes"]):
        if stop_process(base, name):
            stopped.append(name)
    return stopped
