"""Checkpoints for the spec of a task's kind, when this repository's history asks.

A card has a kind (``tasks.classify``: bug fix, feature, refactoring…). Each
kind has a few checkpoints a spec of that kind should cover: reproduce a bug
in a failing test before fixing it, name the behaviour a refactoring must not
change. Writing them into every spec would be noise. They go to the spec
writer and its critic only when the project's own history says specs of this
kind come back from QA: its last tasks of this kind needed, on average, more
than one and a half QA passes, or two in five were rejected at the first. The
block says so, with the numbers, so the model knows why it is there.

History is read from the spec directories of the project (``task_metadata.json``
for the kind, ``implementation_plan.json`` for ``qa_iteration_history``), the
same files the build writes, for every stack and every provider. No model.
Table-tested in ``tests/test_applied_lessons.py``.
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .applied import Lesson

#: The newest spec directories read for history.
MAX_SPECS = 200
#: Fewer finished tasks of a kind than this is no history.
MIN_TASKS = 3
#: Average QA passes from which a kind's specs get their checkpoints.
MIN_AVERAGE_PASSES = 1.5
#: Or the share of them rejected at their first QA pass.
MIN_FIRST_REJECTIONS = 0.4

CHECKPOINTS: dict[str, tuple[str, ...]] = {
    "bug_fix": (
        "Reproduce the bug in a failing automated test before changing the code, and keep that test.",
        "Name the root cause, not only the symptom, and the other callers it may affect.",
    ),
    "hotfix": (
        "Keep the change to the smallest diff that removes the failure; list what is left for a follow-up.",
        "Reproduce the failure in a test first whenever the stack allows it.",
    ),
    "feature": (
        "Write each acceptance criterion so that a test or a command can check it.",
        "Name the edge cases: empty input, errors, permissions, the largest expected size.",
    ),
    "refactoring": (
        "State the behaviour that must not change and the existing tests that prove it; do not edit those tests.",
        "Split the work so that every step leaves the build and the tests green.",
    ),
    "upgrade": (
        "List the breaking changes of the new version that touch this code, and how each is handled.",
        "Name the command that proves the project still builds and its tests pass after the upgrade.",
    ),
    "test": (
        "Name the behaviour each new test pins down, and make each test fail without the code it covers.",
    ),
}


@dataclass(frozen=True)
class KindHistory:
    kind: str
    tasks: int
    average_passes: float
    first_rejections: float
    issue_types: tuple[str, ...]

    @property
    def needs_checkpoints(self) -> bool:
        return self.tasks >= MIN_TASKS and (
            self.average_passes >= MIN_AVERAGE_PASSES
            or self.first_rejections >= MIN_FIRST_REJECTIONS
        )


def _json(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _spec_dirs(project_dir: Path) -> list[Path]:
    specs = Path(project_dir) / ".workpilot" / "specs"
    if specs.is_symlink() or not specs.is_dir():
        return []
    try:
        found = [d for d in specs.iterdir() if d.is_dir() and not d.is_symlink()]
    except OSError:
        return []
    return sorted(found, key=lambda d: d.name, reverse=True)[:MAX_SPECS]


def history(project_dir: Path, kind: str, exclude: Path | None = None) -> KindHistory:
    """What QA made of this project's finished tasks of ``kind``."""
    passes: list[int] = []
    rejected_first = 0
    issues: Counter[str] = Counter()
    skip = exclude.resolve() if exclude is not None else None
    for spec in _spec_dirs(project_dir):
        if skip is not None and spec.resolve() == skip:
            continue
        if _json(spec / "task_metadata.json").get("kind") != kind:
            continue
        plan = _json(spec / "implementation_plan.json")
        runs = [
            r for r in plan.get("qa_iteration_history") or [] if isinstance(r, dict)
        ]
        if not runs:
            continue
        passes.append(len(runs))
        if runs[0].get("status") == "rejected":
            rejected_first += 1
        by_type = (plan.get("qa_stats") or {}).get("issues_by_type")
        if isinstance(by_type, dict):
            for name, count in by_type.items():
                if isinstance(name, str) and isinstance(count, int) and count > 0:
                    issues[name[:40]] += count
    done = len(passes)
    return KindHistory(
        kind=kind,
        tasks=done,
        average_passes=sum(passes) / done if done else 0.0,
        first_rejections=rejected_first / done if done else 0.0,
        issue_types=tuple(
            name for name, _ in issues.most_common(3) if name != "unknown"
        ),
    )


def checkpoints_for(
    project_dir: Path, kind: str | None, agent: str, spec_dir: Path | None = None
) -> tuple[list[Lesson], KindHistory | None]:
    """The checkpoints this kind's spec gets here, and the history that asked for them."""
    if not kind or kind not in CHECKPOINTS:
        return [], None
    seen = history(project_dir, kind, exclude=spec_dir)
    if not seen.needs_checkpoints:
        return [], seen
    lessons = [
        Lesson(
            id=f"checkpoint-{kind}-{index}", kind="checkpoint", text=text, agent=agent
        )
        for index, text in enumerate(CHECKPOINTS[kind], 1)
    ]
    return lessons, seen


def render(lessons: list[Lesson], seen: KindHistory | None) -> str:
    if not lessons or seen is None:
        return ""
    label = seen.kind.replace("_", " ")
    why = (
        f"The last {seen.tasks} {label} tasks of this repository needed "
        f"{seen.average_passes:.1f} QA passes on average, and "
        f"{round(seen.first_rejections * 100)}% were rejected at their first pass"
    )
    if seen.issue_types:
        why += f" (most frequent issue types: {', '.join(seen.issue_types)})"
    lines = [f"## Checkpoints for {label} specs in this repository", "", why + ".", ""]
    lines += ["Make the spec cover:"] + [f"- {lesson.text}" for lesson in lessons]
    return "\n".join(lines) + "\n"


__all__ = ["CHECKPOINTS", "KindHistory", "checkpoints_for", "history", "render"]
