"""The verification record for the Kanban, and a re-run on request.

`GET /api/verify/` answers the task panel: the record (`verify.json`), the
screenshots it names, and the settings that decide whether it runs. It reads
both copies of the spec directory — the project's and the task worktree's,
where a running build writes before the spec is synced back — and serves the
more recent, so the card shows a verification the moment it lands.

`POST /api/verify/run` runs the loop now, on the task's own code (the worktree
when it exists), with the provider the task configured for QA. It launches the
app and may run agent sessions, so in server mode it answers to
`agent.execute`; like `spec/api.py` it is addressed by project and spec id,
which server mode refuses outright — a desktop feature until a
`project_id`-addressed endpoint exists.

`GET /api/verify/screenshot` serves one screenshot the record names — never a
path from the request.
"""

from __future__ import annotations

import logging
from pathlib import Path

from core.api_safety import SPEC_ADDRESS_REASONS, SpecAddressError, resolve_spec_dir
from fastapi import APIRouter, Query
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from .record import load_record
from .settings import load_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/verify", tags=["verify"])

__all__ = ["router"]


class VerifyRunRequest(BaseModel):
    spec_dir: str | None = None
    project_dir: str | None = None
    spec_id: str | None = None
    #: ``low`` runs only the deterministic half (no verifier session).
    effort: str | None = None


def _resolve(spec_dir, project_dir, spec_id) -> tuple[Path | None, dict | None]:
    try:
        return resolve_spec_dir(spec_dir, project_dir, spec_id), None
    except SpecAddressError as exc:
        logger.warning("invalid verify request: %s", exc)
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


def _spec_copies(spec_dir: Path) -> list[Path]:
    copies = [spec_dir]
    project = _project_of(spec_dir)
    if project is not None:
        worktree = _worktree(project, spec_dir.name)
        if worktree is not None:
            copies.append(worktree / ".workpilot" / "specs" / spec_dir.name)
    return copies


def _latest(spec_dir: Path) -> tuple[dict | None, Path]:
    """The most recent record among the spec's copies, and where it lives."""
    best: tuple[float, dict, Path] | None = None
    for copy in _spec_copies(spec_dir):
        record = load_record(copy / "verify")
        if record is None:
            continue
        stamp = float(record.get("finished_at") or record.get("started_at") or 0)
        if best is None or stamp > best[0]:
            best = (stamp, record, copy)
    if best is None:
        return None, spec_dir
    return best[1], best[2]


def _public(record: dict, where: Path) -> dict:
    """The record without filesystem paths: screenshots become indices."""
    out = {k: v for k, v in record.items() if k not in ("agent",)}
    out["screenshots"] = [
        {
            "index": i,
            "label": s.get("label") or "",
            "platform": s.get("platform") or "web",
            "url": s.get("url") or "",
        }
        for i, s in enumerate(record.get("screenshots") or [])
    ]
    for item in out.get("perf") or []:
        item.pop("trace_path", None)
    for item in out.get("mobile") or []:
        item.pop("frame", None)
    for target in out.get("targets") or []:
        launch = target.get("launch") or {}
        launch.pop("log_path", None)
    return out


@router.get("/")
def verify_record(
    spec_dir: str | None = Query(None),
    project_dir: str | None = Query(None),
    spec_id: str | None = Query(None),
):
    resolved, error = _resolve(spec_dir, project_dir, spec_id)
    if error:
        return error
    try:
        record, where = _latest(resolved)
        project = _project_of(resolved)
        return {
            "success": True,
            "record": _public(record, where) if record else None,
            "settings": load_settings(project).to_dict(),
        }
    except Exception:  # noqa: BLE001
        logger.exception("verify record read failed")
        return {"success": False, "error": "An internal error has occurred."}


@router.get("/screenshot")
def verify_screenshot(
    index: int = Query(..., ge=0, le=200),
    spec_dir: str | None = Query(None),
    project_dir: str | None = Query(None),
    spec_id: str | None = Query(None),
):
    resolved, error = _resolve(spec_dir, project_dir, spec_id)
    if error:
        return JSONResponse(error, status_code=400)
    record, where = _latest(resolved)
    shots = (record or {}).get("screenshots") or []
    if index >= len(shots):
        return JSONResponse(
            {"success": False, "error": "no such screenshot"}, status_code=404
        )
    path = Path(str(shots[index].get("path") or ""))
    try:
        real = path.resolve(strict=True)
        allowed = [copy.resolve() for copy in _spec_copies(resolved)]
        if not any(real.is_relative_to(root) for root in allowed) or path.is_symlink():
            raise ValueError("outside the spec")
        if real.suffix.lower() not in (".png", ".jpg", ".jpeg"):
            raise ValueError("not an image")
    except (OSError, ValueError):
        return JSONResponse(
            {"success": False, "error": "screenshot unavailable"}, status_code=404
        )
    return FileResponse(
        real, media_type="image/png" if real.suffix.lower() == ".png" else "image/jpeg"
    )


@router.post("/run")
async def verify_run(body: VerifyRunRequest):
    resolved, error = _resolve(body.spec_dir, body.project_dir, body.spec_id)
    if error:
        return error
    project = _project_of(resolved)
    if project is None:
        return {"success": False, "error": "the spec is not inside a project"}
    worktree = _worktree(project, resolved.name)
    code_dir = worktree or project
    spec_dir = (
        (worktree / ".workpilot" / "specs" / resolved.name) if worktree else resolved
    )
    if not spec_dir.is_dir():
        spec_dir = resolved
    try:
        from verify.git import changed_files
        from workflows.runner import find_skill_body, phase_provider

        from .loop import LoopOptions, run_verify_loop
        from .phase import make_agent_runner

        explicit, provider = phase_provider(spec_dir, "qa")
        repo_root = Path(__file__).resolve().parents[3]
        found = find_skill_body(repo_root, "tooling", "verify", provider)
        try:
            from phase_config import get_phase_model

            model = get_phase_model(spec_dir, "qa", None)
        except Exception:  # noqa: BLE001
            model = ""
        runner = make_agent_runner(code_dir, spec_dir, model=model, provider=explicit)
        record = await run_verify_loop(
            code_dir,
            spec_dir,
            runner,
            LoopOptions(
                provider=provider or "",
                model=model,
                effort=(body.effort or "medium"),
                changed_files=changed_files(code_dir),
                skill_body=found[0] if found else "",
            ),
        )
        return {"success": True, "record": _public(record, spec_dir)}
    except Exception:  # noqa: BLE001
        logger.exception("verify run failed")
        return {"success": False, "error": "An internal error has occurred."}
