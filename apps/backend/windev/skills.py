"""The WinDev skills, staged next to a task's spec so every provider can read them.

A target project has no copy of WorkPilot's skills, and only some harnesses
read a skill directory at all. So, like the .NET migration ladder
(`dotnet_upgrade`), the skills are copied into the task's spec directory,
which every agent of the task can read, and the prompt section names the
copies. Copying is idempotent and never raises: a task without the files
still gets the section's rules.
"""

from __future__ import annotations

import shutil
from pathlib import Path

__all__ = ["SKILLS", "STAGE_DIR", "stage_skills"]

#: The bundled skills a WinDev task gets (`skills/windev/`).
SKILLS = ("wlangage", "windev-text-format")
#: Where they land under the spec directory.
STAGE_DIR = "windev"


def _source(name: str) -> Path | None:
    """The skill in a release (bundled by the desktop build), then in a checkout.

    The same two places `skills_registry.bundled.bundled_skill_dirs` looks,
    read here without importing it: this package is a leaf that the stack
    detection imports, and the registry reaches back to the stack through the
    security layer.
    """
    backend = Path(__file__).resolve().parents[1]
    for directory in (
        backend / "skills_registry" / "bundled" / name,
        backend.parents[1] / "skills" / "windev" / name,
    ):
        if (directory / "SKILL.md").is_file():
            return directory
    return None


def stage_skills(spec_dir: Path | str | None) -> list[Path]:
    """The staged ``SKILL.md`` files under ``spec_dir``, copying what is missing."""
    if not spec_dir or not Path(spec_dir).is_dir():
        return []
    staged: list[Path] = []
    for name in SKILLS:
        target = Path(spec_dir) / STAGE_DIR / name / "SKILL.md"
        if not target.is_file():
            source = _source(name)
            if source is None:
                continue
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source / "SKILL.md", target)
            except OSError:
                continue
        staged.append(target)
    return staged
