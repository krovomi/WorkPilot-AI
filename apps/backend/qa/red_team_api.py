"""The red team's record for the task card, and a fresh attack on request.

`GET /api/red-team/` reads ``red_team.json`` from both copies of the spec
directory (the project's and the task worktree's) and serves the more recent,
with the attack files' contents left out.

`POST /api/red-team/run` attacks the task's code now (its worktree when it
exists), with the QA provider and model, and records the result: a fresh
attack, never a replay. It runs an agent session and the project's tests, so in
server mode it answers to `agent.execute`; addressed by project and spec id
like `verify/api.py`, it is a desktop feature. It lives in `qa` beside the
gate whose session it opens, so `red_team` stays a leaf (`LOCAL_ONLY_FEATURES`).
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
from red_team import load_record, run_red_team, write_record

from .red_team_gate import make_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/red-team", tags=["red-team"])

__all__ = ["router"]


class RedTeamRunRequest(BaseModel):
    spec_dir: str | None = None
    project_dir: str | None = None
    spec_id: str | None = None


def _resolve(spec_dir, project_dir, spec_id) -> tuple[Path | None, dict | None]:
    try:
        return resolve_spec_dir(spec_dir, project_dir, spec_id), None
    except SpecAddressError as exc:
        logger.warning("invalid red team request: %s", exc)
        return None, {
            "success": False,
            "error": SPEC_ADDRESS_REASONS.get(
                exc.reason, SPEC_ADDRESS_REASONS["addressing"]
            ),
            "reason": exc.reason,
        }


def _project_of(spec_dir: Path) -> Path | None:
    if spec_dir.parent.name == "specs" and spec_dir.parent.parent.name == ".workpilot":
        return spec_dir.parent.parent.parent
    return None


def _worktree(project: Path, spec_id: str) -> Path | None:
    for candidate in (
        project / ".workpilot" / "worktrees" / "tasks" / spec_id,
        project / ".worktrees" / spec_id,
    ):
        if candidate.is_dir() and not candidate.is_symlink():
            return candidate
    return None


def _task_code(spec_dir: Path) -> tuple[Path, Path] | None:
    """The task's code (its worktree when it exists) and the spec copy beside it."""
    project = _project_of(spec_dir)
    if project is None:
        return None
    worktree = _worktree(project, spec_dir.name)
    if worktree is None:
        return project, spec_dir
    copy = worktree / ".workpilot" / "specs" / spec_dir.name
    return worktree, (copy if copy.is_dir() else spec_dir)


def _latest(spec_dir: Path) -> dict | None:
    found = _task_code(spec_dir)
    copies = [spec_dir] + ([found[1]] if found and found[1] != spec_dir else [])
    records = [r for c in copies if (r := load_record(c)) is not None]
    if not records:
        return None
    return max(records, key=lambda r: float(r.get("finished_at") or 0))


def _public(record: dict) -> dict:
    """The record for the card: the attack files' contents stay on disk."""
    out = {k: v for k, v in record.items() if k != "files"}
    out["attack_files"] = sorted((record.get("files") or {}).keys())
    return out


@router.get("/")
def red_team_record(
    spec_dir: str | None = Query(None),
    project_dir: str | None = Query(None),
    spec_id: str | None = Query(None),
):
    resolved, error = _resolve(spec_dir, project_dir, spec_id)
    if error or resolved is None:
        return error
    try:
        record = _latest(resolved)
    except OSError:
        logger.exception("red team record read failed")
        return {"success": False, "error": "An internal error has occurred."}
    return {"success": True, "record": _public(record) if record else None}


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


@router.post("/run")
async def red_team_run(body: RedTeamRunRequest):
    resolved, error = _resolve(body.spec_dir, body.project_dir, body.spec_id)
    if error or resolved is None:
        return error
    found = _task_code(resolved)
    if found is None:
        return {"success": False, "error": "the spec is not inside a project"}
    code_dir, spec_dir = found
    try:
        from phase_config import get_phase_model

        model = get_phase_model(spec_dir, "qa", None)
        base, files = _base_and_files(spec_dir, code_dir)
        report = await run_red_team(
            code_dir, base, files, session=make_session(spec_dir, model), previous=None
        )
        write_record(spec_dir, report)
        return {"success": True, "record": _public(report.to_dict())}
    except (ImportError, OSError, ValueError, RuntimeError):
        logger.exception("red team run failed")
        return {"success": False, "error": "An internal error has occurred."}
