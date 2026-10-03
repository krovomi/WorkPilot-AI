"""What a user decides about the verification loop, and where they decide it.

Same shape as `rtk.settings`: every knob is read from the environment and from
`.workpilot/.env` — the file the Electron settings screen writes — and a real
environment variable wins over the file. `WORKPILOT_VERIFY_LOOP` is the
per-task override the Kanban sets on the build's environment (the path
`TDD_MODE` and `WORKPILOT_MOBILE_TARGETS` already take): `true`/`false` from a
card that said so, absent when the card inherits the project default.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

__all__ = [
    "ENABLED_ENV",
    "TASK_ENV",
    "SETTINGS_KEYS",
    "VerifySettings",
    "load_settings",
    "project_env",
]

ENABLED_ENV = "VERIFY_ENABLED"
TASK_ENV = "WORKPILOT_VERIFY_LOOP"

SETTINGS_KEYS = (
    ENABLED_ENV,
    TASK_ENV,
    "VERIFY_MAX_ROUNDS",
    "VERIFY_LAUNCH_TIMEOUT",
    "VERIFY_PERF_TRACE",
    "VERIFY_ALLOW_MUTATIONS",
    "VERIFY_PERF_REGRESSION",
    "VERIFY_CHROME_PATH",
    "VERIFY_BROWSER",
)

_WORKPILOT_DIR = ".workpilot"


def _truthy(value: object, default: bool) -> bool:
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    return default


def _number(value: object, default: int, low: int, high: int) -> int:
    """A bounded integer; a nonsense value is the default, never a disable."""
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    return number if low <= number <= high else default


def project_env(project_dir: Path | str | None) -> dict[str, str]:
    """The verification settings a project carries in `.workpilot/.env`."""
    values: dict[str, str] = {}
    if not project_dir:
        return values
    path = Path(project_dir) / _WORKPILOT_DIR / ".env"
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw = line.split("=", 1)
        key = key.strip()
        if key in SETTINGS_KEYS:
            values[key] = raw.strip().strip("\"'")
    return values


@dataclass(frozen=True)
class VerifySettings:
    enabled: bool = True
    max_rounds: int = 5
    launch_timeout: int = 120
    perf_trace: bool = True
    allow_mutations: bool = True
    perf_regression: int = 10
    chrome_path: str = ""
    #: ``auto`` (Chrome DevTools MCP, then Playwright), ``devtools``,
    #: ``playwright`` or ``off`` (no browser: launch, logs and endpoints only).
    browser: str = "auto"
    #: Where `enabled` came from: ``task``, ``env``, ``project`` or ``default``.
    decided_by: str = "default"

    def to_dict(self) -> dict:
        return {
            "enabled": self.enabled,
            "maxRounds": self.max_rounds,
            "launchTimeout": self.launch_timeout,
            "perfTrace": self.perf_trace,
            "allowMutations": self.allow_mutations,
            "perfRegression": self.perf_regression,
            "browser": self.browser,
            "decidedBy": self.decided_by,
        }


def load_settings(
    project_dir: Path | str | None = None, env: dict | None = None
) -> VerifySettings:
    """The effective settings: environment over `.workpilot/.env` over defaults."""
    environ = os.environ if env is None else env
    merged: dict[str, str] = {**project_env(project_dir)}
    for key in SETTINGS_KEYS:
        if key in environ:
            merged[key] = str(environ[key])

    task = merged.get(TASK_ENV, "").strip()
    if task:
        enabled = _truthy(task, True)
        decided_by = "task"
    elif ENABLED_ENV in environ:
        enabled = _truthy(environ[ENABLED_ENV], True)
        decided_by = "env"
    elif ENABLED_ENV in merged:
        enabled = _truthy(merged[ENABLED_ENV], True)
        decided_by = "project"
    else:
        enabled, decided_by = True, "default"

    return VerifySettings(
        enabled=enabled,
        max_rounds=_number(merged.get("VERIFY_MAX_ROUNDS"), 5, 1, 20),
        launch_timeout=_number(merged.get("VERIFY_LAUNCH_TIMEOUT"), 120, 5, 1800),
        perf_trace=_truthy(merged.get("VERIFY_PERF_TRACE", "true"), True),
        allow_mutations=_truthy(merged.get("VERIFY_ALLOW_MUTATIONS", "true"), True),
        perf_regression=_number(merged.get("VERIFY_PERF_REGRESSION"), 10, 1, 100),
        chrome_path=merged.get("VERIFY_CHROME_PATH", "").strip(),
        browser=(
            merged.get("VERIFY_BROWSER", "auto").strip().lower()
            if merged.get("VERIFY_BROWSER", "auto").strip().lower()
            in ("auto", "devtools", "playwright", "off")
            else "auto"
        ),
        decided_by=decided_by,
    )
