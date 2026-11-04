"""No workflow keeps an artifact more than a few days.

The free plan's Actions storage quota is shared by every artifact of the
repository. Release builds kept the default 90 days and filled it: runs, pull
requests included, could no longer upload. Every upload now says how long it
lives, and `artifact-cleanup.yml` sweeps whatever is older.
"""

from __future__ import annotations

from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

ROOT = Path(__file__).resolve().parents[1]
GITHUB = ROOT / ".github"
MAX_RETENTION_DAYS = 3


def _steps():
    for path in sorted(GITHUB.rglob("*.yml")):
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            continue
        jobs = data.get("jobs") or {}
        groups = [job.get("steps") or [] for job in jobs.values()]
        runs = data.get("runs")
        if isinstance(runs, dict):  # composite action
            groups.append(runs.get("steps") or [])
        for steps in groups:
            for step in steps:
                yield path.relative_to(ROOT), step


def _uploads():
    return [
        (path, step)
        for path, step in _steps()
        if str(step.get("uses", "")).startswith("actions/upload-artifact@")
    ]


def test_there_are_uploads_to_check():
    assert len(_uploads()) > 10


def test_every_upload_says_how_long_it_lives():
    unbounded = []
    for path, step in _uploads():
        days = (step.get("with") or {}).get("retention-days")
        if days is None or not 1 <= int(days) <= MAX_RETENTION_DAYS:
            unbounded.append(f"{path}: {step.get('name', step['uses'])} ({days})")
    assert not unbounded, (
        f"set `retention-days` between 1 and {MAX_RETENTION_DAYS}:\n"
        + "\n".join(unbounded)
    )


def test_the_sweep_runs_daily_and_may_only_touch_actions():
    workflow = yaml.safe_load(
        (GITHUB / "workflows" / "artifact-cleanup.yml").read_text(encoding="utf-8")
    )
    # PyYAML reads the bare key `on` as the boolean True.
    triggers = workflow.get("on", workflow.get(True))
    assert triggers["schedule"] and "workflow_dispatch" in triggers
    assert workflow["permissions"] == {"contents": "read"}
    job = workflow["jobs"]["sweep"]
    assert job["permissions"] == {"actions": "write"}
    # Not swept younger than an upload may legitimately live.
    default = triggers["workflow_dispatch"]["inputs"]["max-age-hours"]["default"]
    assert int(default) >= MAX_RETENTION_DAYS * 24
