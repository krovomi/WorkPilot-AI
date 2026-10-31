"""The routes of a shared feature, in server mode: its files and its jobs.

A server-mode project is a clone on the server; a feature's files are that
clone's ``.workpilot/<feature>/``, the same files the desktop app and the
runners read. For each feature of ``shared_features.registry`` these routes:

- serve its files (``GET .../snapshot``), only those it declares, each under
  its size, with the SHA-256 the app sends back when it rewrites one;
- rewrite one (``PUT .../files/{name}``): a declared, writable JSON object,
  refused (409) when a teammate changed it since it was read, or while a job
  is writing the feature;
- start, follow and stop its job (``.../jobs``): the feature's runner on the
  clone, through ``server.services.project_jobs``.

Every route takes a ``project_id``, never a path, and resolves it through
``resolve_project_scope`` (the caller's tenant, a member of the project).
Changing anything needs a project role of ``member`` or more; a ``viewer``
reads. Each change is announced on ``project:<id>``.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import ProjectJob
from server.services.events import emit_board_event
from server.services.project_jobs import get_project_jobs
from server.services.run_manager import RunManagerError
from shared_board.cards import _require_writer
from shared_features.registry import Feature
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

#: The largest file a member may write, whatever the feature declares.
MAX_WRITE = 2_000_000


class FileWrite(BaseModel):
    content: str
    #: The SHA-256 of the file as it was read; none when it did not exist.
    base_sha256: str | None = None


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def feature_dir(scope: ProjectScope, feature: Feature) -> Path:
    """The feature's directory in the clone, refused if a link leads it out."""
    root = scope.path.resolve()
    directory = scope.path / feature.directory
    if directory.exists() and not directory.resolve().is_relative_to(root):
        raise HTTPException(status_code=409, detail="Feature directory unavailable")
    return directory


