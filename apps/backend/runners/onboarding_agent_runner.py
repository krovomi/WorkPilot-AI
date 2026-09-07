"""
Onboarding Agent Runner

Runs the OnboardingEngine against a project to generate a contextual
onboarding guide (tech stack, key files, conventions, getting started).

Output protocol (one JSON object per line, prefixed):
    ONBOARDING_EVENT:{"type": "progress", "data": {"status": "..."}}
    ONBOARDING_RESULT:{"guide": {...}}
    ONBOARDING_ERROR:<message>
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from onboarding_agent import (  # noqa: E402
    OnboardingGuide,
    OnboardingPackageBuilder,
)
from onboarding_agent.messages import Text, raw, text  # noqa: E402


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
        "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
        "summary": summary.fallback,
        "summaryI18n": summary.to_dict(),
    }


def run_scan(project_path: Path) -> dict[str, Any]:
    _emit_status("start", text("progress.analyzing"))
    builder = OnboardingPackageBuilder()
    package = builder.build(project_path)
    guide = package.guide
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
    }
    _emit_event("complete", {"steps": len(result["guide"]["steps"])})
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Onboarding Agent Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    args = parser.parse_args()

    project_path = Path(args.project_path)
    if not project_path.exists():
        _emit("ONBOARDING_ERROR", f"Project path does not exist: {project_path}")
        sys.exit(1)

    try:
        result = run_scan(project_path)
        _emit("ONBOARDING_RESULT", result)
    except Exception as exc:  # noqa: BLE001
        _emit("ONBOARDING_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
