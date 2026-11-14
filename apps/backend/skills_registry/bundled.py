"""Product skills available even when the consumer has no generated palette.

Sources still live in skills/; desktop packaging copies the canonical generated
output alongside this module. Only explicitly bundled product skills are exposed.
"""

from pathlib import Path
from typing import Any

from .frontmatter import parse_frontmatter

BUNDLED_SKILLS = (
    "convert-documents-to-markdown",
    "migrate-dotnet10-to-dotnet11",
    "migrate-dotnet8-to-dotnet9",
    "migrate-dotnet9-to-dotnet10",
    "ui-ux-pro-max",
    "windev-text-format",
    "wlangage",
)


def bundled_skill_dirs(name: str) -> tuple[Path, ...]:
    """Where an allowlisted skill's directory may be: a release, then a checkout.

    Its scripts and data travel with it — `uiux` runs the bundled engine from
    there — so callers need the directory, not only the SKILL.md.
    """
    if name not in BUNDLED_SKILLS:
        return ()
    module = Path(__file__).resolve()
    root = module.parents[3]
    # The source last: a skill whose targets this repository's own toolchain
    # rejects (`migrate-dotnet8-to-dotnet9` here, on dotnet 10) is never
    # emitted into .agents/skills, and the release ships it from skills/.
    return (
        module.parent / "bundled" / name,
        root / ".agents" / "skills" / name,
        *sorted(root.glob(f"skills/*/{name}")),
    )


def load_bundled_skill(name: str) -> tuple[dict[str, Any], str] | None:
    """Read an allowlisted skill in a release or a source checkout."""
    for directory in bundled_skill_dirs(name):
        path = directory / "SKILL.md"
        try:
            meta, body = parse_frontmatter(path.read_text(encoding="utf-8"))
        except OSError:
            continue
        if meta.get("name") == name and body.strip():
            return meta, body.strip()
    return None
