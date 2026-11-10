"""Every flaky test the project has had, run after run (#351).

``.workpilot/flaky-tests/history.json`` keeps, for each test seen failing at
least once, when it was first and last seen and one observation per analysis:
how many runs, how many failures, on which system, in CI or not. From that the
report gives the trend (worse, better, same, new), the systems it fails on, and
whether it fails only in CI.

The file belongs to WorkPilot's own folder of the project; it is never written
through a symbolic link, and a file that cannot be read starts a new history.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

__all__ = ["HISTORY_FILE", "current_os", "in_ci", "load_history", "record", "summary"]

HISTORY_FILE = Path(".workpilot") / "flaky-tests" / "history.json"
_MAX_OBSERVATIONS = 30
_MAX_TESTS = 2000
_CI_VARIABLES = (
    "CI",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "TF_BUILD",
    "JENKINS_URL",
    "BUILDKITE",
    "CIRCLECI",
    "TEAMCITY_VERSION",
)


def current_os() -> str:
    from foundation.platform import is_linux, is_macos, is_windows

    if is_windows():
        return "windows"
    if is_macos():
        return "macos"
    return "linux" if is_linux() else "other"


def in_ci(environ: dict[str, str] | None = None) -> bool:
    """Whether this analysis runs on a CI server (WorkPilot's own runs set ``CI`` for the child only)."""
    env = os.environ if environ is None else environ
    return any(
        env.get(name, "").strip().lower() not in {"", "0", "false"}
        for name in _CI_VARIABLES
    )


def _path(root: Path) -> Path | None:
    folder = root
    for part in HISTORY_FILE.parts[:-1]:
        folder = folder / part
        if folder.is_symlink():
            return None
    target = root / HISTORY_FILE
    return None if target.is_symlink() else target


def load_history(root: Path) -> dict[str, Any]:
    path = _path(root)
    if path is None or not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    tests = data.get("tests") if isinstance(data, dict) else None
    return tests if isinstance(tests, dict) else {}


def record(
    root: Path,
    outcomes: dict[str, tuple[int, int]],
    *,
    at: str | None = None,
    os_name: str | None = None,
    ci: bool | None = None,
) -> dict[str, Any]:
    """Add one observation per test (``{name: (runs, failures)}``) and save.

    Only a test that failed in this analysis, or that the history already
    knows, is kept: a suite of thousands of green tests stays out of it.
    """
    tests = load_history(root)
    stamp = at or datetime.now(tz=UTC).isoformat(timespec="seconds")
    system = os_name or current_os()
    on_ci = in_ci() if ci is None else ci
    for name, (runs, failures) in outcomes.items():
        if runs <= 0 or (failures == 0 and name not in tests):
            continue
        entry = tests.setdefault(name, {"firstSeen": stamp, "observations": []})
        entry["lastSeen"] = stamp
        entry["observations"] = [
            *entry.get("observations", [])[-(_MAX_OBSERVATIONS - 1) :],
            {
                "at": stamp,
                "runs": runs,
                "failures": failures,
                "os": system,
                "ci": on_ci,
            },
        ]
    if len(tests) > _MAX_TESTS:
        keep = sorted(
            tests, key=lambda n: str(tests[n].get("lastSeen", "")), reverse=True
        )[:_MAX_TESTS]
        tests = {name: tests[name] for name in keep}
    path = _path(root)
    if path is not None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps({"version": 1, "tests": tests}, indent=1), encoding="utf-8"
            )
        except OSError as exc:
            logger.info("Flaky history not written: %s", type(exc).__name__)
    return tests


def _rate(observation: dict[str, Any]) -> float:
    runs = int(observation.get("runs") or 0)
    return int(observation.get("failures") or 0) / runs if runs else 0.0


def summary(entry: dict[str, Any] | None) -> dict[str, Any]:
    """First seen, trend, systems and CI-only for one test's history."""
    observations = list((entry or {}).get("observations") or [])
    if not observations:
        return {
            "firstSeen": "",
            "observations": 0,
            "trend": "new",
            "systems": [],
            "ciOnly": False,
        }
    last = _rate(observations[-1])
    if len(observations) < 2:
        trend = "new"
    else:
        before = _rate(observations[-2])
        trend = (
            "worse"
            if last > before + 0.05
            else "better"
            if last < before - 0.05
            else "same"
        )
    failing = [o for o in observations if int(o.get("failures") or 0)]
    systems = sorted({str(o.get("os", "")) for o in failing if o.get("os")})
    local = [o for o in observations if not o.get("ci")]
    ci_only = bool(failing) and all(o.get("ci") for o in failing) and bool(local)
    return {
        "firstSeen": str(entry.get("firstSeen", "")) if entry else "",
        "observations": len(observations),
        "trend": trend,
        "systems": systems,
        "ciOnly": ci_only,
        "rates": [round(_rate(o), 3) for o in observations[-10:]],
    }
