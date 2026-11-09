"""The schema guard's record for the task card, and a check on request.

`GET /api/schema-guard/` reads ``schema_guard.json`` from both copies of the
spec directory (the project's and the task worktree's) and serves the more
recent one.

`POST /api/schema-guard/check` reads the task's migrations now (its worktree
when it exists) against the base the task started from, and records the
result. No model, no database: it reads files and git. Addressed by project
and spec id like `qa/red_team_api.py`, it is a desktop feature
(`LOCAL_ONLY_FEATURES`); it lives in `qa` beside the gate whose mode it
uses, so `schema_guard` stays a leaf.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Query
from foundation.api_safety import (
    SPEC_ADDRESS_REASONS,
    SpecAddressError,
    resolve_spec_dir,
)
from pydantic import BaseModel
from schema_guard import check, load_record, write_record

from .schema_gate import gate_mode

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/schema-guard", tags=["schema-guard"])

__all__ = ["router"]


class SchemaCheckRequest(BaseModel):
    spec_dir: str | None = None
    project_dir: str | None = None
    spec_id: str | None = None


def _resolve(spec_dir, project_dir, spec_id) -> tuple[Path | None, dict | None]:
    try:
        return resolve_spec_dir(spec_dir, project_dir, spec_id), None
    except SpecAddressError as exc:
        logger.warning("invalid schema guard request: %s", exc)
        return None, {
            "success": False,
            "error": SPEC_ADDRESS_REASONS.get(
                exc.reason, SPEC_ADDRESS_REASONS["addressing"]
            ),
            "reason": exc.reason,
        }


def _task_code(spec_dir: Path) -> tuple[Path, Path] | None:
    """The task's code (its worktree when it exists) and the spec copy beside it."""
    if not (
        spec_dir.parent.name == "specs" and spec_dir.parent.parent.name == ".workpilot"
    ):
        return None
    project = spec_dir.parent.parent.parent
    for worktree in (
        project / ".workpilot" / "worktrees" / "tasks" / spec_dir.name,
        project / ".worktrees" / spec_dir.name,
    ):
        if worktree.is_dir() and not worktree.is_symlink():
            copy = worktree / ".workpilot" / "specs" / spec_dir.name
            return worktree, (copy if copy.is_dir() else spec_dir)
    return project, spec_dir


def _latest(spec_dir: Path) -> dict | None:
    found = _task_code(spec_dir)
    copies = [spec_dir] + ([found[1]] if found and found[1] != spec_dir else [])
    records = [r for c in copies if (r := load_record(c)) is not None]
    if not records:
        return None
    return max(records, key=lambda r: float(r.get("checked_at") or 0))


@router.get("/")
def schema_guard_record(
    spec_dir: str | None = Query(None),
    project_dir: str | None = Query(None),
    spec_id: str | None = Query(None),
):
    resolved, error = _resolve(spec_dir, project_dir, spec_id)
    if error or resolved is None:
        return error
    try:
        return {"success": True, "record": _latest(resolved)}
    except OSError:
        logger.exception("schema guard record read failed")
        return {"success": False, "error": "An internal error has occurred."}


def _base_and_files(spec_dir: Path, code_dir: Path) -> tuple[str, list[str]]:
    from foundation.base_branch import detect_base_branch
    from foundation.git_executable import run_git

    base = detect_base_branch(spec_dir, code_dir) or "HEAD"
    merge_base = run_git(["merge-base", base, "HEAD"], cwd=code_dir)
    ref = merge_base.stdout.strip() if merge_base.returncode == 0 else base
    listed = run_git(["diff", "--name-only", "-z", ref], cwd=code_dir)
    new = run_git(["ls-files", "--others", "--exclude-standard", "-z"], cwd=code_dir)
    files = {n for n in (listed.stdout + "\0" + new.stdout).split("\0") if n}
    return ref, sorted(files)


@router.post("/check")
def schema_guard_check(body: SchemaCheckRequest):
    resolved, error = _resolve(body.spec_dir, body.project_dir, body.spec_id)
    if error or resolved is None:
        return error
    found = _task_code(resolved)
    if found is None:
        return {"success": False, "error": "the spec is not inside a project"}
    code_dir, spec_dir = found
    try:
        base, files = _base_and_files(spec_dir, code_dir)
        report = check(code_dir, files, base, mode=gate_mode(spec_dir))
        write_record(spec_dir, report)
        return {"success": True, "record": report.to_dict()}
    except (OSError, ValueError):
        logger.exception("schema guard check failed")
        return {"success": False, "error": "An internal error has occurred."}
