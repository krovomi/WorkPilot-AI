"""
Release Coordinator Runner

Discovers services in a project, whatever their stack (release_coordinator.manifests),
analyses recent commits against each service path, and builds a coordinated
release plan with semantic version bumps and changelog entries.

Output protocol (one JSON object per line, prefixed):
    RELEASE_COORDINATOR_EVENT:{"type": "progress", "data": {"status": "..."}}
    RELEASE_COORDINATOR_RESULT:{...plan dict...}
    RELEASE_COORDINATOR_ERROR:<message>
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

from release_coordinator.manifests import discover_services  # noqa: E402
from release_coordinator.release_engine import (  # noqa: E402
    ReleaseEngine,
    ReleaseTrainPlan,
    SemVer,
    ServiceRelease,
)


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


def main() -> None:
    parser = argparse.ArgumentParser(description="Release Coordinator Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    parser.add_argument(
        "--max-commits",
        type=int,
        default=100,
        help="Maximum commits to analyse per service",
    )
    args = parser.parse_args()

    project_path = Path(args.project_path)
    if not project_path.exists():
        _emit(
            "RELEASE_COORDINATOR_ERROR",
            f"Project path does not exist: {project_path}",
        )
        sys.exit(1)

    try:
        result = run_plan(project_path, args.max_commits)
        _emit("RELEASE_COORDINATOR_RESULT", result)
    except Exception as exc:  # noqa: BLE001
        _emit("RELEASE_COORDINATOR_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
