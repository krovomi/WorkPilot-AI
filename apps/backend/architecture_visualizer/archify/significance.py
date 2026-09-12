"""Determines the architectural significance of code changes.

This module analyzes what parts of an architecture model are affected by
code changes, helping determine if the architecture model needs updates.
"""

from __future__ import annotations

import fnmatch
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import ir as ir_module

# File patterns that typically affect system architecture
_STRUCTURAL_GLOBS = [
    "*/architecture.json",
    "*/structure.yaml",
    "src/**/component.ts",
    "src/**/component.tsx",
    "**/package.json",
    "**/pyproject.toml",
    "**/go.mod",
    "**/pom.xml",
    "**/Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
]

NEW_AREA_THRESHOLD = 3
"""Threshold for number of changes in unmapped areas to trigger remapping."""


@dataclass
class Significance:
    """Assessment of whether code changes affect the architecture."""

    significant: bool
    """True if the changes are architecturally significant."""

    matched_components: list[str]
    """Components whose modeled sources include changed files."""

    reason: str
    """Human-readable explanation of the assessment."""


def _is_structural_file(name: str) -> bool:
    """Check if a file name matches structural change patterns.

    Args:
        name: The file name to check.

    Returns:
        True if the file is considered a structural change.
    """
    return any(fnmatch.fnmatch(name, glob) for glob in _STRUCTURAL_GLOBS)


def _components_touching(baseline: dict[str, Any], changed: set[str]) -> list[str]:
    """Components whose cited sources include a changed file.

    A source may name a directory prefix as well as a file, so a changed path
    matches if it equals the source or starts with the source as a directory prefix.

    Args:
        baseline: The baseline architecture model.
        changed: Set of changed file paths.

    Returns:
        List of component IDs that touch changed files.
    """
    touched = []
    for component in baseline.get("components", []):
        for source in component.get("sources", []):
            if any(c == source or c.startswith(f"{source}/") for c in changed):
                touched.append(component["id"])
                break
    return touched


def assess(
    changed_files: list[str],
    baseline_path: Path | str,
) -> Significance:
    """Assess the architectural significance of changed files.

    Args:
        changed_files: List of file paths that were changed.
        baseline_path: Path to the baseline architecture model JSON.

    Returns:
        A Significance object describing the impact.
    """
    baseline_path = Path(baseline_path)
    changed = set(changed_files)

    # No baseline means everything is new
    if not baseline_path.exists():
        return Significance(
            significant=True,
            matched_components=[],
            reason="No baseline architecture model found — mapping the entire project",
        )

    try:
        baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return Significance(
            significant=True,
            matched_components=[],
            reason=f"Could not read baseline model: {exc}",
        )

    # Check for structural changes
    structural = [f for f in changed if _is_structural_file(f)]
    if structural:
        return Significance(
            significant=True,
            matched_components=_components_touching(baseline, changed),
            reason=f"Structural files changed: {', '.join(structural[:3])}",
        )

    # Check which components are touched
    matched = _components_touching(baseline, changed)
    if matched:
        return Significance(
            significant=True,
            matched_components=matched,
            reason=f"Changes in modeled components: {', '.join(matched)}",
        )

    # Check for changes outside every modelled component
    known = ir_module.source_paths(baseline)
    outside = [
        p for p in structural if not any(p == k or p.startswith(f"{k}/") for k in known)
    ]
    if len(outside) >= NEW_AREA_THRESHOLD:
        return Significance(
            significant=True,
            matched_components=[],
            reason="Changes outside every modelled component — may indicate new architecture areas",
        )

    return Significance(
        significant=False,
        matched_components=[],
        reason="No architecturally significant changes detected",
    )
