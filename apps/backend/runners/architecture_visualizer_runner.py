#!/usr/bin/env python3
"""Architecture Visualizer — the archify model of a project, and its per-task delta.

Three actions, one code path each:

``--action map``
    Author (or re-author) the project's baseline architecture model and render
    it. This is what the Architecture page runs.
``--action delta``
    Author the "after" model for one task, starting from the baseline so the
    component ids survive, and compare the two. This is what the Kanban's
    regenerate button runs; the `architecture-map` workflow phase runs the same
    `archify.task_delta.run_task_delta` inside the build.
``--action doctor``
    Whether archify can run here, and what is missing. Costs no API call and no
    subprocess beyond `node --version`, so the UI can ask on every panel open.

``--model`` and ``--thinking-level`` are honoured here rather than parsed and
dropped: authoring is a real agent session, resolved through
`phase_config.get_phase_model` like every other phase.

Every action prints a `__ARCH_VIZ_RESULT__:<json>` sentinel on stdout, which is
what the Electron service parses. The human-readable lines above it are for the
log pane.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from architecture_visualizer.archify import (  # noqa: E402
    ArchifyUnavailable,
    authoring,
    check,
    doctor,
)
from architecture_visualizer.archify import delta as delta_module  # noqa: E402
from architecture_visualizer.archify import ir as ir_module  # noqa: E402

# The baseline's location has one definition, shared with the workflow phase:
# two spellings of `.workpilot/architecture/` would be two answers to "does this
# project have a model yet".
from architecture_visualizer.archify.task_delta import (  # noqa: E402
    BASELINE_HTML,
    BASELINE_SPEC,
    baseline_dir,
    run_task_delta,
)

SENTINEL = "__ARCH_VIZ_RESULT__:"


def emit(payload: dict) -> None:
    print(SENTINEL + json.dumps(payload, default=str), flush=True)


def say(message: str) -> None:
    print(message, flush=True)


# --------------------------------------------------------------------------- #
# The agent session
# --------------------------------------------------------------------------- #


def _make_session(
    project_dir: Path, spec_dir: Path, model: str | None, thinking: str | None
):
    """A `(prompt) -> response` callable backed by the configured provider.

    Built here rather than inside `authoring` so the loop stays testable without
    a model, and so provider, phase model and thinking budget are resolved in
    one place — through `create_agent_client`, never `anthropic.Anthropic()`.
    """
    # Resolved on the first prompt, not here: the session is handed to
    # `run_task_delta` before significance is assessed, and a run that maps
    # nothing should not read — or fail on — the model settings it never uses.
    resolved: dict[str, object] = {}

    async def session(prompt: str) -> str:
        from agents.session import run_agent_session
        from core.client import create_agent_client
        from phase_config import get_phase_model, get_phase_thinking_budget
        from task_logger import LogPhase

        if not resolved:
            # The map is a reading-and-writing pass over a finished codebase,
            # which is the `qa` phase's budget shape rather than `coding`'s.
            resolved["model"] = get_phase_model(spec_dir, "qa", cli_model=model)
            resolved["budget"] = get_phase_thinking_budget(
                spec_dir, "qa", cli_thinking=thinking
            )
        client = create_agent_client(
            project_dir=project_dir,
            spec_dir=spec_dir,
            model=resolved["model"],
            agent_type="architecture_visualizer",
            max_thinking_tokens=resolved["budget"],
        )
        async with client:
            _status, response, _metadata = await run_agent_session(
                client, prompt, spec_dir, phase=LogPhase.VALIDATION
            )
        return response

    return session


# --------------------------------------------------------------------------- #
# Actions
# --------------------------------------------------------------------------- #


def action_doctor(project_dir: Path) -> dict:
    readiness = check()
    payload: dict = {
        "status": "success",
        "action": "doctor",
        "readiness": readiness.to_dict(),
        "baseline": None,
    }
    spec = baseline_dir(project_dir) / BASELINE_SPEC
    if spec.is_file():
        try:
            model = ir_module.load(spec)
        except ir_module.IRError as exc:
            payload["baseline"] = {"path": str(spec), "error": str(exc)}
        else:
            repository = (model.get("meta") or {}).get("repository") or {}
            payload["baseline"] = {
                "path": str(spec),
                "artifact": str(baseline_dir(project_dir) / BASELINE_HTML),
                "title": (model.get("meta") or {}).get("title", ""),
                "components": len(model.get("components", [])),
                "connections": len(model.get("connections", [])),
                "revision": repository.get("revision"),
            }
    if readiness.ok:
        payload["archify"] = doctor().stdout.strip().splitlines()[-1:] or []
    return payload


async def action_map(
    project_dir: Path, model: str | None, thinking: str | None
) -> dict:
    out = baseline_dir(project_dir)
    spec_path = out / BASELINE_SPEC
    artifact_path = out / BASELINE_HTML

    say("Collecting repository evidence…")
    session = _make_session(project_dir, out, model, thinking)
    result = await authoring.author(
        session=session,
        project_dir=project_dir,
        spec_path=spec_path,
        artifact_path=artifact_path,
        progress=say,
    )

    payload = {
        "status": "success" if result.ok else "error",
        "action": "map",
        "projectDir": str(project_dir),
        **result.to_dict(),
    }
    if result.ok:
        model_json = ir_module.load(spec_path)
        payload["components"] = len(model_json.get("components", []))
        payload["connections"] = len(model_json.get("connections", []))
        payload["title"] = (model_json.get("meta") or {}).get("title", "")
    return payload


async def action_delta(
    project_dir: Path,
    spec_dir: Path,
    changed_files: list[str] | None,
    task_summary: str,
    model: str | None,
    thinking: str | None,
    force: bool,
) -> dict:
    """The Delta tab's regenerate button: `task_delta.run_task_delta`, printed.

    The pipeline lives in `task_delta` so the `architecture-map` workflow phase
    runs the same one; this only turns its answer into the sentinel payload.
    """
    status = await run_task_delta(
        project_dir,
        spec_dir,
        session=_make_session(project_dir, spec_dir, model, thinking),
        changed_files=changed_files,
        task_summary=task_summary,
        force=force,
        progress=say,
    )
    if status.status in (
        delta_module.STATUS_NO_BASELINE,
        delta_module.STATUS_NOT_SIGNIFICANT,
    ):
        return {"status": "success", "action": "delta", "delta": status.to_dict()}

    mapped = status.status == delta_module.STATUS_MAPPED
    payload: dict = {
        "status": "success" if mapped else "error",
        "action": "delta",
        "error": "" if mapped else status.reason,
    }
    if status.diagnostics is not None:
        # Authoring is what failed: the diagnostics are the part worth reading.
        payload["diagnostics"] = status.diagnostics
    payload["delta"] = status.to_dict()
    return payload


# --------------------------------------------------------------------------- #


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Architecture Visualizer — archify models and per-task deltas"
    )
    parser.add_argument("--action", default="map", choices=["map", "delta", "doctor"])
    parser.add_argument("--project-dir", required=True)
    parser.add_argument(
        "--spec-dir", help="Spec directory of the task being mapped (delta only)"
    )
    parser.add_argument(
        "--changed-files",
        help="Newline- or comma-separated repository-relative paths (delta only)",
    )
    parser.add_argument(
        "--task-summary", default="", help="What the task set out to do"
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Map the task even when the change looks architecturally inert",
    )
    parser.add_argument("--model", help="Override the phase model")
    parser.add_argument(
        "--thinking-level",
        choices=["none", "low", "medium", "high", "ultrathink"],
        help="Override the phase thinking budget",
    )
    args = parser.parse_args()

    project_dir = Path(args.project_dir).expanduser().resolve()
    if not project_dir.is_dir():
        emit(
            {"status": "error", "error": f"project directory not found: {project_dir}"}
        )
        return 1

    try:
        if args.action == "doctor":
            emit(action_doctor(project_dir))
            return 0

        readiness = check()
        if not readiness.ok:
            emit(
                {
                    "status": "error",
                    "action": args.action,
                    "error": "; ".join(
                        c.remedy or c.detail for c in readiness.blockers
                    ),
                    "readiness": readiness.to_dict(),
                }
            )
            return 1

        if args.action == "map":
            payload = asyncio.run(
                action_map(project_dir, args.model, args.thinking_level)
            )
            emit(payload)
            return 0 if payload["status"] == "success" else 1

        if not args.spec_dir:
            emit(
                {
                    "status": "error",
                    "error": "--spec-dir is required for --action delta",
                }
            )
            return 1
        spec_dir = Path(args.spec_dir).expanduser().resolve()

        changed: list[str] | None = None
        if args.changed_files:
            raw = args.changed_files.replace(",", "\n").splitlines()
            changed = [line.strip() for line in raw if line.strip()]

        payload = asyncio.run(
            action_delta(
                project_dir=project_dir,
                spec_dir=spec_dir,
                changed_files=changed,
                task_summary=args.task_summary,
                model=args.model,
                thinking=args.thinking_level,
                force=args.force,
            )
        )
        emit(payload)
        return 0 if payload["status"] == "success" else 1

    except ArchifyUnavailable as exc:
        emit(
            {"status": "error", "error": str(exc), "readiness": exc.readiness.to_dict()}
        )
        return 1
    except KeyboardInterrupt:
        emit({"status": "cancelled"})
        return 1
    except Exception as exc:  # noqa: BLE001 - the sentinel must always be emitted
        emit({"status": "error", "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
