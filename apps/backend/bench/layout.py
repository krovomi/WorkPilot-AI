"""Where a bench run lives, and the names it accepts.

Two places, on purpose:

* ``<project>/.workpilot/bench/`` holds what the person reads: one manifest
  per run (``runs/<run id>.json``) and the cumulative table
  (``results.json``). ``.workpilot/`` is ignored by git, and a build never
  runs in the project itself.
* ``<data dir>/bench/<project key>/<run id>/`` holds the copies the builds and
  the judge run in. ``<data dir>`` is ``WORKPILOT_DATA_DIR`` or
  ``~/.workpilot``: outside the project, so that a copy is not inside the
  checkout that holds the answer, and so that the agent's write root (the
  copy) contains nothing but the copy.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
from datetime import UTC, datetime
from pathlib import Path

DATA_DIR_ENV = "WORKPILOT_DATA_DIR"

RUN_ID = re.compile(r"^\d{8}T\d{6}-[0-9a-f]{6}$")
# The spec id grammar of the backend (``^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$``).
SPEC_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
BUILD_ID = re.compile(r"^b\d{1,3}$")
COMMIT = re.compile(r"^[0-9a-f]{7,64}$")


class BenchError(ValueError):
    """A request the bench cannot carry out, said in a sentence."""


def data_root() -> Path:
    configured = os.environ.get(DATA_DIR_ENV, "").strip()
    return Path(configured) if configured else Path.home() / ".workpilot"


def project_key(project_dir: Path) -> str:
    digest = hashlib.sha256(str(project_dir.resolve()).encode("utf-8"))
    return digest.hexdigest()[:16]


def new_run_id() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%S") + "-" + secrets.token_hex(3)


def check_run_id(run_id: str) -> str:
    if not isinstance(run_id, str) or not RUN_ID.match(run_id):
        raise BenchError("invalid run id")
    return run_id


def work_dir(project_dir: Path, run_id: str) -> Path:
    """The run's copies, outside the project."""
    return data_root() / "bench" / project_key(project_dir) / check_run_id(run_id)


def bench_dir(project_dir: Path) -> Path:
    return project_dir / ".workpilot" / "bench"


def results_path(project_dir: Path) -> Path:
    return bench_dir(project_dir) / "results.json"


def manifest_path(project_dir: Path, run_id: str) -> Path:
    return bench_dir(project_dir) / "runs" / f"{check_run_id(run_id)}.json"


def config_path(project_dir: Path) -> Path:
    """The person's judge override. Read from the project, never from a copy."""
    return project_dir / ".workpilot" / "bench.json"


def main_project(path: Path) -> Path:
    """The project a path belongs to, out of a task worktree if it is in one.

    A build runs in ``<project>/.workpilot/worktrees/tasks/<spec>``; the
    bench results are the project's, not the worktree's.
    """
    parts = path.parts
    for index in range(len(parts) - 2):
        if parts[index] == ".workpilot" and parts[index + 1] == "worktrees":
            return Path(*parts[:index])
    return path


def read_json(path: Path) -> dict | None:
    if path.is_symlink():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def write_json(path: Path, data: dict) -> None:
    if path.is_symlink():
        raise BenchError(f"{path.name} is a symbolic link")
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".partial")
    partial.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(partial, path)


def now() -> str:
    return datetime.now(UTC).isoformat()
