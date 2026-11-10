"""
Release Coordinator Runner

Discovers services in a project, whatever their stack (release_coordinator.manifests),
analyses recent commits against each service path, and builds a coordinated
release plan with semantic version bumps and changelog entries.

The release train (``release-train.yaml``, #362) has its own modes:

    --train                      the train file, its waves and problems, the calendar
    --start ENV [--services a,b] [--express] --approved-hash H
    --advance RUN --action continue|confirm|retry|rollback|abort [--target T] --approved-hash H
    --runs | --run RUN | --metrics
    --notes [--ai]               release notes for the whole train

A mode that runs commands needs ``--approved-hash``: the SHA-256 of the train
file the person approved, kept by the app outside the project. A file that no
longer has that hash runs nothing.

Output protocol (one JSON object per line, prefixed):
    RELEASE_COORDINATOR_EVENT:{"type": "progress", "data": {"status": "..."}}
    RELEASE_COORDINATOR_RESULT:{...}
    RELEASE_COORDINATOR_ERROR:"<message>"   (a JSON string)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from release_coordinator import runs as train_runs  # noqa: E402
from release_coordinator.gates import GateError  # noqa: E402
from release_coordinator.manifests import discover_services  # noqa: E402
from release_coordinator.notes import release_notes  # noqa: E402
from release_coordinator.release_engine import (  # noqa: E402
    ReleaseEngine,
    ReleaseTrainPlan,
    SemVer,
    ServiceRelease,
)
from release_coordinator.schedule import calendar  # noqa: E402
from release_coordinator.train import (  # noqa: E402
    Context,
    TrainError,
    drive,
    start,
    view,
)
from release_coordinator.train_file import TrainFileError  # noqa: E402
from release_coordinator.train_file import load as load_train


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _emit_event(event_type: str, data: dict[str, Any]) -> None:
    _emit("RELEASE_COORDINATOR_EVENT", {"type": event_type, "data": data})


def _git_log_for_path(
    project_path: Path, service_path: Path, max_commits: int
) -> list[str]:
    try:
        rel = service_path.relative_to(project_path)
    except ValueError:
        rel = Path(".")

    try:
        result = subprocess.run(  # noqa: S603
            [
                "git",
                "log",
                f"-{max_commits}",
                "--pretty=format:%s",
                "--",
                str(rel),
            ],
            cwd=str(project_path),
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        if result.returncode == 0:
            return [line for line in result.stdout.splitlines() if line.strip()]
    except (subprocess.SubprocessError, FileNotFoundError):
        pass
    return []


def _semver_to_dict(v: SemVer) -> dict[str, Any]:
    return {
        "major": v.major,
        "minor": v.minor,
        "patch": v.patch,
        "prerelease": v.prerelease,
    }


def _plan_to_dict(plan: ReleaseTrainPlan) -> dict[str, Any]:
    return {
        "id": plan.id,
        "status": plan.status.value,
        "allGatesPassed": plan.all_gates_passed,
        "summary": plan.summary,
        "createdAt": datetime.fromtimestamp(plan.created_at, tz=UTC).isoformat(),
        "services": [
            {
                "name": svc.name,
                "currentVersion": _semver_to_dict(svc.current_version),
                "nextVersion": _semver_to_dict(svc.next_version),
                "bumpType": svc.bump_type.value,
                "changelogEntries": svc.changelog_entries,
                "dependencies": svc.dependencies,
                "gates": {k: v.value for k, v in svc.gates.items()},
            }
            for svc in plan.services
        ],
        "gates": [
            {"name": g.name, "status": g.status.value, "message": g.message}
            for g in plan.gates
        ],
    }


def run_plan(project_path: Path, max_commits: int) -> dict[str, Any]:
    _emit_event("start", {"status": "Discovering services..."})
    discovered = discover_services(project_path)
    if not discovered:
        _emit_event("complete", {"status": "No services found"})
        empty_plan = ReleaseTrainPlan(id="release-empty")
        return _plan_to_dict(empty_plan)

    _emit_event(
        "progress",
        {"status": f"Found {len(discovered)} service(s), analyzing commits..."},
    )

    engine = ReleaseEngine()
    services: list[ServiceRelease] = []
    for svc_path, info in discovered:
        commits = _git_log_for_path(project_path, svc_path, max_commits)
        bump = engine.determine_bump(commits)
        current = SemVer.parse(info["version"])
        next_v = current.bump(bump)
        changelog = engine.generate_changelog(commits)
        services.append(
            ServiceRelease(
                name=info["name"],
                current_version=current,
                next_version=next_v,
                bump_type=bump,
                changelog_entries=changelog,
                dependencies=info.get("dependencies", []),
            )
        )

    plan = engine.plan_release(services)
    _emit_event(
        "complete",
        {"services": len(services), "status": plan.status.value},
    )
    return _plan_to_dict(plan)


def _versions(plan: dict[str, Any]) -> dict[str, tuple[str, str]]:
    def text(v: dict[str, Any]) -> str:
        base = f"{v['major']}.{v['minor']}.{v['patch']}"
        return base + (f"-{v['prerelease']}" if v.get("prerelease") else "")

    return {
        s["name"]: (text(s["currentVersion"]), text(s["nextVersion"]))
        for s in plan.get("services", [])
    }


def _context(project_path: Path) -> Context:
    train = load_train(project_path)
    if train is None:
        raise TrainError("the project has no release-train.yaml")
    folders: dict[str, str] = {}
    deps: dict[str, list[str]] = {}
    for svc_path, info in discover_services(project_path):
        try:
            rel = svc_path.relative_to(project_path).as_posix()
        except ValueError:
            continue
        folders[str(info["name"])] = "" if rel == "." else rel
        deps[str(info["name"])] = list(info.get("dependencies", []))
    emit = lambda kind, data: _emit_event("train", {"kind": kind, **data})  # noqa: E731
    return Context(
        root=project_path, train=train, folders=folders, manifest_deps=deps, emit=emit
    )


def _approved(ctx: Context, approved: str | None) -> None:
    if not approved or approved != ctx.train.sha256:
        raise TrainError("not_approved: the train file changed since you approved it")


def run_train(args: argparse.Namespace, project_path: Path) -> dict[str, Any]:
    if args.runs:
        return {"runs": train_runs.list_runs(project_path)}
    if args.run:
        return train_runs.load(project_path, args.run)
    if args.metrics:
        return {"months": train_runs.metrics(project_path)}
    if args.notes:
        plan = run_plan(project_path, args.max_commits)
        title = "Release " + datetime.now(UTC).date().isoformat()
        return release_notes(plan, title, ai=args.ai, project_dir=str(project_path))
    ctx = _context(project_path)
    if args.train:
        return {
            **view(ctx),
            "calendar": calendar(ctx.train.calendar, datetime.now(UTC)),
            "runs": train_runs.list_runs(project_path)[:10],
        }
    _approved(ctx, args.approved_hash)
    if args.start:
        services = [s for s in (args.services or "").split(",") if s] or None
        versions = _versions(run_plan(project_path, args.max_commits))
        run = start(ctx, args.start, versions, services=services, express=args.express)
        return drive(ctx, run["id"])
    return drive(ctx, args.advance, args.action, args.target or "")


def main() -> None:
    parser = argparse.ArgumentParser(description="Release Coordinator Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    parser.add_argument(
        "--max-commits",
        type=int,
        default=100,
        help="Maximum commits to analyse per service",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--train", action="store_true")
    mode.add_argument("--start", metavar="ENVIRONMENT")
    mode.add_argument("--advance", metavar="RUN")
    mode.add_argument("--runs", action="store_true")
    mode.add_argument("--run", metavar="RUN")
    mode.add_argument("--metrics", action="store_true")
    mode.add_argument("--notes", action="store_true")
    parser.add_argument("--services", default="")
    parser.add_argument("--express", action="store_true")
    parser.add_argument(
        "--action",
        choices=["continue", "confirm", "retry", "rollback", "abort"],
        default="continue",
    )
    parser.add_argument("--target", default="")
    parser.add_argument("--approved-hash", default="")
    parser.add_argument("--ai", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.max_commits <= 5000:
        _emit("RELEASE_COORDINATOR_ERROR", "--max-commits must be from 1 to 5000")
        sys.exit(1)

    project_path = Path(args.project_path).resolve()
    if not project_path.is_dir():
        _emit("RELEASE_COORDINATOR_ERROR", "the project folder does not exist")
        sys.exit(1)

    train_mode = any(
        (
            args.train,
            args.start,
            args.advance,
            args.runs,
            args.run,
            args.metrics,
            args.notes,
        )
    )
    try:
        result = (
            run_train(args, project_path)
            if train_mode
            else run_plan(project_path, args.max_commits)
        )
        _emit("RELEASE_COORDINATOR_RESULT", result)
    except (TrainError, TrainFileError, train_runs.RunError, GateError) as exc:
        _emit("RELEASE_COORDINATOR_ERROR", str(exc))
        sys.exit(1)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        _emit("RELEASE_COORDINATOR_ERROR", f"{type(exc).__name__}: {exc}"[:400])
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
