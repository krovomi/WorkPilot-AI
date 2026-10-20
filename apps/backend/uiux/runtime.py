"""Where the vendored ui-ux-pro-max lives, and whether it can be used.

Three places, first found wins:

1. ``WORKPILOT_UIUX_HOME`` — a clone, for moving the pin without touching
   ``skills/``;
2. a release: ``skills_registry/bundled/ui-ux-pro-max`` (copied there by the
   desktop packaging, like `convert-documents-to-markdown`);
3. a checkout: the emitted ``.agents/skills/ui-ux-pro-max``, then its source
   ``skills/ui-ux-pro-max/ui-ux-pro-max``.

The doctor answers from files on disk in a few ``stat`` calls, so the Kanban
can ask on every panel opening.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from pathlib import Path

__all__ = ["HOME_ENV", "SKILL_NAME", "Doctor", "doctor", "skill_dir"]

HOME_ENV = "WORKPILOT_UIUX_HOME"
SKILL_NAME = "ui-ux-pro-max"

_BACKEND = Path(__file__).resolve().parent.parent
_REPO_ROOT = _BACKEND.parent.parent

_ENGINE = Path("scripts") / "search.py"


def _candidates() -> list[Path]:
    out: list[Path] = []
    override = os.environ.get(HOME_ENV, "").strip()
    if override:
        out.append(Path(override).expanduser())
    try:
        from skills_registry.bundled import bundled_skill_dirs

        out.extend(bundled_skill_dirs(SKILL_NAME))
    except Exception:  # noqa: BLE001 - a missing registry is one place fewer to look
        out.append(_BACKEND / "skills_registry" / "bundled" / SKILL_NAME)
        out.append(_REPO_ROOT / ".agents" / "skills" / SKILL_NAME)
    out.append(_REPO_ROOT / "skills" / SKILL_NAME / SKILL_NAME)
    return out


def skill_dir() -> Path | None:
    """The first directory that holds the skill *and* its engine."""
    for candidate in _candidates():
        if (candidate / "SKILL.md").is_file() and (candidate / _ENGINE).is_file():
            return candidate
    return None


@dataclass(frozen=True)
class Doctor:
    installed: bool
    skill_dir: str | None
    engine: str | None
    reason: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def doctor() -> Doctor:
    found = skill_dir()
    if found is None:
        return Doctor(
            installed=False,
            skill_dir=None,
            engine=None,
            reason=(
                "ui-ux-pro-max is not vendored here — run "
                "`python3 scripts/vendor_ui_ux_pro_max.py` then `pnpm run skills:build`"
            ),
        )
    return Doctor(
        installed=True,
        skill_dir=str(found),
        engine=str(found / _ENGINE),
        reason="ready",
    )
