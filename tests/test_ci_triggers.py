"""CI and Lint run on every change but the few files nothing reads.

They used to list the paths that trigger them, and the list forgot what tests
started reading: pnpm-lock.yaml, pytest.ini, workflows/, capabilities/,
config/, skills/. A change to any of those merged without a test run. The
filter is now an ignore list, and this keeps it short and honest.
"""

from __future__ import annotations

from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

ROOT = Path(__file__).resolve().parents[1]

# Files no build, lint or test reads. Anything added here must be just as inert.
# CHANGELOG.md left the list: tests/test_changelog_fragments.py reads it.
INERT = {
    "LICENSE",
    ".github/ISSUE_TEMPLATE/**",
    ".github/FUNDING.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
}


def _triggers(workflow: str) -> dict:
    data = yaml.safe_load(
        (ROOT / ".github" / "workflows" / workflow).read_text(encoding="utf-8")
    )
    # PyYAML reads the bare key `on` as the boolean True.
    return data.get("on", data.get(True))


@pytest.mark.parametrize("workflow", ["ci.yml", "lint.yml"])
@pytest.mark.parametrize("event", ["push", "pull_request"])
def test_no_whitelist_only_inert_files_ignored(workflow, event):
    trigger = _triggers(workflow)[event]
    assert "paths" not in trigger, f"{workflow} {event}: use paths-ignore"
    assert set(trigger.get("paths-ignore", [])) <= INERT


def test_inert_files_are_read_by_no_test():
    names = {
        "FUNDING.yml",
        "PULL_REQUEST_TEMPLATE.md",
        "ISSUE_TEMPLATE",
    }
    here = Path(__file__).name
    for test in (ROOT / "tests").rglob("*.py"):
        if test.name == here:
            continue
        text = test.read_text(encoding="utf-8", errors="replace")
        for name in names:
            assert name not in text, f"{test} reads {name}: it is no longer inert"