def read_file(directory: Path, name: str, limit: int) -> str | None:
    """A regular file under its size, as text; None otherwise."""
    path = directory / name
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
            return None
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def write_json_file(directory: Path, name: str, content: str) -> None:
    """Replace a file at once: a reader never sees half of it."""
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / name
    # Callers pass a declared name; still, nothing is written outside the
    # feature's directory whatever the name holds.
    if target.is_symlink() or os.path.dirname(
        os.path.normpath(target)
    ) != os.path.normpath(directory):
        raise HTTPException(status_code=409, detail="File unavailable")
    fd, tmp = tempfile.mkstemp(prefix=f".{name}.", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.replace(tmp, target)
    finally:
        # Gone once replaced; left only by a failed write.
        Path(tmp).unlink(missing_ok=True)


def job_public(job: ProjectJob) -> dict[str, Any]:
    return {
        "id": job.id,
        "feature": job.feature,
        "status": job.status,
        "started_by": job.started_by,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "error": _redact(job.error) if job.error else None,
    }


def _redact(text: str) -> str:
    from foundation.log_redaction import redact_text

    return redact_text(text)


def ensure_no_job(scope: ProjectScope, feature: Feature) -> None:
    if get_project_jobs().running_job(scope.project_id, feature.key) is not None:
        raise HTTPException(
            status_code=409, detail="A job is writing this feature; try again after it"
        )


def feature_router(feature: Feature) -> APIRouter:
    """The routes of one feature, under ``/api/features/<key>``."""
    router = APIRouter(prefix=f"/api/features/{feature.key}", tags=["features"])
    writable_names = {declared: declared for declared in feature.writable}

    @router.get("/snapshot")
    async def snapshot(
        scope: ProjectScope = Depends(resolve_project_scope),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        await get_project_jobs().settle_orphans(scope.project_id)
        directory = feature_dir(scope, feature)
        files: dict[str, dict[str, str]] = {}
        for name, limit in feature.files.items():
            content = read_file(directory, name, limit)
            if content is not None:
                files[name] = {"content": content, "sha256": sha256(content)}
        latest = await db.scalar(
            select(ProjectJob)
            .where(
                ProjectJob.project_id == scope.project_id,
                ProjectJob.feature == feature.key,
            )
            .order_by(ProjectJob.started_at.desc())
            .limit(1)
        )
        return {"files": files, "job": job_public(latest) if latest else None}

    @router.put("/files/{name}")
    async def write_file(
        name: str,
        request: Request,
        body: FileWrite,
        scope: ProjectScope = Depends(resolve_project_scope),
    ) -> dict[str, str]:
        principal = get_principal(request)
        _require_writer(scope, principal)
        # The file named is the declaration's own string, never the request's:
        # a name outside it has nothing to look up.
        declared = writable_names.get(name)
        if declared is None:
            raise HTTPException(status_code=404, detail="Unknown file")
        name = declared
        limit = min(feature.files.get(name, MAX_WRITE), MAX_WRITE)
        if len(body.content.encode("utf-8")) > limit:
            raise HTTPException(status_code=413, detail="File too large")
        try:
            value = json.loads(body.content)
        except ValueError as e:
            raise HTTPException(status_code=422, detail="Not JSON") from e
        if not isinstance(value, dict):
            raise HTTPException(status_code=422, detail="Not a JSON object")
        ensure_no_job(scope, feature)
        directory = feature_dir(scope, feature)
        current = read_file(directory, name, limit)
        if (current is None) != (body.base_sha256 is None) or (
            current is not None and sha256(current) != body.base_sha256
        ):
            raise HTTPException(
                status_code=409, detail="Changed on the server since it was read"
            )
        write_json_file(directory, name, body.content)
        digest = sha256(body.content)
        emit_board_event(
            scope.project_id,
            "feature_updated",
            {"feature": feature.key, "file": name, "by": principal.id},
        )
        return {"sha256": digest}

    @router.post("/jobs", status_code=202)
    async def start_job(
        request: Request,
        options: dict[str, Any] = Body(default_factory=dict),
        scope: ProjectScope = Depends(resolve_project_scope),
    ) -> dict[str, Any]:
        principal = get_principal(request)
        _require_writer(scope, principal)
        try:
            parsed = feature.options.model_validate(options)
        except ValueError as e:
            raise HTTPException(status_code=422, detail="Invalid options") from e
        try:
            job = await get_project_jobs().start(
                project_id=scope.project_id,
                org_id=scope.org_id,
                server_path=str(scope.path),
                feature=feature.key,
                runner=feature.runner,
                args=feature.args(parsed),
                user_id=principal.id,
            )
        except RunManagerError as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
        return job_public(job)

    async def own_job(db: AsyncSession, scope: ProjectScope, job_id: str) -> ProjectJob:
        job = await db.get(ProjectJob, job_id)
        if (
            job is None
            or job.project_id != scope.project_id
            or job.feature != feature.key
        ):
            raise HTTPException(status_code=404, detail="Job not found")
        return job

    @router.get("/jobs/{job_id}")
    async def get_job(
        job_id: str,
        after: int = Query(default=0, ge=0),
        scope: ProjectScope = Depends(resolve_project_scope),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        jobs = get_project_jobs()
        job = await own_job(db, scope, job_id)
        if job.status in ("queued", "running") and not jobs.is_tracked(job.id):
            await jobs.settle_orphans(scope.project_id)
            await db.refresh(job)
        lines, following = jobs.output(job.id, after)
        return {
            **job_public(job),
            "lines": [_redact(line) for line in lines],
            "next": following,
        }

    @router.post("/jobs/{job_id}/cancel")
    async def cancel_job(
        job_id: str,
        request: Request,
        scope: ProjectScope = Depends(resolve_project_scope),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, bool]:
        _require_writer(scope, get_principal(request))
        job = await own_job(db, scope, job_id)
        return {"cancelled": await get_project_jobs().cancel(job.id)}

    return router
