"""What a team decides about the captures of its tasks, and where it decides it.

Same contract as `verify.settings` and `docintel.settings`: every knob is read
from the environment and from `.workpilot/.env` (the file the project settings
screen writes), a real environment variable winning over the file.
`WORKPILOT_CAPTURES` is the per-card override the Kanban puts on the build's
environment (`always` / `never`), absent when the card follows the project.

Only the keys listed here are read: the same file holds every integration's
token, and this module has no use for them (`docintel.settings.read_keys`).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from docintel.settings import read_keys

__all__ = [
    "MODES",
    "MODE_ENV",
    "PUBLISH_MODES",
    "SETTINGS_KEYS",
    "TASK_ENV",
    "CaptureSettings",
    "load_settings",
]

MODE_ENV = "CAPTURES_MODE"
TASK_ENV = "WORKPILOT_CAPTURES"
COMPARE_ENV = "CAPTURES_COMPARE"
MASK_ENV = "CAPTURES_MASK"
MASK_SELECTORS_ENV = "CAPTURES_MASK_SELECTORS"
PUBLISH_ENV = "CAPTURES_PUBLISH"
UNCHECKED_ENV = "CAPTURES_PUBLISH_UNCHECKED"
RETENTION_ENV = "CAPTURES_RETENTION_DAYS"

SETTINGS_KEYS = (
    MODE_ENV,
    TASK_ENV,
    COMPARE_ENV,
    MASK_ENV,
    MASK_SELECTORS_ENV,
    PUBLISH_ENV,
    UNCHECKED_ENV,
    RETENTION_ENV,
)

#: ``auto``: only a task whose changes touch the interface; ``always`` and
#: ``never`` decide for every task.
MODES = ("auto", "always", "never")
#: ``auto``: the masked captures go into the pull request as soon as it
#: exists; ``review``: they wait for a person's "publish"; ``never``: they stay
#: on the task.
PUBLISH_MODES = ("auto", "review", "never")

#: A selector is a CSS selector typed by the team in its own settings. It is
#: handed to `querySelectorAll` as data (JSON), never spliced into script, and
#: bounded so a pasted stylesheet does not become the mask list.
MAX_SELECTORS = 30
MAX_SELECTOR_CHARS = 200


def _truthy(value: object, default: bool) -> bool:
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    return default


def _choice(value: object, allowed: tuple[str, ...], default: str) -> str:
    text = str(value or "").strip().lower()
    return text if text in allowed else default


def _days(value: object, default: int) -> int:
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    return number if 0 <= number <= 3650 else default


def _selectors(value: object) -> tuple[str, ...]:
    found: list[str] = []
    for part in str(value or "").split(","):
        selector = part.strip()
        if not selector or len(selector) > MAX_SELECTOR_CHARS:
            continue
        if selector not in found:
            found.append(selector)
        if len(found) >= MAX_SELECTORS:
            break
    return tuple(found)


@dataclass(frozen=True)
class CaptureSettings:
    mode: str = "auto"
    #: Where `mode` came from: ``task``, ``project`` or ``default``.
    decided_by: str = "default"
    #: Replay the scenario on the base branch for the "before" image.
    compare: bool = True
    #: Cover personal data before a capture leaves the machine.
    mask: bool = True
    mask_selectors: tuple[str, ...] = ()
    publish: str = "auto"
    #: Publish a capture no check could read (no OCR engine for a window or a
    #: phone screen). Off: such a capture stays on the task.
    publish_unchecked: bool = False
    #: Days the published images are kept after the PR is merged or closed.
    retention_days: int = 30

    def to_dict(self) -> dict:
        return {
            "mode": self.mode,
            "decidedBy": self.decided_by,
            "compare": self.compare,
            "mask": self.mask,
            "maskSelectors": list(self.mask_selectors),
            "publish": self.publish,
            "publishUnchecked": self.publish_unchecked,
            "retentionDays": self.retention_days,
        }


def load_settings(
    project_dir: Path | str | None = None, env: dict[str, str] | None = None
) -> CaptureSettings:
    """The effective settings: environment over `.workpilot/.env` over defaults."""
    values = (
        dict(env)
        if env is not None
        else read_keys(Path(project_dir) if project_dir else None, SETTINGS_KEYS)
    )
    task = _choice(values.get(TASK_ENV), MODES, "")
    if task and task != "auto":
        mode, decided_by = task, "task"
    elif MODE_ENV in values:
        mode, decided_by = _choice(values[MODE_ENV], MODES, "auto"), "project"
    else:
        mode, decided_by = "auto", "default"
    return CaptureSettings(
        mode=mode,
        decided_by=decided_by,
        compare=_truthy(values.get(COMPARE_ENV, "true"), True),
        mask=_truthy(values.get(MASK_ENV, "true"), True),
        mask_selectors=_selectors(values.get(MASK_SELECTORS_ENV)),
        publish=_choice(values.get(PUBLISH_ENV), PUBLISH_MODES, "auto"),
        publish_unchecked=_truthy(values.get(UNCHECKED_ENV, "false"), False),
        retention_days=_days(values.get(RETENTION_ENV), 30),
    )
