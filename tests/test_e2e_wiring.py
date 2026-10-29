"""The E2E specs drive the real app and CI runs them (plan of 29 October, N3).

The specs this replaced wrote files and read them back without starting the
app, and the few that started it skipped themselves when it failed: 32 green,
16 skipped, nothing checked. Keep both failure modes out.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
E2E = ROOT / "apps" / "frontend" / "e2e"
CI = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")


def _specs() -> list[Path]:
    return sorted(E2E.glob("*.e2e.ts"))


def test_there_are_specs():
    assert _specs()


def test_every_spec_starts_the_app_through_the_harness():
    for spec in _specs():
        assert "launchIsolatedApp" in spec.read_text(encoding="utf-8"), spec.name


def test_no_spec_skips_itself():
    pattern = re.compile(r"\btest\.(skip|fixme)\s*\(")
    for spec in _specs():
        assert not pattern.search(spec.read_text(encoding="utf-8")), spec.name


def test_ci_runs_the_specs_and_waits_for_them():
    job = CI[CI.index("\n  e2e:") :]
    job = job[: job.index("\n  # ----")]
    assert "pnpm run build" in job
    assert "xvfb-run" in job and "pnpm run test:e2e" in job
    complete = CI[CI.index("ci-complete:") :]
    assert re.search(r"needs: \[[^\]]*\be2e\b", complete)
    assert "needs.e2e.result" in complete


def test_a_retry_never_turns_a_failure_green():
    config = (E2E / "playwright.config.ts").read_text(encoding="utf-8")
    assert "failOnFlakyTests" in config
