"""
Validation Module
=================

Spec validation with auto-fix capabilities.
"""

import json
from datetime import datetime
from pathlib import Path


def create_minimal_research(
    spec_dir: Path, reason: str = "No research needed", *, placeholder: bool = False
) -> Path:
    """Create minimal research.json file.

    ``placeholder=True`` when the researcher was asked and produced nothing:
    the file then says so (``"placeholder": true``) instead of reading like a
    research that found nothing to research, and a resumed build runs the
    phase again rather than skipping it because the file exists.
    """
    research_file = spec_dir / "research.json"
    payload = {
        "integrations_researched": [],
        "research_skipped": True,
        "reason": reason,
        "created_at": datetime.now().isoformat(),
    }
    if placeholder:
        payload["placeholder"] = True

    with open(research_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    return research_file


def create_minimal_critique(
    spec_dir: Path, reason: str = "Critique not required", *, placeholder: bool = False
) -> Path:
    """Create minimal critique_report.json file.

    A placeholder does not claim ``no_issues_found``: nobody looked. It used
    to, and the resume check reads that flag to skip the critique, so one
    failed critique meant the spec was never critiqued again.
    """
    critique_file = spec_dir / "critique_report.json"
    payload = {
        "issues_found": [],
        "no_issues_found": not placeholder,
        "critique_summary": reason,
        "created_at": datetime.now().isoformat(),
    }
    if placeholder:
        payload["placeholder"] = True

    with open(critique_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    return critique_file


def is_placeholder(path: Path) -> bool:
    """Whether a phase output file is a placeholder the agent never replaced.

    An unreadable file counts as one: it is not a result either.
    """
    try:
        return bool(json.loads(path.read_text(encoding="utf-8")).get("placeholder"))
    except (OSError, ValueError, AttributeError):
        return True


def create_empty_hints(spec_dir: Path, enabled: bool, reason: str) -> Path:
    """Create empty graph_hints.json file."""
    hints_file = spec_dir / "graph_hints.json"

    with open(hints_file, "w", encoding="utf-8") as f:
        json.dump(
            {
                "enabled": enabled,
                "reason": reason,
                "hints": [],
                "created_at": datetime.now().isoformat(),
            },
            f,
            indent=2,
        )

    return hints_file
