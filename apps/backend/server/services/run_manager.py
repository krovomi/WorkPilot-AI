"""Server-side agent run execution.

Replaces the Electron AgentManager in server mode: runs are queued and
executed on the server as subprocesses (``runners/spec_runner.py`` for the
``spec`` phase, ``run.py`` for the others; see :func:`build_command`), never
interactive, tracked in the ``agent_runs`` table, and
streamed to clients through the existing WebSocket pipeline (the agent's
streaming wrapper authenticates with the injected WORKPILOT_WS_TOKEN).

Concurrency model:
- Global semaphore: at most ``MAX_CONCURRENT_RUNS`` agent processes.
- Per-spec exclusivity is enforced upstream by the claim model; the run
  manager additionally refuses two simultaneous runs on the same spec.
- A run survives client disconnections — it belongs to the server.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

from server.config import get_settings
from server.db.engine import get_session_factory
from server.db.models import AgentRun, SpecIndex, User
from server.services.events import emit_board_event
from server.services.push import notify_run_finished
from server.services.run_env import run_environment
from server.services.run_isolation import (
    OFF,
    isolation_mode,
    prepare_run,
    project_brain_env,
)
from server.services.secrets import get_user_secret
from sqlalchemy import select

logger = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parents[2]

#: Extra ``run.py`` args per phase, mirroring what the Electron AgentManager
#: passes. A run is never interactive (stdin is closed): ``--auto-continue``
#: answers the build's own prompts, and the spec approval the build checks is
#: given on the card (``shared_board``) or by spec creation when the card asks
#: for no review, never by ``--force``.
PHASE_ARGS: dict[str, list[str]] = {
    "build": ["--auto-continue"],
    "qa": ["--qa"],
    "merge": ["--merge"],
    "pr": ["--create-pr"],
}

#: Writes the spec (and its plan) from the card's description, then stops:
#: ``runners/spec_runner.py --no-build``.
SPEC_PHASE = "spec"
PHASES: tuple[str, ...] = (SPEC_PHASE, *PHASE_ARGS)


def _json_file(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def pr_arguments(options: dict | None, scratch: Path) -> list[str]:
    """``run.py --create-pr`` arguments for the PR dialog's edits.

    The body is a person's long text: it goes through a file in the run's
    scratch directory, never argv. Fields were validated by
    ``PullRequestOptions``.
    """
    if not options:
        return []
    args: list[str] = []
    if options.get("title"):
        # One token: a title starting with "-" is not read as an option.
        args.append(f"--pr-title={options['title']}")
    if options.get("body") is not None:
        body_file = scratch / "pr_body.md"
        body_file.write_text(str(options["body"]), encoding="utf-8")
        args += ["--pr-body-file", str(body_file)]
    if options.get("target_branch"):
        args += ["--pr-target", str(options["target_branch"])]
    if options.get("draft"):
        args.append("--pr-draft")
    if options.get("ignore_cross_review"):
        args.append("--pr-ignore-cross-review")
    return args


def build_command(
    phase: str,
    spec_name: str,
    server_path: str,
    model: str | None,
    scratch: Path,
    pr: dict | None = None,
) -> list[str]:
    """The argv of one run. `scratch` is a private directory the run may use."""
    if phase == SPEC_PHASE:
        spec_dir = Path(server_path) / ".workpilot" / "specs" / spec_name
        requirements = _json_file(spec_dir / "requirements.json")
        metadata = _json_file(spec_dir / "task_metadata.json")
        plan = _json_file(spec_dir / "implementation_plan.json")
        task = str(
            requirements.get("task_description")
            or plan.get("description")
            or plan.get("feature")
            or spec_name
        )
        # A file, not argv: the description is long and written by a person.
        task_file = scratch / "task.txt"
        task_file.write_text(task, encoding="utf-8")
        cmd = [
            sys.executable,
            str(BACKEND_DIR / "runners" / "spec_runner.py"),
            "--task-file",
            str(task_file),
            "--project-dir",
            server_path,
            "--spec-dir",
            str(spec_dir),
        ]
        # As in the app: a card that asks for no review goes on to its build
        # once its spec is written; one that does waits for a member's approval.
        if metadata.get("requireReviewBeforeCoding", True) is False:
            cmd.append("--auto-approve")
        else:
            cmd.append("--no-build")
    else:
        cmd = [
            sys.executable,
            str(BACKEND_DIR / "run.py"),
            "--spec",
            spec_name,
            "--project-dir",
            server_path,
            *PHASE_ARGS[phase],
        ]
        if phase == "pr":
            cmd += pr_arguments(pr, scratch)
    if model:
        cmd += ["--model", model]
    return cmd


#: Secrets injected into the run env when the launching user configured them.
USER_SECRET_ENV: dict[str, str] = {
    "azure_pat": "AZURE_DEVOPS_PAT",
    "jira_token": "JIRA_API_TOKEN",
    "linear_api_key": "LINEAR_API_KEY",
    "github_token": "GITHUB_TOKEN",
    "gitlab_token": "GITLAB_TOKEN",
}


class RunManagerError(RuntimeError):
    pass


def _mint_ws_token(run_id: str, hours: int = 12) -> str:
    """Service token for the agent's streaming connection.

    It names its run: the streaming server opens that run's channel for it and
    nothing else (``server.authz.ws_channels``), and the REST API grants it no
    permission at all.
    """
    import jwt as pyjwt

    settings = get_settings()
    now = datetime.now(UTC)
    return pyjwt.encode(
        {
            "iss": settings.jwt_issuer,
            "sub": "service:agent",
            "name": "WorkPilot Agent",
            "role": "service",
            "run": run_id,
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(hours=hours)).timestamp()),
        },
        settings.jwt_secret,
        algorithm="HS256",
    )


#: Each operator warning is logged once per process, not once per run.
_WARNED: set[str] = set()


def _warn_once(key: str, message: str) -> None:
    if key not in _WARNED:
        _WARNED.add(key)
        logger.warning(message)


def confine(
    cmd: list[str], project_id: str, server_path: str, scratch: Path, env: dict
) -> list[str]:
    """The run's argv, started confined to its own project unless the
    operator turned isolation off (``server.services.run_isolation``). Either
    way its brain is its project's."""
    settings = get_settings()
    env.update(project_brain_env(settings.repos_root, project_id))
    if isolation_mode() == OFF:
        _warn_once(
            "off",
            "WORKPILOT_RUN_ISOLATION=off: runs can read every project on this server",
        )
        return cmd
    if getattr(os, "geteuid", lambda: -1)() == 0:
        _warn_once(
            "root",
            "The server runs as root: CAP_SYS_PTRACE lets a run read other "
            "processes' environment despite its isolation; run it unprivileged",
        )
    prefix = prepare_run(
        project_id=project_id,
        clone=Path(server_path),
        scratch=scratch,
        repos_root=settings.repos_root,
        database_url=settings.database_url,
        env=env,
    )
    return [*prefix, *cmd]


