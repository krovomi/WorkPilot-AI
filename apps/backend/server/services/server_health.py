"""The server's health, for its operator: what ``/health`` does not say.

``/health`` answers anyone with one word, for a load balancer. This page
(``GET /admin/platform/health``, platform administrators only) says why:

- ``database``: a ``SELECT 1``, how long it took, and the schema revision;
- ``disk``: free space where the database, the clones and the data live;
  under 10 % free is ``degraded``, under 2 % ``error``;
- ``queue``: runs and jobs queued and running, against the server's limit;
- ``version``: the server's version and Python's;
- ``isolation``: whether each run is confined to its project (Landlock), as
  ``WORKPILOT_RUN_ISOLATION`` asks;
- ``jobs``: whether each periodic job of the server is running.

The page's ``status`` is the worst of its checks. Nothing here names a
person, a project or a path: volumes are named by their role.
"""

from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Literal

from server.config import get_settings
from server.db.models import AgentRun, ProjectJob
from server.services import run_isolation
from sqlalchemy import func, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

Status = Literal["ok", "degraded", "error"]
_ORDER: dict[str, int] = {"ok": 0, "off": 0, "degraded": 1, "error": 2}

#: Free space under which a volume is degraded, then in error (percent).
DISK_DEGRADED = 10.0
DISK_ERROR = 2.0

_BACKEND_DIR = Path(__file__).resolve().parents[2]
_VERSION = re.compile(r'__version__\s*=\s*"([^"]+)"')


def version() -> str:
    """The server's version, as the release writes it."""
    try:
        found = _VERSION.search(
            (_BACKEND_DIR / "__init__.py").read_text(encoding="utf-8")
        )
    except OSError:
        return "unknown"
    return found.group(1) if found else "unknown"


_PROBE = "from foundation.landlock import abi_version; print(abi_version())"
_abi: list[int | None] = []


def _probe_landlock() -> int | None:
    """The kernel's Landlock ABI, asked of a child Python as the guide does:
    ``server`` imports nothing of the backend (``tests/test_import_contracts.py``)."""
    try:
        done = subprocess.run(
            [sys.executable, "-c", _PROBE],
            cwd=_BACKEND_DIR,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    answer = done.stdout.strip()
    return int(answer) if done.returncode == 0 and answer.isdigit() else None


def landlock_abi() -> int | None:
    """The ABI, probed once per process: the kernel does not change under it."""
    if not _abi:
        _abi.append(_probe_landlock())
    return _abi[0]


def worst(statuses: list[str]) -> Status:
    top = max((_ORDER.get(s, 2) for s in statuses), default=0)
    return ("ok", "degraded", "error")[top]  # type: ignore[return-value]


async def database(db: AsyncSession) -> dict:
    started = time.monotonic()
    try:
        await db.execute(text("SELECT 1"))
    except SQLAlchemyError as e:
        return {"status": "error", "error": type(e).__name__}
    latency = round((time.monotonic() - started) * 1000, 1)
    try:
        revision = await db.scalar(text("SELECT version_num FROM alembic_version"))
    except SQLAlchemyError:
        # A database made by ``create_all`` (tests, a first start) has no
        # revision table yet.
        await db.rollback()
        revision = None
    return {"status": "ok", "latency_ms": latency, "revision": revision}


def _sqlite_file(url: str) -> Path | None:
    if not url.startswith("sqlite") or ":memory:" in url or "///" not in url:
        return None
    return Path(url.split("///", 1)[1])


def _volume(name: str, path: Path) -> dict:
    """The free space of the volume holding ``path`` (or its nearest parent)."""
    where = path
    while not where.exists() and where != where.parent:
        where = where.parent
    try:
        usage = shutil.disk_usage(where)
    except OSError as e:
        return {"name": name, "status": "error", "error": type(e).__name__}
    free = round(100 * usage.free / usage.total, 1) if usage.total else 0.0
    status = (
        "error" if free < DISK_ERROR else "degraded" if free < DISK_DEGRADED else "ok"
    )
    return {
        "name": name,
        "status": status,
        "free_bytes": usage.free,
        "total_bytes": usage.total,
        "free_percent": free,
    }


def disk() -> dict:
    settings = get_settings()
    data = os.environ.get("WORKPILOT_DATA_DIR") or str(Path.home() / ".workpilot")
    places = {"repositories": settings.repos_root, "data": Path(data)}
    sqlite = _sqlite_file(settings.database_url)
    if sqlite is not None:
        places["database"] = sqlite
    volumes = [_volume(name, Path(path)) for name, path in places.items()]
    return {"status": worst([v["status"] for v in volumes]), "volumes": volumes}


async def queue(db: AsyncSession) -> dict:
    async def count(model, status: str) -> int:
        return int(
            await db.scalar(select(func.count(model.id)).where(model.status == status))
            or 0
        )

    return {
        "status": "ok",
        "runs_queued": await count(AgentRun, "queued"),
        "runs_running": await count(AgentRun, "running"),
        "jobs_queued": await count(ProjectJob, "queued"),
        "jobs_running": await count(ProjectJob, "running"),
        "max_concurrent": get_settings().max_concurrent_runs,
    }


def isolation() -> dict:
    mode = run_isolation.isolation_mode()
    abi = landlock_abi()
    if mode == run_isolation.OFF:
        return {"status": "degraded", "mode": mode, "landlock_abi": abi}
    return {
        "status": "ok" if abi is not None else "error",
        "mode": mode,
        "landlock_abi": abi,
    }


def jobs() -> dict:
    from server.services import approval_escalation, usage_retention

    def state(module) -> str:
        task = getattr(module, "_task", None)
        if task is None:
            return "off"
        return "running" if not task.done() else "stopped"

    found = {
        "approval_escalation": state(approval_escalation),
        "usage_retention": state(usage_retention),
    }
    # The retention sweep always runs; escalation runs only when it is on.
    status = "degraded" if found["usage_retention"] != "running" else "ok"
    if found["approval_escalation"] == "stopped":
        status = "degraded"
    return {"status": status, **found}


async def report(db: AsyncSession) -> dict:
    """Every check, and the worst of their statuses."""
    checks = {
        "database": await database(db),
        "disk": disk(),
        "queue": await queue(db),
        "version": {
            "status": "ok",
            "version": version(),
            "python": platform.python_version(),
        },
        "isolation": isolation(),
        "jobs": jobs(),
    }
    return {
        "status": worst([c["status"] for c in checks.values()]),
        "checks": checks,
    }
