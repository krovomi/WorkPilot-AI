"""Does this task touch the interface? Answered from files, never by a model.

Three tiers, each read only when the one above did not settle it:

1. **A person decided.** `<spec_dir>/uiux/override.json` — written by the
   Kanban card's "apply" / "skip" buttons — wins over everything below.
2. **The plan says.** The files the plan's subtasks declare
   (`workflows.forecast.planned_files`). Any of them on the UI surface
   (`uiux.surface`) makes the task a UI task; a plan that names files and none
   of them UI makes it a backend task, whatever its description says.
3. **The description says — on a project that has an interface.** Before a
   plan exists, the words of the task are the only signal. They are only
   believed when the project has a UI toolkit at all: "page" in the
   description of a task on a Web API is pagination.

A backend task costs nothing: no section in any prompt, no tool declared, and a
phase skipped with its reason printed. That is the point of answering here,
once, rather than in each place that pays.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .settings import is_enabled
from .stack import UiStack, detect_ui_stack
from .surface import ui_paths

__all__ = [
    "OVERRIDE_FILE",
    "OVERRIDE_MODES",
    "Relevance",
    "assess",
    "read_override",
    "task_description",
    "write_override",
]

UIUX_DIR = "uiux"
OVERRIDE_FILE = "override.json"
OVERRIDE_MODES = ("auto", "force", "skip")

#: Words that name an interface, in the two languages the product ships.
#: Compared accent-free, on word boundaries.
_UI_WORDS = (
    "ui",
    "ux",
    "interface",
    "ecran",
    "ecrans",
    "screen",
    "screens",
    "page",
    "pages",
    "bouton",
    "boutons",
    "button",
    "buttons",
    "formulaire",
    "form",
    "forms",
    "composant",
    "component",
    "components",
    "layout",
    "mise en page",
    "css",
    "theme",
    "dark mode",
    "mode sombre",
    "couleur",
    "couleurs",
    "color",
    "colors",
    "palette",
    "responsive",
    "accessibilite",
    "accessibility",
    "a11y",
    "design",
    "maquette",
    "mockup",
    "wireframe",
    "figma",
    "menu",
    "modal",
    "modale",
    "dialog",
    "tableau de bord",
    "dashboard",
    "typography",
    "typographie",
    "police",
    "font",
    "icone",
    "icon",
    "icons",
    "animation",
    "onboarding",
    "landing",
    "frontend",
    "front-end",
    "front",
    "vue",
    "view",
    "sidebar",
    "navbar",
    "toolbar",
    "tooltip",
    "wpf",
    "xaml",
    "blazor",
    "razor",
)

#: Words that name the other side. They do not veto: a task can add an
#: endpoint *and* the screen that calls it. They only stop one stray word
#: ("page", "view") from turning a backend task into a UI task.
_BACKEND_WORDS = (
    "endpoint",
    "api",
    "migration",
    "database",
    "base de donnees",
    "sql",
    "repository",
    "repository pattern",
    "worker",
    "cron",
    "queue",
    "controller",
    "service",
    "middleware",
    "orm",
    "entity framework",
    "dto",
    "handler",
    "backend",
    "back-end",
)


def _fold(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def _hits(text: str, words: tuple[str, ...]) -> list[str]:
    found: list[str] = []
    for word in words:
        if re.search(rf"(?<![\w-]){re.escape(word)}(?![\w-])", text):
            found.append(word)
    return found


@dataclass
class Relevance:
    verdict: str  # "ui" | "not-ui" | "unknown"
    reason: str  # a stable code the UI translates
    detail: str = ""
    planned_files: list[str] | None = None
    ui_files: list[str] = field(default_factory=list)
    stack: UiStack = field(default_factory=UiStack)
    override: str = "auto"

    @property
    def is_ui(self) -> bool:
        return self.verdict == "ui"

    def to_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "reason": self.reason,
            "detail": self.detail,
            "plannedFiles": self.planned_files,
            "uiFiles": self.ui_files,
            "stack": self.stack.to_dict(),
            "override": self.override,
        }


def _uiux_dir(spec_dir: Path) -> Path:
    return Path(spec_dir) / UIUX_DIR


def read_override(spec_dir: Path | str | None) -> str:
    if not spec_dir:
        return "auto"
    try:
        data = json.loads(
            (_uiux_dir(Path(spec_dir)) / OVERRIDE_FILE).read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return "auto"
    mode = data.get("mode") if isinstance(data, dict) else None
    return mode if mode in OVERRIDE_MODES else "auto"


def write_override(spec_dir: Path | str, mode: str) -> str:
    if mode not in OVERRIDE_MODES:
        raise ValueError(f"mode must be one of {', '.join(OVERRIDE_MODES)}")
    target = _uiux_dir(Path(spec_dir))
    if target.is_symlink():
        raise ValueError("uiux directory is a symlink")
    target.mkdir(parents=True, exist_ok=True)
    path = target / OVERRIDE_FILE
    if mode == "auto":
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return mode
    path.write_text(json.dumps({"mode": mode}) + "\n", encoding="utf-8")
    return mode


def task_description(spec_dir: Path | str | None) -> str:
    """The words of the task: the requirement as typed, else the spec's head."""
    if not spec_dir:
        return ""
    spec = Path(spec_dir)
    try:
        data = json.loads((spec / "requirements.json").read_text(encoding="utf-8"))
        text = data.get("task_description") if isinstance(data, dict) else None
        if isinstance(text, str) and text.strip():
            return text.strip()[:4000]
    except (OSError, ValueError):
        pass
    try:
        return (spec / "spec.md").read_text(encoding="utf-8", errors="replace")[:4000]
    except OSError:
        return ""


def _planned(spec_dir: Path | str | None) -> list[str] | None:
    try:
        from workflows.forecast import planned_files
    except Exception:  # noqa: BLE001 - the forecast is optional evidence
        return None
    return planned_files(spec_dir)


def assess(
    project_dir: Path | str | None,
    spec_dir: Path | str | None,
    *,
    planned_files: list[str] | None = None,
    description: str | None = None,
) -> Relevance:
    """The verdict for one task. Never raises."""
    override = read_override(spec_dir)
    stack = detect_ui_stack(project_dir)
    files = planned_files if planned_files is not None else _planned(spec_dir)
    ui = ui_paths(files or [])

    def result(verdict: str, reason: str, detail: str = "") -> Relevance:
        return Relevance(
            verdict=verdict,
            reason=reason,
            detail=detail,
            planned_files=files,
            ui_files=ui,
            stack=stack,
            override=override,
        )

    if override == "skip":
        return result("not-ui", "override-skip")
    if override == "force":
        return result("ui", "override-force")
    if not is_enabled(project_dir):
        return result("not-ui", "disabled")

    if files:
        if ui:
            return result("ui", "planned-ui-files", ", ".join(ui[:5]))
        return result("not-ui", "planned-no-ui-files")

    if not stack.has_ui:
        return result("not-ui", "no-ui-stack")

    text = _fold(description if description is not None else task_description(spec_dir))
    ui_words = _hits(text, _UI_WORDS)
    backend_words = _hits(text, _BACKEND_WORDS)
    if len(ui_words) >= 2 or (ui_words and not backend_words):
        return result("ui", "description", ", ".join(ui_words[:5]))
    if not text.strip():
        return result("unknown", "no-signal")
    return result("not-ui", "description-not-ui")
