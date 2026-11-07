"""Stage the .NET migration skills next to a task's spec, when the task needs them.

Runs once per build, before planning, costs no token and never fails a build.

**The ladder.** Three skills ship with WorkPilot, one per release:
``migrate-dotnet8-to-dotnet9``, ``migrate-dotnet9-to-dotnet10`` and
``migrate-dotnet10-to-dotnet11``. A migration crosses each release between the
project's and the one the task names, so every hop's skill is staged, in order.

**Why a copy next to the spec.** The skills ship with WorkPilot (a release's
``skills_registry/bundled/``, a checkout's ``.agents/skills/``), outside the
project an agent works in. A Claude session could read them there; the
providers that go through `core.runtimes.tool_executor` (OpenAI and its
compatibles, Gemini, Ollama…) refuse any path outside the project.
``<spec_dir>`` is inside the project (``.workpilot/specs/…``, git-ignored), so a
copy there is readable by every provider and never lands in the task's diff.
libdocs and docintel stage their material there for the same reason.

**Only when the task needs them.** The record says which case applies:

* ``migrate`` — one hop: the project is on .NET 8, 9 or 10 and the task names
  the next release (".NET 10", "net11.0", "C# 14"…);
* ``chain`` — several hops, or a project on .NET 5–7 whose first releases have
  no skill (the official lists cover those);
* ``adopt`` — the project already targets .NET 11: the 10 → 11 skill and its
  C# 15 notes stay at hand for every task.

Anything else — no .NET, .NET Framework, a task that names no newer release —
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
    requested_target,
    task_text,
)

__all__ = [
    "HOPS",
    "RESULT_FILE",
    "SKILL_NAME",
    "STAGE_DIR",
    "PreflightResult",
    "plan",
    "read_result",
    "run_preflight",
    "skill_source",
]

logger = logging.getLogger(__name__)

# Source major -> the skill that takes a project from it to the next release.
HOPS: dict[int, str] = {
    8: "migrate-dotnet8-to-dotnet9",
    9: "migrate-dotnet9-to-dotnet10",
    10: "migrate-dotnet10-to-dotnet11",
}
SKILL_NAME = HOPS[10]
STAGE_DIR = "dotnet-upgrade"
RESULT_FILE = "result.json"

_LATEST = max(HOPS) + 1
_FIRST_HOP = min(HOPS)
_OLDEST_CORE_MAJOR = 5


@dataclass
class PreflightResult:
    status: str = "skipped"  # skipped | staged | not-installed | failed
    mode: str = ""  # migrate | chain | adopt
    dotnet: str | None = None
    target: int | None = None
    skills: list[str] = field(default_factory=list)
    # Skill -> its reference files this project needs, relative to the skill.
    references: dict[str, list[str]] = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def describe(self) -> str:
        """One line for the build log, or "" when nothing was staged."""
        if self.status != "staged":
            return ""
        return (
            f".NET migration skills staged ({self.mode}, .NET {self.dotnet} → "
            f"{self.target}): {', '.join(self.skills)}"
        )


def skill_source(name: str) -> Path | None:
    """A skill's directory in a release or a checkout, None when neither has it."""
    from skills_registry.bundled import bundled_skill_dirs

    for directory in bundled_skill_dirs(name):
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


def plan(
    major: int | None, target: int | None
) -> tuple[str, int | None, list[str], str]:
    """(mode, target, skills, reason): an empty mode means nothing to stage."""
    if major is None:
        return "", None, [], "no .NET target framework found"
    if major < _OLDEST_CORE_MAJOR:
        return "", None, [], ".NET Framework: a port, not this migration"
    if major > _LATEST:
        return "", None, [], f".NET {major} is newer than these skills"
    if major == _LATEST:
        return "adopt", _LATEST, [HOPS[_LATEST - 1]], ""
    if target is None or target <= major:
        return "", None, [], "the task names no newer .NET release"
    skills = [HOPS[m] for m in range(max(major, _FIRST_HOP), target)]
    mode = "migrate" if len(skills) == 1 and major >= _FIRST_HOP else "chain"
    return mode, target, skills, ""


def _reference_files(skill_dir: Path, areas: list[str]) -> list[str]:
    """The project's areas this hop has a file for, in the areas' order."""
    out = []
    for area in areas:
        matches = sorted((skill_dir / "references").glob(f"{area}-dotnet*.md"))
        out += [f"references/{p.name}" for p in matches if p.is_file()]
    return out


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
    """Decide which skills this task needs and stage them. Never raises."""
    result = PreflightResult()
    spec = Path(spec_dir)
    out = spec / STAGE_DIR
    if spec.is_symlink() or out.is_symlink():
        result.status = "failed"
        result.reasons.append("spec directory is a symlink")
        return result

    result.dotnet = project_dotnet_version(project_dir)
    mode, target, skills, why = plan(
        dotnet_major(result.dotnet), requested_target(task_text(spec))
    )
    if why:
        result.reasons.append(why)

    try:
        out.mkdir(parents=True, exist_ok=True)
        sources = {name: skill_source(name) for name in skills}
        if missing := [name for name, src in sources.items() if src is None]:
            result.status = "not-installed"
            result.reasons.append(f"not bundled with this build: {', '.join(missing)}")
        elif mode:
            if any((out / name).is_symlink() for name in skills):
                raise OSError("a staged skill directory is a symlink")
            areas = project_areas(project_dir)
            for name, source in sources.items():
                if source is None:
                    continue
                _copy_skill(source, out / name)
                result.references[name] = _reference_files(out / name, areas)
            result.status, result.mode = "staged", mode
            result.target, result.skills = target, skills
        _write_result(out, result)
    except OSError as exc:
        logger.debug(".NET migration preflight failed: %s", exc)
        result.status = "failed"
        result.reasons.append(str(exc))
    return result
