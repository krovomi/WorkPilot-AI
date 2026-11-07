"""A block of ports per task, so two worktrees never open the same one.

`<WORKPILOT_DATA_DIR>/ports.json` (default `~/.workpilot/ports.json`) maps a
task's key (its project and spec) to the first port of its block. Blocks are
ten ports wide from 20000, whatever count a recipe asks for, so a recipe
that grows does not overlap its neighbour; a block whose ports are taken by
something else on the machine is skipped. A lock file serialises the
machine's builds; one older than `_STALE_SECONDS` is a crashed holder's.
"""

from __future__ import annotations

import json
import os
import socket
import time
from contextlib import contextmanager
from pathlib import Path

__all__ = ["BLOCK", "release_ports", "reserve_ports", "reserved_port"]

BLOCK = 10
_FIRST = 20000
_LAST = 29990
_STALE_SECONDS = 30.0
_WAIT_SECONDS = 10.0


def _registry() -> Path:
    base = os.environ.get("WORKPILOT_DATA_DIR") or str(Path.home() / ".workpilot")
    return Path(base) / "ports.json"


@contextmanager
def _locked(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.with_name(path.name + ".lock")
    deadline = time.monotonic() + _WAIT_SECONDS
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > _STALE_SECONDS:
                    lock.unlink(missing_ok=True)
                    continue
            except OSError:
                continue
            if time.monotonic() > deadline:
                raise TimeoutError(f"{lock} is held") from None
            time.sleep(0.05)
    try:
        yield
    finally:
        lock.unlink(missing_ok=True)


def _read(path: Path) -> dict[str, int]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): v for k, v in data.items() if isinstance(v, int)}


def _write(path: Path, data: dict[str, int]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _free(port: int, count: int) -> bool:
    for candidate in range(port, port + count):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", candidate))
            except OSError:
                return False
    return True


def task_key(project_dir: Path | str, spec_name: str) -> str:
    return f"{Path(project_dir).resolve()}::{spec_name}"


def reserve_ports(project_dir: Path | str, spec_name: str, count: int) -> int | None:
    """The first port of the task's block, reserved; the same block on a resume."""
    if count <= 0:
        return None
    key = task_key(project_dir, spec_name)
    path = _registry()
    with _locked(path):
        data = _read(path)
        if key in data:
            return data[key]
        taken = set(data.values())
        for port in range(_FIRST, _LAST + 1, BLOCK):
            if port not in taken and _free(port, min(count, BLOCK)):
                data[key] = port
                _write(path, data)
                return port
    return None


def reserved_port(project_dir: Path | str, spec_name: str) -> int | None:
    return _read(_registry()).get(task_key(project_dir, spec_name))


def release_ports(project_dir: Path | str, spec_name: str) -> bool:
    """Give the task's block back. Whether it held one."""
    key = task_key(project_dir, spec_name)
    path = _registry()
    if key not in _read(path):  # most tasks never held one: no lock, no file
        return False
    with _locked(path):
        data = _read(path)
        if data.pop(key, None) is None:
            return False
        _write(path, data)
    return True
