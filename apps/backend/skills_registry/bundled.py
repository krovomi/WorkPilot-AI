"""Product skills available even when the consumer has no generated palette.

Sources still live in skills/; desktop packaging copies the canonical generated
output alongside this module. Only explicitly bundled product skills are exposed.
"""

from pathlib import Path
from typing import Any

from .frontmatter import parse_frontmatter

BUNDLED_SKILLS = ("convert-documents-to-markdown", "ui-ux-pro-max")


def bundled_skill_dirs(name: str) -> tuple[Path, ...]:
    """Where an allowlisted skill's directory may be: a release, then a checkout.

    Its scripts and data travel with it — `uiux` runs the bundled engine from
    there — so callers need the directory, not only the SKILL.md.
    """
    if name not in BUNDLED_SKILLS:
        return ()
    module = Path(__file__).resolve()
    return (
        module.parent / "bundled" / name,
        module.parents[3] / ".agents" / "skills" / name,
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
