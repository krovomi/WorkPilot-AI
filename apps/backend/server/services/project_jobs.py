"""A feature's runner launched on a project's clone, in server mode.

The desktop app starts the roadmap, ideation and similar runners on the
person's computer against a local checkout. On a shared server the project is
the server's clone, so the server starts them, the way it starts a card's
runs (``run_manager``): confined to the project (``run_isolation``), with the
run environment (no server secret, the launcher's integration secrets), under
the deployment's ceiling and the organization's quota, never interactive.

What a job runs is decided here and by the feature's declaration
(``shared_features``), never by the client: the runner is a file of
``runners/``, its first arguments name the clone, and the rest come from a
closed list of options. One job at a time per feature of a project.

The app follows a job by reading its output (``output``): the last lines are
kept in memory, never written to disk or to the log, for as long as the job
is among the most recent ones.
"""

from __future__ import annotations

import asyncio
import re
import sys
import tempfile
import uuid
from collections import OrderedDict, deque
from datetime import UTC, datetime
from pathlib import Path

from server.db.engine import get_session_factory
from server.db.models import ProjectJob
from server.services.events import emit_board_event
from server.services.run_manager import (
    BACKEND_DIR,
    RunManagerError,
    confine,
    get_run_manager,
)
from sqlalchemy import select

FEATURE_KEY = re.compile(r"^[a-z][a-z0-9_-]{0,39}$")
RUNNER_NAME = re.compile(r"^[a-z][a-z0-9_]{0,60}\.py$")

#: Lines of a job's output kept for the app to follow, and the longest line.
OUTPUT_LINES = 400
LINE_CHARS = 2_000
#: Finished jobs whose output is still kept.
KEPT_JOBS = 50
FINAL = frozenset({"succeeded", "failed", "cancelled"})
INTERRUPTED = "Interrupted: the server stopped while the job ran"


class _Output:
    __slots__ = ("lines", "total")

    def __init__(self) -> None:
        self.lines: deque[str] = deque(maxlen=OUTPUT_LINES)
        self.total = 0

    def add(self, line: str) -> None:
        self.lines.append(line[:LINE_CHARS])
        self.total += 1

    def since(self, after: int) -> tuple[list[str], int]:
        first = self.total - len(self.lines)
        start = max(after, first) - first
        return list(self.lines)[start:], self.total


