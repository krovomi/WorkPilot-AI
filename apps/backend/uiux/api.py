"""ui-ux-pro-max, as the Kanban task panel sees it.

    GET  /api/uiux/task       the verdict, the design system, the guide
    POST /api/uiux/override   "apply to this task" / "skip for this task" / "auto"

The GET reads the record the build's preflight wrote. Before a build, it
*recomputes* the verdict — paths only, no engine, nothing written — so the card
can say what the next build will do while someone can still change it. There is
deliberately no "generate now": the design system is written into a worktree a
person reviews, and the panel has no worktree.

Refused in server mode by the same addressing rules as every spec endpoint
(`core.api_safety.resolve_spec_dir`).
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from core.api_safety import SPEC_ADDRESS_REASONS, SpecAddressError, resolve_spec_dir
from fastapi import APIRouter, Query
from pydantic import BaseModel

from .preflight import DESIGN_FILE, read_result
from .relevance import OVERRIDE_MODES, UIUX_DIR, assess, write_override
from .runtime import doctor

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/uiux", tags=["uiux"])

_COLOR_ROW = re.compile(r"^\|\s*([^|]+?)\s*\|\s*`?(#[0-9A-Fa-f]{3,8})`?\s*\|", re.M)
_FIELD = re.compile(r"^(?:-\s*)?\*\*([^*:]+):\*\*\s*(.+)$")


class SpecAddress(BaseModel):
    spec_dir: str | None = None
    project_dir: str | None = None
    spec_id: str | None = None


class OverrideRequest(SpecAddress):
    mode: str


def _resolve(spec_dir, project_dir, spec_id) -> tuple[Path | None, dict | None]:
    try:
        return resolve_spec_dir(spec_dir, project_dir, spec_id), None
    except SpecAddressError as exc:
        logger.warning("invalid uiux request: %s", exc)
        return None, {
            "success": False,
            "error": SPEC_ADDRESS_REASONS.get(
                exc.reason, SPEC_ADDRESS_REASONS["addressing"]
            ),
            "reason": exc.reason,
        }


def _project_of(spec_dir: Path) -> Path | None:
    if spec_dir.parent.name == "specs" and spec_dir.parent.parent.name == ".workpilot":
        return spec_dir.parent.parent.parent
    return None


#: Upstream prints the design system in two shapes — the generator's Markdown
#: (`### Style` / `- **Name:**`) and the persisted MASTER.md (`**Style:**`,
#: `- **Heading Font:**`). Both are read; the first value found wins.
_KEYS = {
    "heading font": "heading",
    "heading": "heading",
    "body font": "body",
    "body": "body",
    "style": "style",
    "pattern name": "pattern",
}


def summarize_design(text: str) -> dict:
    """The few facts a card draws: palette swatches, fonts, style name."""
    colors = [
        {"role": role.strip(), "hex": hex_.upper()}
        for role, hex_ in _COLOR_ROW.findall(text)
        if role.strip().lower() not in ("role", "---")
    ][:16]
    fields: dict[str, str] = {}
    section = ""
    for line in text.splitlines():
        if line.startswith("#"):
            section = line.lstrip("#").strip().lower()
            continue
        match = _FIELD.match(line.strip())
        if not match:
            continue
        key = match.group(1).strip().lower()
        value = match.group(2).strip().strip("*").strip()[:120]
        name = _KEYS.get(key)
        if key == "name" and section in ("style", "pattern"):
            name = section
        if name and name not in fields:
            fields[name] = value
    return {"colors": colors, **fields}


def _payload(spec: Path) -> dict:
    health = doctor()
    record = read_result(spec)
    design = None
    if record and record.get("status") in ("ready", "withheld"):
        try:
            text = (spec / UIUX_DIR / DESIGN_FILE).read_text(
                encoding="utf-8", errors="replace"
            )
            design = summarize_design(text)
        except OSError:
            design = None
    forecast = None
    if record is None:
        project = _project_of(spec)
        forecast = assess(project, spec).to_dict()
    return {
        "success": True,
        "installed": health.installed,
        "reason": None if health.installed else health.reason,
        "record": record,
        "forecast": forecast,
        "design": design,
    }


@router.get("/task")
def uiux_task(
    spec_dir: str | None = Query(None),
    project_dir: str | None = Query(None),
    spec_id: str | None = Query(None),
):
    resolved, error = _resolve(spec_dir, project_dir, spec_id)
    if error:
        return error
    try:
        return _payload(resolved)
    except Exception:  # noqa: BLE001
        logger.exception("uiux task status failed")
        return {"success": False, "error": "An internal error has occurred."}


@router.post("/override")
def uiux_override(body: OverrideRequest):
    if body.mode not in OVERRIDE_MODES:
        return {"success": False, "error": "invalid mode", "reason": "invalid-mode"}
    resolved, error = _resolve(body.spec_dir, body.project_dir, body.spec_id)
    if error:
        return error
    try:
        write_override(resolved, body.mode)
        return _payload(resolved)
    except Exception:  # noqa: BLE001
        logger.exception("uiux override failed")
        return {"success": False, "error": "An internal error has occurred."}
