"""
Onboarding Agent Runner

Runs the OnboardingEngine against a project to generate a contextual
onboarding guide (tech stack, key files, conventions, getting started).

Output protocol (one JSON object per line, prefixed):
    ONBOARDING_EVENT:{"type": "progress", "data": {"status": "..."}}
    ONBOARDING_RESULT:{"guide": {...}, "package": {...}, "freshness": {...}}
    ONBOARDING_STATUS:{"known": bool, "stale": bool, "added": [...], ...}   (--status)
    ONBOARDING_NARRATION:{"paragraphs": {chapter: text}, ...}             (--narrate)
    ONBOARDING_ERROR:<message>
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from onboarding_agent import (  # noqa: E402
    OnboardingGuide,
    OnboardingPackageBuilder,
)
from onboarding_agent.messages import Text, raw, text  # noqa: E402
from onboarding_agent.onboarding_engine import scan_project  # noqa: E402
from onboarding_agent.story import (  # noqa: E402
    fingerprint,
    freshness,
    save_fingerprint,
)


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _emit_event(event_type: str, data: dict[str, Any]) -> None:
    _emit("ONBOARDING_EVENT", {"type": event_type, "data": data})


def _emit_status(event_type: str, status: Text) -> None:
    """Progress lines are read by a person too, so they are translated."""
    _emit_event(event_type, {"status": status.fallback, "statusI18n": status.to_dict()})


def _step(
    *,
    section: str,
    title_key: str,
    lines: list[Any],
    commands: list[str],
    minutes: int,
) -> dict[str, Any]:
    """One step of the guide, in both forms.

    ``content`` is the English markdown the CLI and older clients read;
    ``title_i18n`` and ``lines`` are what the UI translates.
    """
    title = text(title_key)
    return {
        "section": section,
        "title": title.fallback,
        "titleI18n": title.to_dict(),
        "content": "\n".join(f"- {line.fallback}" for line in lines),
        "lines": [line.to_dict() for line in lines],
        "commands": commands,
        "estimatedMinutes": minutes,
    }


def _guide_to_dict(guide: OnboardingGuide) -> dict[str, Any]:
    steps: list[dict[str, Any]] = []
    section_lines = guide.section_lines

    if guide.key_files:
        steps.append(
            _step(
                section="overview",
                title_key="step.keyFiles.title",
                lines=[
                    text(
                        "step.line.keyFile",
                        path=kf.path,
                        reason=kf.reason_i18n or raw(kf.reason),
                    )
                    for kf in guide.key_files
                ],
                commands=[],
                minutes=max(5, len(guide.key_files) * 2),
            )
        )

    if section_lines.get("getting_started"):
        steps.append(
            _step(
                section="setup",
                title_key="step.gettingStarted.title",
                lines=section_lines["getting_started"],
                commands=[c.command for c in guide.commands if c.category == "setup"],
                minutes=10,
            )
        )

    if section_lines.get("architecture"):
        steps.append(
            _step(
                section="architecture",
                title_key="step.architecture.title",
                lines=section_lines["architecture"],
                commands=[],
                minutes=10,
            )
        )

    if guide.conventions:
        steps.append(
            _step(
                section="conventions",
                title_key="step.conventions.title",
                lines=[
                    text(
                        "step.line.convention",
                        name=c.name_i18n or raw(c.name),
                        description=c.description_i18n or raw(c.description),
                    )
                    for c in guide.conventions
                ],
                commands=[],
                minutes=5,
            )
        )

    daily = [c for c in guide.commands if c.category in {"run", "build", "lint"}]
    if daily:
        steps.append(
            _step(
                section="workflows",
                title_key="step.workflows.title",
                lines=[
                    text(
                        "step.line.command",
                        label=c.label_i18n or raw(c.label),
                        command=c.command,
                    )
                    for c in daily
                ],
                commands=[c.command for c in daily],
                minutes=5,
            )
        )

    if section_lines.get("testing"):
        steps.append(
            _step(
                section="testing",
                title_key="step.testing.title",
                lines=section_lines["testing"],
                commands=[c.command for c in guide.commands if c.category == "test"],
                minutes=5,
            )
        )

    if section_lines.get("deployment"):
        steps.append(
            _step(
                section="deployment",
                title_key="step.deployment.title",
                lines=section_lines["deployment"],
                commands=[],
                minutes=5,
            )
        )

    total_minutes = (
        sum(int(step.get("estimatedMinutes", 0)) for step in steps)
        or guide.estimated_reading_time_min
    )

    summary = text(
        "summary",
        project=guide.project_name,
        technologies=len(guide.tech_stack),
        keyFiles=len(guide.key_files),
        conventions=len(guide.conventions),
        commands=len(guide.commands),
    )

    return {
        "projectName": guide.project_name,
        "techStack": list(guide.tech_stack),
        "steps": steps,
        "totalEstimatedMinutes": total_minutes,
        "generatedAt": datetime.now(tz=UTC).isoformat(),
        "summary": summary.fallback,
        "summaryI18n": summary.to_dict(),
    }


def run_status(project_path: Path) -> dict[str, Any]:
    """Whether the last tour still fits the project: no package is built."""
    root = project_path.resolve()
    scan = scan_project(root)
    return freshness(root, scan.files, scan.code_files)


def run_narration(project_path: Path, language: str) -> dict[str, Any]:
    """The chapters told in prose by the active text model."""
    from onboarding_agent.narrate import narrate

    package = OnboardingPackageBuilder().build(project_path)
    chapters = package.story.chapters if package.story is not None else []
    return narrate(chapters, language, project_dir=str(project_path.resolve()))


def run_scan(project_path: Path) -> dict[str, Any]:
    _emit_status("start", text("progress.analyzing"))
    root = project_path.resolve()
    scan = scan_project(root)
    before = freshness(root, scan.files, scan.code_files)
    builder = OnboardingPackageBuilder()
    package = builder.build(project_path)
    guide = package.guide
    digest, modules, manifests = fingerprint(scan.files, scan.code_files)
    save_fingerprint(root, digest, modules, manifests)
    _emit_status(
        "progress",
        text(
            "progress.generated",
            tour=len(package.tour),
            quiz=len(package.quiz),
            tasks=len(package.first_tasks),
            glossary=len(package.glossary),
        ),
    )
    result = {
        "guide": _guide_to_dict(guide),
        "package": package.to_dict(),
        # The tour just made fits the project; ``changed`` is what made the last one stale.
        "freshness": {
            "known": True,
            "stale": False,
            "added": [],
            "removed": [],
            "generatedAt": datetime.now(tz=UTC).isoformat(),
            "changed": {"added": before["added"], "removed": before["removed"]}
            if before["stale"]
            else None,
        },
    }
    _emit_event("complete", {"steps": len(result["guide"]["steps"])})
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Onboarding Agent Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--status", action="store_true", help="Only say whether the last tour is stale"
    )
    mode.add_argument(
        "--narrate", action="store_true", help="Tell the chapters with the active model"
    )
    parser.add_argument(
        "--language", default="en", help="Language of the narration (en, fr)"
    )
    args = parser.parse_args()

    project_path = Path(args.project_path)
    if not project_path.is_dir():
        _emit("ONBOARDING_ERROR", "Project path does not exist")
        sys.exit(1)
    if args.narrate and args.language not in {"en", "fr"}:
        _emit("ONBOARDING_ERROR", "Unsupported language")
        sys.exit(1)

    try:
        if args.status:
            _emit("ONBOARDING_STATUS", run_status(project_path))
        elif args.narrate:
            _emit("ONBOARDING_NARRATION", run_narration(project_path, args.language))
        else:
            _emit("ONBOARDING_RESULT", run_scan(project_path))
    except Exception as exc:  # noqa: BLE001
        _emit("ONBOARDING_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