class ProjectJobs:
    """The project jobs of this server process."""

    def __init__(self) -> None:
        self._running: dict[tuple[str, str], str] = {}  # (project, feature) -> job
        self._active: dict[str, asyncio.subprocess.Process] = {}
        self._cancelled: set[str] = set()
        self._output: OrderedDict[str, _Output] = OrderedDict()

    def running_job(self, project_id: str, feature: str) -> str | None:
        """The job queued or running for this feature of the project."""
        return self._running.get((project_id, feature))

    def is_tracked(self, job_id: str) -> bool:
        """Whether this process is running (or about to run) the job."""
        return job_id in self._running.values()

    async def settle_orphans(self, project_id: str) -> None:
        """Mark failed the project's jobs left queued or running by a server
        that stopped: nothing will finish them, and they would hold a quota
        slot and show as running forever."""
        async with get_session_factory()() as db:
            jobs = await db.scalars(
                select(ProjectJob).where(
                    ProjectJob.project_id == project_id,
                    ProjectJob.status.in_(("queued", "running")),
                )
            )
            changed = False
            for job in jobs:
                if not self.is_tracked(job.id):
                    job.status = "failed"
                    job.error = INTERRUPTED
                    job.finished_at = datetime.now(UTC)
                    changed = True
            if changed:
                await db.commit()

    def output(self, job_id: str, after: int = 0) -> tuple[list[str], int]:
        """The lines after line ``after`` that are still kept, and the next index."""
        out = self._output.get(job_id)
        return out.since(max(after, 0)) if out else ([], max(after, 0))

    async def start(
        self,
        *,
        project_id: str,
        org_id: str | None,
        server_path: str,
        feature: str,
        runner: str,
        args: list[str],
        user_id: str,
    ) -> ProjectJob:
        """Queue a job and return its row (status ``queued``)."""
        if not FEATURE_KEY.match(feature) or not RUNNER_NAME.match(runner):
            raise RunManagerError("Unknown feature")
        runner_path = BACKEND_DIR / "runners" / runner
        if not runner_path.is_file():
            raise RunManagerError(f"This server has no {runner}")
        key = (project_id, feature)
        await self.settle_orphans(project_id)
        if org_id:
            from server.services.quotas import enforce_run_quota

            async with get_session_factory()() as db:
                await enforce_run_quota(db, org_id)
        if key in self._running:
            raise RunManagerError("A job is already running for this feature")

        # Checked and reserved with no await in between: two requests cannot
        # both pass the check and start two writers of the same files.
        job_id = str(uuid.uuid4())
        self._running[key] = job_id
        recorded = False
        try:
            async with get_session_factory()() as db:
                job = ProjectJob(
                    id=job_id,
                    project_id=project_id,
                    feature=feature,
                    started_by=user_id,
                    status="queued",
                )
                db.add(job)
                await db.commit()
                await db.refresh(job)
            recorded = True
        finally:
            if not recorded:
                self._running.pop(key, None)
        self._keep(job.id)
        cmd = [sys.executable, str(runner_path), "--project", server_path, *args]
        asyncio.get_running_loop().create_task(
            self._execute(job.id, key, server_path, cmd, user_id)
        )
        return job

    async def cancel(self, job_id: str) -> bool:
        """Stop a job, or keep a queued one from starting; false when it is
        not queued or running in this process."""
        if not self.is_tracked(job_id):
            return False
        self._cancelled.add(job_id)
        proc = self._active.get(job_id)
        if proc is not None:
            proc.terminate()
        return True

    def _keep(self, job_id: str) -> None:
        self._output[job_id] = _Output()
        while len(self._output) > KEPT_JOBS:
            oldest = next(iter(self._output))
            if oldest in self._running.values():
                break
            self._output.pop(oldest)

    async def _execute(
        self,
        job_id: str,
        key: tuple[str, str],
        server_path: str,
        cmd: list[str],
        user_id: str,
    ) -> None:
        project_id, feature = key
        out = self._output.get(job_id) or _Output()
        # What is recorded if the manager itself fails on the way (the
        # exception still reaches the event loop's handler).
        status = "failed"
        error: str | None = "The job stopped before it finished"
        manager = get_run_manager()
        try:
            async with manager.admission():
                if job_id in self._cancelled:
                    status, error = "cancelled", None
                    return
                await _set_status(job_id, "running")
                _notify(project_id, feature, job_id, "running", user_id)
                with tempfile.TemporaryDirectory(prefix="workpilot-job-") as scratch:
                    env = await manager.run_env(user_id, job_id)
                    argv = confine(cmd, project_id, server_path, Path(scratch), env)
                    proc = await asyncio.create_subprocess_exec(
                        *argv,
                        cwd=str(BACKEND_DIR),
                        env=env,
                        stdin=asyncio.subprocess.DEVNULL,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.STDOUT,
                    )
                    self._active[job_id] = proc
                    if proc.stdout is not None:
                        async for raw in proc.stdout:
                            line = raw.decode("utf-8", errors="replace").rstrip()
                            if line:
                                out.add(line)
                    await proc.wait()
                if job_id in self._cancelled:
                    status, error = "cancelled", None
                elif proc.returncode == 0:
                    status, error = "succeeded", None
                else:
                    # The tail of what it printed: the app shows it as the
                    # reason, as it shows a local runner's last lines.
                    error = "\n".join(list(out.lines)[-20:])[-2_000:] or (
                        f"The runner exited with code {proc.returncode}"
                    )
        finally:
            self._active.pop(job_id, None)
            self._running.pop(key, None)
            self._cancelled.discard(job_id)
            await _set_status(job_id, status, error)
            _notify(project_id, feature, job_id, status, user_id)


async def _set_status(job_id: str, status: str, error: str | None = None) -> None:
    async with get_session_factory()() as db:
        job = await db.get(ProjectJob, job_id)
        if job is None:
            return
        job.status = status
        job.error = error
        if status in FINAL:
            job.finished_at = datetime.now(UTC)
        await db.commit()


def _notify(
    project_id: str, feature: str, job_id: str, status: str, user_id: str
) -> None:
    emit_board_event(
        project_id,
        "feature_job",
        {"feature": feature, "job_id": job_id, "status": status, "by": user_id},
    )


_jobs: ProjectJobs | None = None


def get_project_jobs() -> ProjectJobs:
    global _jobs
    if _jobs is None:
        _jobs = ProjectJobs()
    return _jobs
