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
    return sorted(E2E.glob("*.e2e.ts")) + _server_specs()


def _server_specs() -> list[Path]:
    """The specs that drive the app against a real server (their own job)."""
    return sorted(E2E.glob("*.server-e2e.ts"))


def _job(name: str) -> str:
    job = CI[CI.index(f"\n  {name}:") :]
    return job[: job.index("\n  # ----")]


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
    job = _job("e2e")
    assert "pnpm run build" in job
    assert "xvfb-run" in job and "pnpm run test:e2e" in job
    complete = CI[CI.index("ci-complete:") :]
    assert re.search(r"needs: \[[^\]]*\be2e\b", complete)
    assert "needs.e2e.result" in complete


def test_a_retry_never_turns_a_failure_green():
    config = (E2E / "playwright.config.ts").read_text(encoding="utf-8")
    assert "failOnFlakyTests" in config


def test_ci_runs_the_server_specs_and_waits_for_them():
    assert _server_specs()
    job = _job("app-server-e2e")
    assert "setup-python-backend" in job and "pnpm run build" in job
    assert "xvfb-run" in job and "pnpm run test:e2e:server" in job
    complete = CI[CI.index("ci-complete:") :]
    assert re.search(r"needs: \[[^\]]*\bapp-server-e2e\b", complete)
    assert "needs.app-server-e2e.result" in complete


def test_the_server_specs_keep_the_same_rules():
    config = (E2E / "playwright.server.config.ts").read_text(encoding="utf-8")
    # It inherits the base config's retry rules rather than restating them.
    assert "...base" in config
    assert "failOnFlakyTests" not in config and "retries" not in config
    assert "server-e2e.ts" in config
