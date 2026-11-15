"""The loop on the stacks `tests/test_verify_loop.py` does not launch.

* A static site served by Python, opened in a real browser (Playwright on
  the installed Chromium; skipped without one): a console error on the page
  is an error to fix, the fixer rewrites the page, the next launch is clean,
  and the evidence — trace, captures, score — is measured.
* A phone app: the loop hands it to `verify.mobile`, played here by stand-ins
  of the emulator tools (`tests/verify/test_verify_mobile.py` checks those
  verdicts one by one).
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest
from verify.devtools import chrome_executable
from verify.loop import FIX_REQUEST_FILE, LoopOptions, run_verify_loop

BROKEN_PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Orders</title></head>
<body><h1>Orders</h1><p>2 orders</p>
<script>console.error("orders.js: cannot read property 'total' of undefined")</script>
</body></html>"""
FIXED_PAGE = BROKEN_PAGE.replace(
    """<script>console.error("orders.js: cannot read property 'total' of undefined")</script>""",
    "",
)


@pytest.fixture
def site(tmp_path, monkeypatch):
    if not chrome_executable():
        pytest.skip("no Chromium on this machine")
    pytest.importorskip("playwright")
    root = tmp_path / "site"
    root.mkdir()
    (root / "index.html").write_text(BROKEN_PAGE, encoding="utf-8")
    spec = root / ".workpilot" / "specs" / "001-orders"
    spec.mkdir(parents=True)
    monkeypatch.setenv(
        "PATH",
        str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
    )
    monkeypatch.setenv("VERIFY_BROWSER", "playwright")
    monkeypatch.setenv("VERIFY_LAUNCH_TIMEOUT", "40")
    monkeypatch.setenv("BRAIN_ENABLED", "false")
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "brain"))
    return root, spec


def test_a_console_error_is_fixed_and_the_page_is_measured(site):
    root, spec = site
    seen: list[str] = []

    async def runner(agent_type, prompt):
        seen.append(agent_type)
        assert "cannot read property 'total'" in prompt
        (root / "index.html").write_text(FIXED_PAGE, encoding="utf-8")
        return "complete", "Removed the failing script."

    logs: list[str] = []
    record = asyncio.run(
        run_verify_loop(
            root,
            spec,
            runner,
            LoopOptions(effort="low", changed_files=["index.html"], log=logs.append),
        )
    )

    assert seen == ["qa_fixer"]
    assert record["status"] == "pass", record["reason"]
    assert record["browser"]["engine"] == "playwright"
    [target] = record["targets"]
    assert (target["framework"], target["errors"]) == ("static", [])
    assert record["rounds"][0]["fixed"] is True
    assert record["rounds"][0]["errors"][0]["kind"] == "console"
    assert record["perf"] and record["perf"][0]["engine"] == "playwright"
    assert record["score"] is not None
    assert record["screenshots"], "the final state is captured"
    assert all(Path(s["path"]).is_file() for s in record["screenshots"])
    assert (spec / FIX_REQUEST_FILE).read_text(encoding="utf-8").count("console") >= 1
    assert any("fixer round 1" in line for line in logs)


def test_a_fix_request_that_cannot_be_written_still_reaches_the_fixer(site):
    root, spec = site
    (spec / FIX_REQUEST_FILE).mkdir()
    prompts: list[str] = []

    async def runner(agent_type, prompt):
        prompts.append(prompt)
        (root / "index.html").write_text(FIXED_PAGE, encoding="utf-8")
        return "complete", ""

    logs: list[str] = []
    record = asyncio.run(
        run_verify_loop(
            root,
            spec,
            runner,
            LoopOptions(effort="low", changed_files=["index.html"], log=logs.append),
        )
    )
    assert record["status"] == "pass", record["reason"]
    assert prompts and "cannot read property" in prompts[0]
    assert f"verify: could not write {FIX_REQUEST_FILE}" in logs


# -- a phone app -----------------------------------------------------------


def test_a_phone_app_is_verified_on_its_platforms(tmp_path, monkeypatch):
    import verify.mobile as verify_mobile_module

    monkeypatch.setenv("BRAIN_ENABLED", "false")
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "brain"))
    root = tmp_path / "app"
    (root / "android").mkdir(parents=True)
    (root / "pubspec.yaml").write_text(
        "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n", encoding="utf-8"
    )
    spec = root / ".workpilot" / "specs" / "001-login"
    spec.mkdir(parents=True)
    asked = {}

    def verify_mobile(project, spec_dir, base, platforms, *, build):
        asked.update(platforms=platforms, build=build)
        return [
            verify_mobile_module.PlatformVerification(
                "android", "verified", device="Pixel 8 [emulator-5554]"
            )
        ]

    monkeypatch.setattr(verify_mobile_module, "verify_mobile", verify_mobile)
    logs: list[str] = []
    record = asyncio.run(
        run_verify_loop(
            root,
            spec,
            None,
            LoopOptions(
                effort="low",
                changed_files=["lib/main.dart"],
                mobile_build=False,
                log=logs.append,
            ),
        )
    )

    assert asked == {"platforms": ["android"], "build": False}
    assert record["mobile"][0]["status"] == "verified"
    assert record["targets"] == []
    assert any(line.startswith("verify: mobile (") for line in logs)


def test_a_fixer_that_changes_nothing_is_stopped_when_the_count_stalls(site):
    root, spec = site
    calls: list[str] = []

    async def runner(agent_type, prompt):
        calls.append(agent_type)
        return "complete", "Looked at it.\nNothing to change."

    logs: list[str] = []
    record = asyncio.run(
        run_verify_loop(
            root,
            spec,
            runner,
            LoopOptions(effort="low", changed_files=["index.html"], log=logs.append),
        )
    )

    assert record["status"] == "fail"
    assert calls == ["qa_fixer", "qa_fixer"]
    assert [r["fixed"] for r in record["rounds"]] == [False, False]
    assert record["rounds"][0]["note"] == "Nothing to change."
    assert (
        "verify: site: the error count stopped falling — stopping the fix loop" in logs
    )
