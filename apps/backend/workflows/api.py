"""What the chosen effort level buys, before the build starts.

Chantier 4 asks for the resolved profile to be shown *before* execution, so the
user sees what their effort setting bought or cost rather than inferring it
afterwards from a log. Until now it was printed to a terminal the Kanban user
never looks at.

This endpoint answers three questions the CLI banner answers, plus one it
cannot:

* which phases will run, in the order the workflow declares them;
* which were dropped, and by what — an effort level, or a change set with no
  matching files;
* which asked for a dispatch this provider cannot give;
* and **what the next level up would add**, which is the actual question
  someone is asking when they look at an effort selector.

Side effects
------------
None, deliberately. Provider resolution goes through `get_phase_provider`,
which reads metadata and the IPC selection and nothing else. The other
resolution path (`_get_active_provider`) consumes the single-shot
RESUME_WITH_PROVIDER marker, and an endpoint the UI may poll must never eat a
choice the next build was supposed to honour.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from core.api_safety import (
    SPEC_ADDRESS_REASONS,
    SpecAddressError,
    resolve_spec_dir,
)
from fastapi import APIRouter, Query

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/workflow-profile", tags=["workflow-profile"])

_REPO_ROOT = Path(__file__).resolve().parents[3]
_DEFAULT_WORKFLOW = "feature-build"


# What a caller is told when their request is rejected.
#
# The response never echoes an exception message. Those carry resolved
# filesystem paths, and a path is exactly the kind of detail an error is not
# supposed to hand back — CodeQL flags it, and it is right to. The detail still
# reaches the log, where the person debugging can see it and a caller cannot.
_REASONS = {
    **SPEC_ADDRESS_REASONS,
    # The one rejection that is this endpoint's own: `workflow` names a file
    # under `workflows/` in this repository, which — unlike a project
    # directory — is a root we own and therefore do confine.
    "workflow": "unknown workflow",
}


class _BadRequest(SpecAddressError):
    """A rejected request, named by a reason the caller may be told.

    The reason is a key into `_REASONS`, not free text, so what reaches the
    response is always a literal written here. Subclasses `SpecAddressError`
    so the addressing rules — which now live in `core.api_safety` alongside
    every other endpoint's — are caught by the same `except`.
    """


def _workflow_path(name: str) -> Path:
    """Resolve a workflow by name, refusing anything that escapes the folder.

    This root *is* ours — `workflows/` in this repository — so unlike the
    project directory it is confined, and that confinement is the point.
    """
    root = (_REPO_ROOT / "workflows").resolve()
    candidate = (root / name / "workflow.yaml").resolve()
    if not candidate.is_relative_to(root):
        raise _BadRequest("workflow", f"unknown workflow: {name}")
    return candidate


def _engine_enabled() -> bool:
    flag = os.environ.get("WORKPILOT_WORKFLOW_ENGINE", "1").strip().lower()
    return flag not in ("0", "false", "off", "no")


def _phase_payload(phase, *, resolved=None, skip_reason: str | None = None) -> dict:
    """One row of the pipeline, run or not.

    Dropped phases are returned too, in their declared position. A selector
    that only lists what survived cannot answer "what would I get for one level
    more", which is the whole reason someone opens it.
    """
    return {
        "id": phase.id,
        "impl": phase.impl,
        "pack": phase.pack,
        "skill": phase.skill,
        "description": phase.description.strip(),
        "minEffort": phase.min_effort,
        "hardGate": phase.hard_gate,
        "always": phase.always,
        "gate": phase.gate,
        "conditional": bool(phase.when_globs),
        "whenGlobs": list(phase.when_globs),
        "runs": resolved is not None,
        "dispatch": resolved.dispatch if resolved else phase.dispatch,
        "degradedFrom": resolved.degraded_from if resolved else None,
        "degradedReason": resolved.reason if resolved else "",
        "skipReason": skip_reason,
    }


def _serialise(workflow, profile, *, missing: list | None = None) -> dict:
    from .engine import DETERMINISTIC_PACKS

    by_id = {r.id: r for r in profile.run}
    skipped = {p.id: reason for p, reason in profile.skipped}

    phases = []
    for phase in workflow.phases:
        payload = _phase_payload(
            phase,
            resolved=by_id.get(phase.id),
            skip_reason=skipped.get(phase.id),
        )
        payload["deterministic"] = phase.pack in DETERMINISTIC_PACKS
        phases.append(payload)

    return {
        "workflow": workflow.name,
        "description": workflow.description.strip(),
        "effort": profile.effort,
        "provider": profile.provider,
        "enabled": _engine_enabled(),
        "phases": phases,
        "runCount": len(profile.run),
        "missing": [
            {"phaseId": m.phase_id, "impl": m.impl, "pack": m.pack, "reason": m.reason}
            for m in (missing or [])
        ],
    }


def _levels(workflow, provider: str | None) -> list[dict]:
    """What each effort level runs, so the UI can price a change of level.

    Resolved with no change set, which is the same forecast the CLI banner
    prints before a build: nothing is written yet, so a conditional phase can
    only be predicted, and the engine's "unknown means run it" rule makes that
    prediction the inclusive one.
    """
    from .engine import resolve_profile
    from .spec import EFFORT_ORDER

    out = []
    for level in EFFORT_ORDER:
        if level == "none":
            continue
        profile = resolve_profile(workflow, level, provider=provider)
        out.append(
            {
                "effort": level,
                "phaseIds": [r.id for r in profile.run],
                "count": len(profile.run),
            }
        )
    return out


def _missing_impls(workflow, profile) -> list:
    """Phases whose pack is not installed. Advisory, never fatal."""
    try:
        from skills_registry.packs import load_packs

        from .engine import validate_impls

        available = {
            p.name: {s.name for s in p.skills()}
            for p in load_packs(_REPO_ROOT / "skills")
        }
        return [
            m
            for m in validate_impls(workflow, available)
            if profile.will_run(m.phase_id)
        ]
    except Exception as exc:  # noqa: BLE001 - advisory only
        logger.debug("could not check phase implementations: %s", exc)
        return []


@router.get("/")
def workflow_profile(
    spec_dir: str | None = Query(None),
    project_dir: str | None = Query(None),
    spec_id: str | None = Query(None),
    effort: str | None = Query(None, description="Override the task's effort level"),
    provider: str | None = Query(None, description="Override the resolved provider"),
    workflow: str = Query(_DEFAULT_WORKFLOW),
    include_levels: bool = Query(True, alias="includeLevels"),
):
    """The resolved execution profile for a spec."""
    try:
        sd = resolve_spec_dir(spec_dir, project_dir, spec_id)
        path = _workflow_path(workflow)
    except SpecAddressError as exc:
        # The detail goes to the log; the caller gets the literal reason. An
        # exception message here would carry a resolved filesystem path.
        logger.warning("invalid workflow profile request: %s", exc)
        return {
            "success": False,
            "error": _REASONS.get(exc.reason, _REASONS["addressing"]),
            "reason": exc.reason,
        }

    try:
        from phase_config import get_phase_provider, get_phase_thinking

        from .engine import resolve_profile
        from .spec import load_workflow

        loaded = load_workflow(path)
        level = effort or get_phase_thinking(sd, "coding")
        # Side-effect-free provider resolution. See the module docstring.
        resolved_provider = provider or get_phase_provider(sd, phase="coding")

        profile = resolve_profile(loaded, level, provider=resolved_provider)
        payload = _serialise(loaded, profile, missing=_missing_impls(loaded, profile))
        if include_levels:
            payload["levels"] = _levels(loaded, resolved_provider)
        return {"success": True, "profile": payload}
    except Exception:  # noqa: BLE001
        logger.exception("workflow profile resolution failed")
        return {"success": False, "error": "An internal error has occurred."}
