#!/usr/bin/env python3
"""Architecture Visualizer — the archify model of a project, and its per-task delta.

Three actions, one code path each:

``--action map``
    Author (or re-author) the project's baseline architecture model and render
    it. This is what the Architecture page runs.
``--action delta``
    Author the "after" model for one task, starting from the baseline so the
    component ids survive, and compare the two. This is what the workflow phase
    and the Kanban's regenerate button run.
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
    assess,
    authoring,
    check,
    compare_models,
    doctor,
)
from architecture_visualizer.archify import delta as delta_module  # noqa: E402
from architecture_visualizer.archify import ir as ir_module  # noqa: E402

SENTINEL = "__ARCH_VIZ_RESULT__:"

#: Under `<project>/.workpilot/architecture/`.
BASELINE_SPEC = "baseline.arch.json"
BASELINE_HTML = "baseline.html"


def emit(payload: dict) -> None:
    print(SENTINEL + json.dumps(payload, default=str), flush=True)


def say(message: str) -> None:
    print(message, flush=True)


def baseline_dir(project_dir: Path) -> Path:
    return project_dir / ".workpilot" / "architecture"


# --------------------------------------------------------------------------- #
# The agent session
# --------------------------------------------------------------------------- #


def _make_session(project_dir: Path, spec_dir: Path, model: str | None, thinking: str | None):
    """A `(prompt) -> response` callable backed by the configured provider.

    Built here rather than inside `authoring` so the loop stays testable without
    a model, and so provider, phase model and thinking budget are resolved in
    one place — through `create_agent_client`, never `anthropic.Anthropic()`.
    """
    from core.client import create_agent_client
    from phase_config import get_phase_model, get_phase_thinking_budget

    # The map is a reading-and-writing pass over a finished codebase, which is
    # the `qa` phase's budget shape rather than `coding`'s.
    resolved_model = get_phase_model(spec_dir, "qa", cli_model=model)
    budget = get_phase_thinking_budget(spec_dir, "qa", cli_thinking=thinking)

    async def session(prompt: str) -> str:
        from agents.session import run_agent_session
        from task_logger import LogPhase

        client = create_agent_client(
            project_dir=project_dir,
            spec_dir=spec_dir,
            model=resolved_model,
            agent_type="architecture_visualizer",
            max_thinking_tokens=budget,
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
    baseline_path = baseline_dir(project_dir) / BASELINE_SPEC
    if not baseline_path.is_file():
        status = delta_module.write_status(
            spec_dir,
            delta_module.DeltaStatus(
                status=delta_module.STATUS_NO_BASELINE,
                reason=(
                    "this project has no architecture model yet — generate one "
                    "from the Architecture page to compare against"
                ),
            ),
        )
        return {"status": "success", "action": "delta", **status.to_dict()}

    if not force:
        significance = assess(changed_files, baseline_path)
        if not significance.significant:
            status = delta_module.write_status(
                spec_dir,
                delta_module.DeltaStatus(
                    status=delta_module.STATUS_NOT_SIGNIFICANT,
                    reason=significance.reason,
                ),
            )
            say(f"No architectural change: {significance.reason}")
            return {"status": "success", "action": "delta", **status.to_dict()}
        say(f"Mapping this task: {significance.reason}")

    head_path = delta_module.directory(spec_dir) / delta_module.HEAD_SPEC
    baseline = ir_module.load(baseline_path)

    session = _make_session(project_dir, spec_dir, model, thinking)
    authored = await authoring.author(
        session=session,
        project_dir=project_dir,
        spec_path=head_path,
        # The head model's own artifact is a by-product: what the card shows is
        # the comparison. Rendering it anyway is what proves the model is sound
        # before it is compared against anything.
        artifact_path=delta_module.directory(spec_dir) / "head.html",
        baseline=baseline,
        task_summary=task_summary,
        changed_files=changed_files,
        progress=say,
    )
    if not authored.ok:
        status = delta_module.write_status(
            spec_dir,
            delta_module.DeltaStatus(
                status=delta_module.STATUS_FAILED, reason=authored.error
            ),
        )
        return {
            "status": "error",
            "action": "delta",
            "diagnostics": authored.diagnostics,
            **status.to_dict(),
        }

    say("Comparing against the baseline…")
    status = compare_models(spec_dir, baseline_path, head_path, project_dir)
    return {
        "status": "success" if status.status == delta_module.STATUS_MAPPED else "error",
        "action": "delta",
        **status.to_dict(),
    }


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
    parser.add_argument("--task-summary", default="", help="What the task set out to do")
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
        emit({"status": "error", "error": f"project directory not found: {project_dir}"})
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
            payload = asyncio.run(action_map(project_dir, args.model, args.thinking_level))
            emit(payload)
            return 0 if payload["status"] == "success" else 1

        if not args.spec_dir:
            emit({"status": "error", "error": "--spec-dir is required for --action delta"})
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
        emit({"status": "error", "error": str(exc), "readiness": exc.readiness.to_dict()})
        return 1
    except KeyboardInterrupt:
        emit({"status": "cancelled"})
        return 1
    except Exception as exc:  # noqa: BLE001 - the sentinel must always be emitted
        emit({"status": "error", "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
