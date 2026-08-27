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

from core.api_safety import validated_dir
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
    "addressing": "pass spec_dir, or both project_dir and spec_id",
    "spec_id": "spec_id must be a plain directory name",
    "escapes": "spec_id escapes the project directory",
    "empty": "the path must be non-empty and must not start with '-'",
    "missing": "no such directory",
    "traversal": "the path must not contain '..'",
    "workflow": "unknown workflow",
}


class _BadRequest(ValueError):
    """A rejected request, named by a reason the caller may be told.

    The reason is a key into `_REASONS`, not free text, so what reaches the
    response is always a literal written here.
    """

    def __init__(self, reason: str, detail: str = "") -> None:
        self.reason = reason
        super().__init__(detail or reason)


def _validate_dir(raw: str, label: str) -> Path:
    """Normalise a caller-supplied directory path.

    Delegates to `core.api_safety.validated_dir`, which is where the
    normalisation, the length cap and the `..` refusal now live for every
    endpoint in this backend. Kept as a local function only to translate its
    `ValueError` into a `_BadRequest` carrying a `_REASONS` key.

    **The project directory is not confined to this repository, and must not
    be.** An autofix once "resolved" `py/path-injection` that way (PR #20):
    WorkPilot builds other people's projects, so the directory is outside
    this repository by definition, and confining it made the endpoint answer
    only for people building WorkPilot itself — ten red tests and an empty
    task panel for everyone else. `TestItAnswersForRealProjects` fails if it
    comes back.

    What guards traversal is elsewhere and is kept: `spec_id` must be a bare
    name, the derived spec directory must sit under the given project
    directory, and `workflow` is confined to `workflows/` — see
    `_resolve_spec_dir` and `_workflow_path`.
    """
    try:
        return validated_dir(raw, label)
    except ValueError as exc:
        # `validated_dir` names the rule that was broken; map it onto the
        # reason table so the caller still gets a literal from `_REASONS`
        # rather than a message built from their own input.
        text = str(exc)
        if "'..'" in text:
            raise _BadRequest("traversal", text) from None
        if "does not exist" in text:
            raise _BadRequest("missing", text) from None
        raise _BadRequest("empty", text) from None


def _resolve_spec_dir(
    spec_dir: str | None, project_dir: str | None, spec_id: str | None
) -> Path:
    """The spec directory, given either the path or the pair that names it.

    The renderer knows a task by its project and its spec id, not by an
    absolute path — so accepting the pair keeps the `.workpilot/specs/` layout
    written down once, here, instead of once here and once in TypeScript.

    Why the project directory is **not** confined to this repository
    ---------------------------------------------------------------
    Because WorkPilot builds other people's projects. `project_dir` is the
    checkout the user opened in the desktop app; it is outside this repository
    by definition, and requiring otherwise means the endpoint only answers for
    people building WorkPilot itself. That confinement was added to silence a
    `py/path-injection` alert and it silenced the feature with it.

    What actually guards the traversal, and is kept:

    * ``spec_id`` must be a bare directory name — no separator, no ``..``;
    * the derived spec directory must sit **under the project directory the
      caller gave**, so the pair form cannot address anything else;
    * ``workflow`` is resolved under ``workflows/`` in this repo (see
      `_workflow_path`), because that one *is* ours.

    The remaining input is an absolute path the local user chose in their own
    desktop app, read by a backend running as that same user. There is no
    privilege boundary there to cross — and `progress_indicator/api.py`, which
    takes the same input in the same way, is the existing convention.
    """
    if spec_dir:
        return _validate_dir(spec_dir, "spec_dir")
    if not (project_dir and spec_id):
        raise _BadRequest("addressing")
    if "/" in spec_id or "\\" in spec_id or spec_id in ("", ".", ".."):
        raise _BadRequest("spec_id", f"spec_id is not a directory name: {spec_id!r}")
    root = _validate_dir(project_dir, "project_dir")
    candidate = (root / ".workpilot" / "specs" / spec_id).resolve()
    if not candidate.is_relative_to(root):
        raise _BadRequest("escapes")
    return _validate_dir(str(candidate), "spec_dir")


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
        sd = _resolve_spec_dir(spec_dir, project_dir, spec_id)
        path = _workflow_path(workflow)
    except _BadRequest as exc:
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
    except Exception as exc:  # noqa: BLE001
        logger.exception("workflow profile resolution failed")
        return {"success": False, "error": "An internal error has occurred."}