class RunManager:
    """Singleton orchestrating server-side agent subprocesses."""

    def __init__(self) -> None:
        self._semaphore: asyncio.Semaphore | None = None
        self._active: dict[str, asyncio.subprocess.Process] = {}  # run_id -> proc
        self._running_specs: set[str] = set()
        self._cancelled: set[str] = set()  # run_ids terminated on request

    def _get_semaphore(self) -> asyncio.Semaphore:
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(get_settings().max_concurrent_runs)
        return self._semaphore

    def admission(self) -> asyncio.Semaphore:
        """The deployment-wide ceiling every agent process waits on, project
        jobs (``server.services.project_jobs``) included."""
        return self._get_semaphore()

    async def run_env(self, user_id: str, run_id: str) -> dict[str, str]:
        """The environment of one agent process, as :meth:`_build_env`."""
        return await self._build_env(user_id, run_id)

    async def start_run(
        self,
        spec: SpecIndex,
        project_id: str,
        server_path: str,
        phase: str,
        user_id: str,
        model: str | None = None,
        org_id: str | None = None,
        pr: dict | None = None,
    ) -> AgentRun:
        """Queue a run and return its DB row immediately (status=queued).

        ``org_id`` applies the tenant's own concurrency and budget ceiling on
        top of the deployment-wide semaphore. Without it one organization
        queueing twenty builds would own the server, since the global semaphore
        cannot tell whose work it is admitting.
        """
        if phase not in PHASES:
            raise RunManagerError(f"Unknown phase: {phase}")
        if spec.id in self._running_specs:
            raise RunManagerError("A run is already in progress for this spec")

        if org_id:
            from server.services.quotas import enforce_run_quota

            async with get_session_factory()() as quota_db:
                # Raises HTTPException(429/402) — checked before the spec is
                # reserved, so a refused run leaves no reservation behind.
                await enforce_run_quota(quota_db, org_id)

        # Reserve the spec BEFORE the first await. The reservation used to
        # happen after the DB round-trip below, so two concurrent requests
        # could both pass the check above and launch two agent processes on
        # the same worktree.
        self._running_specs.add(spec.id)
        try:
            async with get_session_factory()() as db:
                run = AgentRun(
                    spec_id=spec.id,
                    phase=phase,
                    started_by=user_id,
                    model=model,
                    status="queued",
                )
                db.add(run)
                await db.commit()
                run_id = run.id
        except Exception:
            self._running_specs.discard(spec.id)
            raise

        asyncio.get_running_loop().create_task(
            self._execute(
                run_id=run_id,
                spec_id=spec.id,
                spec_name=spec.spec_name,
                project_id=project_id,
                server_path=server_path,
                phase=phase,
                user_id=user_id,
                model=model,
                pr=pr,
            )
        )
        return run

    def is_running(self, spec_id: str) -> bool:
        """Whether a run is queued or active on this spec."""
        return spec_id in self._running_specs

    async def cancel_run(self, run_id: str) -> bool:
        proc = self._active.get(run_id)
        if proc is None:
            return False
        self._cancelled.add(run_id)
        proc.terminate()
        return True

    async def _build_env(self, user_id: str, run_id: str) -> dict[str, str]:
        """Run env: the server env without its own secrets, the run's WS token,
        and the launcher's integration secrets (``server.services.run_env``)."""

        env = run_environment(
            os.environ,
            {
                "WORKPILOT_WS_TOKEN": _mint_ws_token(run_id),
                "WORKPILOT_RUN_USER_ID": user_id,
            },
        )
        async with get_session_factory()() as db:
            for kind, env_name in USER_SECRET_ENV.items():
                try:
                    value = await get_user_secret(db, user_id, kind)
                except Exception as e:  # vault misconfig must not block runs
                    # Type only, never the message: this is the failure path of
                    # a secret read, and the backend that raised it is free to
                    # quote the value it was handling.
                    #
                    # `kind` stays, and keeps a `py/clear-text-logging` alert
                    # on this line. It is a key of USER_SECRET_ENV — the
                    # literal string "jira_token", never a token — and CodeQL
                    # is matching the name, not a value. Dropping it would
                    # leave an operator with "a secret failed to load" and no
                    # way to tell which integration to go and fix.
                    logger.warning(
                        "Could not read secret %s: %s", kind, type(e).__name__
                    )
                    continue
                if value:
                    env[env_name] = value
        return env

    async def _execute(
        self,
        run_id: str,
        spec_id: str,
        spec_name: str,
        project_id: str,
        server_path: str,
        phase: str,
        user_id: str,
        model: str | None,
        pr: dict | None = None,
    ) -> None:
        try:
            async with self._get_semaphore():
                await self._set_run_status(run_id, "running")
                await self._notify(
                    project_id, spec_id, spec_name, run_id, phase, user_id, "running"
                )

                with tempfile.TemporaryDirectory(prefix="workpilot-run-") as scratch:
                    cmd = build_command(
                        phase, spec_name, server_path, model, Path(scratch), pr
                    )
                    env = await self._build_env(user_id, run_id)
                    cmd = confine(cmd, project_id, server_path, Path(scratch), env)
                    logger.info("Run %s starting: %s", run_id, " ".join(cmd[:6]))
                    proc = await asyncio.create_subprocess_exec(
                        *cmd,
                        cwd=str(BACKEND_DIR),
                        env=env,
                        # Never interactive: a prompt would wait forever.
                        stdin=asyncio.subprocess.DEVNULL,
                        stdout=asyncio.subprocess.DEVNULL,  # agents log to task_logs/WS
                        stderr=asyncio.subprocess.PIPE,
                    )
                    self._active[run_id] = proc
                    _, stderr = await proc.communicate()

                if run_id in self._cancelled:
                    # terminate() makes the process exit non-zero; that is a
                    # cancellation, not a failure.
                    await self._set_run_status(run_id, "cancelled")
                    status = "cancelled"
                elif proc.returncode == 0:
                    await self._set_run_status(run_id, "succeeded")
                    status = "succeeded"
                else:
                    tail = (stderr or b"").decode(errors="replace")[-2000:]
                    await self._set_run_status(run_id, "failed", error=tail)
                    status = "failed"
                await self._notify(
                    project_id, spec_id, spec_name, run_id, phase, user_id, status
                )
        except Exception as e:
            logger.exception("Run %s crashed in the manager", run_id)
            await self._set_run_status(run_id, "failed", error=str(e)[:2000])
        finally:
            self._active.pop(run_id, None)
            self._running_specs.discard(spec_id)
            self._cancelled.discard(run_id)

    async def _set_run_status(
        self, run_id: str, status: str, error: str | None = None
    ) -> None:
        async with get_session_factory()() as db:
            run = await db.get(AgentRun, run_id)
            if run is None:
                return
            run.status = status
            run.error = error
            if status in {"succeeded", "failed", "cancelled"}:
                run.finished_at = datetime.now(UTC)
            await db.commit()

    async def _notify(
        self,
        project_id: str,
        spec_id: str,
        spec_name: str,
        run_id: str,
        phase: str,
        user_id: str,
        status: str,
    ) -> None:
        async with get_session_factory()() as db:
            user_name = await db.scalar(
                select(User.display_name).where(User.id == user_id)
            )
        notify_run_finished(project_id, spec_name, phase, status, user_id)
        emit_board_event(
            project_id,
            "spec_status_changed",
            {
                "spec_id": spec_id,
                "spec_name": spec_name,
                "run_id": run_id,
                "phase": phase,
                "run_status": status,
                "user_id": user_id,
                "user_name": user_name or "",
            },
        )


_run_manager: RunManager | None = None


def get_run_manager() -> RunManager:
    global _run_manager
    if _run_manager is None:
        _run_manager = RunManager()
    return _run_manager
