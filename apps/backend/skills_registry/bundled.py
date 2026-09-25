"""Product skills available even when the consumer has no generated palette.

Sources still live in skills/; desktop packaging copies the canonical generated
output alongside this module. Only explicitly bundled product skills are exposed.
"""

from pathlib import Path
from typing import Any

from .frontmatter import parse_frontmatter

BUNDLED_SKILLS = ("convert-documents-to-markdown",)


def load_bundled_skill(name: str) -> tuple[dict[str, Any], str] | None:
    """Read an allowlisted skill in a release or a source checkout."""
    if name not in BUNDLED_SKILLS:
        return None
    module = Path(__file__).resolve()
    candidates = (
        module.parent / "bundled" / name / "SKILL.md",
        module.parents[3] / ".agents" / "skills" / name / "SKILL.md",
    )
    for path in candidates:
        try:
            meta, body = parse_frontmatter(path.read_text(encoding="utf-8"))
        except OSError:
            continue
        if meta.get("name") == name and body.strip():
            return meta, body.strip()
    return None
