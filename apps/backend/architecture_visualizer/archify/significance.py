"""Did this task change the architecture, or only files?

The workflow's `when: touches(...)` is a glob and nothing more — it can say
"a `.ts` changed", which is most tasks. It cannot say "a component moved". That
second question needs the baseline model, and answering it here, from paths
alone, is what keeps the phase from spending an API call on a rename.

The shape is deliberately the one `libdocs.run_preflight` uses: read files,
decide, and let the phase return without a model when there is nothing to map.
A phase that always runs and usually reports "no change" is a phase people
learn to ignore.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from fnmatch import fnmatch
from pathlib import Path
from typing import Any

from . import ir as ir_module

logger = logging.getLogger(__name__)

#: Extensions that can carry a component. A `.md` or a `.json` fixture cannot
#: move a boundary; a Dockerfile or a Terraform file very much can.
_STRUCTURAL_GLOBS = (
    "*.py",
    "*.ts",
    "*.tsx",
    "*.js",
    "*.jsx",
    "*.mjs",
    "*.go",
    "*.rs",
    "*.java",
    "*.cs",
    "*.kt",
    "*.rb",
    "*.php",
    "*.swift",
    "Dockerfile",
    "docker-compose*.yml",
    "docker-compose*.yaml",
    "*.tf",
    "*.csproj",
    "pyproject.toml",
    "package.json",
    "go.mod",
    "pom.xml",
    "requirements*.txt",
)

#: Directories whose contents describe the build, not the system.
_IGNORED_PARTS = frozenset(
    {
        "node_modules",
        ".git",
        "__pycache__",
        ".venv",
        "venv",
        "dist",
        "build",
        "out",
        ".workpilot",
    }
)

#: A task that only edits tests changes the evidence about the architecture, not
#: the architecture. Matched on path segments, not on file names, so
#: `src/tester.py` is not mistaken for a test.
_TEST_PARTS = frozenset({"tests", "test", "__tests__", "spec", "e2e"})

#: How many structural files a task must touch outside the model before the
#: change is worth mapping on the strength of new files alone. One new helper
#: module is not a topology change; a new package usually is.
NEW_AREA_THRESHOLD = 3


@dataclass(frozen=True)
class Significance:
    """Whether to author a model for this task, and the reason either way."""

    significant: bool
    reason: str
    matched_components: list[str] = field(default_factory=list)
    structural_files: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "significant": self.significant,
            "reason": self.reason,
            "matchedComponents": self.matched_components,
            "structuralFiles": self.structural_files[:50],
        }


def _normalise(path: str) -> str:
    return path.replace("\\", "/").lstrip("./")


def is_structural(path: str) -> bool:
    """Whether this file can carry a component at all."""
    normalised = _normalise(path)
    parts = set(Path(normalised).parts)
    if parts & _IGNORED_PARTS:
        return False
    if parts & _TEST_PARTS:
        return False
    name = Path(normalised).name
    return any(fnmatch(name, glob) for glob in _STRUCTURAL_GLOBS)


def _components_touching(baseline: dict[str, Any], changed: set[str]) -> list[str]:
    """Components whose cited sources include a changed file.

    A source may name a directory prefix as well as a file, so a changed path
    under a cited path counts — otherwise a component declared against
    `apps/backend/agents` would never match any of its own files.
    """
    matched: list[str] = []
    for component in baseline.get("components", []):
        if not isinstance(component, dict) or not component.get("id"):
            continue
        for source in component.get("sources", []) or []:
            if not isinstance(source, dict) or not source.get("path"):
                continue
            cited = _normalise(str(source["path"]))
            if any(c == cited or c.startswith(f"{cited}/") for c in changed):
                matched.append(str(component["id"]))
                break
    return matched


def assess(
    changed_files: list[str] | None,
    baseline_path: Path | None = None,
) -> Significance:
    """Decide, from paths only, whether this task is worth mapping.

    An unknown change set runs the phase: refusing on absent evidence would
    make every provider that cannot report a diff unmappable, which is the same
    reflex that keeps a hard gate from blocking on no signal.
    """
    if changed_files is None:
        return Significance(
            significant=True,
            reason="the set of changed files is unknown, so the task is mapped",
        )

    structural = sorted({_normalise(p) for p in changed_files if is_structural(p)})
    if not structural:
        return Significance(
            significant=False,
            reason="no file that can carry a component was changed",
        )

    baseline: dict[str, Any] | None = None
    if baseline_path is not None and baseline_path.is_file():
        try:
            baseline = ir_module.load(baseline_path)
        except ir_module.IRError as exc:
            logger.debug("baseline unusable for significance: %s", exc)

    if baseline is None:
        return Significance(
            significant=True,
            reason=(
                f"{len(structural)} structural file(s) changed and there is no "
                "baseline model to compare against"
            ),
            structural_files=structural,
        )

    matched = _components_touching(baseline, set(structural))
    if matched:
        return Significance(
            significant=True,
            reason=f"{len(matched)} modelled component(s) own a changed file",
            matched_components=sorted(set(matched)),
            structural_files=structural,
        )

    known = ir_module.source_paths(baseline)
    outside = [
        p for p in structural if not any(p == k or p.startswith(f"{k}/") for k in known)
    ]
    if len(outside) >= NEW_AREA_THRESHOLD:
        return Significance(
            significant=True,
            reason=(
                f"{len(outside)} structural file(s) sit outside every modelled "
                "component, which the model does not describe yet"
            ),
            structural_files=structural,
        )

    return Significance(
        significant=False,
        reason=(
            "the changed files belong to no modelled component and are too few "
            "to be a new one"
        ),
        structural_files=structural,
    )
