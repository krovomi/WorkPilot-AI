"""Stage the .NET 11 migration skill next to a task's spec, when the task needs it.

Runs once per build, before planning, costs no token and never fails a build.

**Why a copy next to the spec.** The skill ships with WorkPilot (a release's
``skills_registry/bundled/``, a checkout's ``.agents/skills/``), outside the
project an agent works in. A Claude session could read it there; the providers
that go through `core.runtimes.tool_executor` (OpenAI and its compatibles,
Gemini, Ollama…) refuse any path outside the project. ``<spec_dir>`` is inside
the project (``.workpilot/specs/…``, git-ignored), so a copy there is readable
by every provider and never lands in the task's diff. libdocs and docintel stage
their material there for the same reason.

**Only when the task needs it.** The record says which of three cases applies:

* ``migrate`` — the project is on .NET 10 and the task's words name .NET 11 or
  C# 15;
* ``chain`` — the project is on .NET 5–9 and the task asks for .NET 11: the
  releases in between come first;
* ``adopt`` — the project already targets .NET 11: C# 15 and the breaking-change
  notes stay at hand for every task.

Anything else — no .NET, .NET Framework, a .NET 10 task about something else —
is recorded as ``skipped`` and the prompt section stays empty.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .detect import (
    dotnet_major,
    project_areas,
    project_dotnet_version,
    task_asks_for_dotnet11,
    task_text,
)

__all__ = [
    "RESULT_FILE",
    "SKILL_NAME",
    "STAGE_DIR",
    "PreflightResult",
    "read_result",
    "run_preflight",
    "skill_source",
]

logger = logging.getLogger(__name__)

SKILL_NAME = "migrate-dotnet10-to-dotnet11"
STAGE_DIR = "dotnet11"
RESULT_FILE = "result.json"

_TARGET_MAJOR = 11
_OLDEST_CORE_MAJOR = 5


@dataclass
class PreflightResult:
    status: str = "skipped"  # skipped | staged | not-installed | failed
    mode: str = ""  # migrate | chain | adopt
    dotnet: str | None = None
    references: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def describe(self) -> str:
        """One line for the build log, or "" when nothing was staged."""
        if self.status != "staged":
            return ""
        return (
            f".NET 11 migration skill staged ({self.mode}, project on .NET "
            f"{self.dotnet}): {', '.join(self.references)}"
        )


def skill_source() -> Path | None:
    """The skill's directory in a release or a checkout, None when neither has it."""
    from skills_registry.bundled import bundled_skill_dirs

    for directory in bundled_skill_dirs(SKILL_NAME):
        if (directory / "SKILL.md").is_file() and (directory / "references").is_dir():
            return directory
    return None


def read_result(spec_dir: Path | str | None) -> dict[str, Any] | None:
    if not spec_dir:
        return None
    try:
        data = json.loads(
            (Path(spec_dir) / STAGE_DIR / RESULT_FILE).read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _mode(major: int | None, asks: bool) -> tuple[str, str]:
    """(mode, reason): an empty mode means the task does not need the skill."""
    if major is None:
        return "", "no .NET target framework found"
    if major < _OLDEST_CORE_MAJOR:
        return "", ".NET Framework: a port, not this migration"
    if major > _TARGET_MAJOR:
        return "", f".NET {major} is newer than this skill"
    if major == _TARGET_MAJOR:
        return "adopt", ""
    if not asks:
        return "", "the task does not ask for .NET 11 or C# 15"
    return ("migrate" if major == _TARGET_MAJOR - 1 else "chain"), ""


def _copy_skill(source: Path, out: Path) -> None:
    """SKILL.md, LICENSE and references/*.md — text only, links never followed."""
    (out / "references").mkdir(parents=True, exist_ok=True)
    names = ["SKILL.md", "LICENSE"] + [
        f"references/{p.name}"
        for p in sorted((source / "references").glob("*.md"))
        if p.is_file() and not p.is_symlink()
    ]
    for name in names:
        src, dst = source / name, out / name
        if not src.is_file() or src.is_symlink() or dst.is_symlink():
            continue
        dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")


def _write_result(out: Path, result: PreflightResult) -> None:
    target = out / RESULT_FILE
    if target.is_symlink():
        return
    target.write_text(
        json.dumps(result.to_dict(), indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def run_preflight(project_dir: Path | str, spec_dir: Path | str) -> PreflightResult:
    """Decide whether this task needs the skill and stage it. Never raises."""
    result = PreflightResult()
    spec = Path(spec_dir)
    out = spec / STAGE_DIR
    if spec.is_symlink() or out.is_symlink():
        result.status = "failed"
        result.reasons.append("spec directory is a symlink")
        return result

    result.dotnet = project_dotnet_version(project_dir)
    mode, why = _mode(
        dotnet_major(result.dotnet), task_asks_for_dotnet11(task_text(spec))
    )
    if why:
        result.reasons.append(why)

    try:
        out.mkdir(parents=True, exist_ok=True)
        if mode:
            source = skill_source()
            if source is None:
                result.status = "not-installed"
                result.reasons.append(f"{SKILL_NAME} is not bundled with this build")
            else:
                _copy_skill(source, out)
                result.status, result.mode = "staged", mode
                result.references = project_areas(project_dir)
        _write_result(out, result)
    except OSError as exc:
        logger.debug(".NET 11 preflight failed: %s", exc)
        result.status = "failed"
        result.reasons.append(str(exc))
    return result
