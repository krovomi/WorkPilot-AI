"""The scenario a card asks the verification to follow (plan of 29 October, IA8).

Each test pins a rule:

* the steps are the card's lines, bounded, without the list markers a person types;
* a failed step fails the verification, and a scenario not carried out in full
  (a step blocked, never reported, or no verifier at all) is never a pass;
* a step is recorded only for this card's scenario, with a number and an
  outcome from closed lists, and a capture only when this verification took it;
* only the toolbox that recorded the steps keeps its Playwright trace: on the
  Claude path the loop's own browser must not overwrite the verifier's;
* the verifier and QA both read the scenario, and the report names the trace.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from verify.loop import LoopOptions, _verifier_prompt  # noqa: E402
from verify.prompt import verify_section  # noqa: E402
from verify.record import (  # noqa: E402
    compute_status,
    fold_events,
    new_record,
    read_events,
    render_report,
    save_record,
)
from verify.scenario import (  # noqa: E402
    MAX_STEP,
    MAX_STEPS,
    TRACE_FILE,
    card_scenario,
    parse_scenario,
    scenario_status,
)
from verify.tools import VerifyToolbox  # noqa: E402

SCENARIO = "1. Open the orders page\n2) Click Save\n\n- The toast says Saved"
STEPS = ["Open the orders page", "Click Save", "The toast says Saved"]


def _launched():
    return {
        "name": "web",
        "kind": "web-frontend",
        "launch": {"status": "ready"},
        "errors": [],
    }


def _record(*steps):
    record = new_record(targets=[_launched()], scenario_requested=list(STEPS))
    fold_events(
        record,
        [{"kind": "scenario_step", "step": n, "outcome": o} for n, o in steps],
    )
    return record


class TestParse:
    def test_one_step_per_line_without_the_list_markers(self):
        assert parse_scenario(SCENARIO) == STEPS
        assert parse_scenario("* [ ] check the badge\n• [x] reload") == [
            "check the badge",
            "reload",
        ]

    def test_bounded_and_cleaned(self):
        many = "\n".join(f"step {n}" for n in range(50))
        assert len(parse_scenario(many)) == MAX_STEPS
        assert len(parse_scenario("x" * 1000)[0]) == MAX_STEP
        assert parse_scenario("click\x1b[31m Save\x00") == ["click [31m Save"]
        assert parse_scenario(None) == [] and parse_scenario(["a"]) == []

    def test_read_from_the_card(self, tmp_path):
        assert card_scenario(tmp_path) == []
        (tmp_path / "task_metadata.json").write_text(
            json.dumps({"verifyScenario": SCENARIO}), encoding="utf-8"
        )
        assert card_scenario(tmp_path) == STEPS
        assert card_scenario(None) == []


class TestVerdict:
    def test_no_scenario_changes_nothing(self):
        record = new_record(targets=[_launched()])
        assert scenario_status(record) is None
        assert compute_status(record) == ("pass", "")

    def test_every_step_passed_passes(self):
        assert compute_status(_record((1, "pass"), (2, "pass"), (3, "pass"))) == (
            "pass",
            "",
        )

    def test_a_failed_step_fails(self):
        status, reason = compute_status(_record((1, "pass"), (2, "fail")))
        assert status == "fail" and "2" in reason

    def test_a_scenario_not_carried_out_is_never_a_pass(self):
        # Blocked, missing, and no verifier session at all.
        for record in (
            _record((1, "pass"), (2, "blocked"), (3, "pass")),
            _record((1, "pass"), (2, "pass")),
            _record(),
        ):
            status, reason = compute_status(record)
            assert status == "unknown" and "scenario" in reason

    def test_the_last_report_of_a_step_stands_and_strangers_are_ignored(self):
        record = _record(
            (1, "pass"), (2, "fail"), (2, "pass"), (3, "pass"), (9, "fail")
        )
        assert compute_status(record) == ("pass", "")

    def test_a_measured_error_still_fails_first(self):
        record = _record((1, "pass"), (2, "pass"), (3, "pass"))
        record["targets"][0]["errors"] = [{"kind": "exception", "message": "boom"}]
        assert compute_status(record)[0] == "fail"


class TestReaders:
    def test_the_verifier_is_given_the_steps_and_how_to_report_them(self):
        prompt = _verifier_prompt(
            LoopOptions(),
            new_record(targets=[_launched()], scenario_requested=STEPS),
            "",
        )
        assert "## Scenario written on the card" in prompt
        assert "2. Click Save" in prompt and "kind=scenario_step" in prompt
        assert "never report a step `pass` that you did not see happen" in prompt
        plain = _verifier_prompt(LoopOptions(), new_record(targets=[_launched()]), "")
        assert "Scenario written on the card" not in plain

    def test_report_and_qa_name_each_step_and_the_trace(self, tmp_path):
        record = _record((1, "pass"), (2, "fail"))
        record["scenario_steps"][1]["note"] = "no toast"
        record["trace"] = str(tmp_path / "verify" / TRACE_FILE)
        record["status"], record["reason"] = compute_status(record)
        report = render_report(record)
        assert "2. Click Save — **fail**" in report and "no toast" in report
        assert "3. The toast says Saved — **not reported**" in report
        assert "npx playwright show-trace" in report
        save_record(tmp_path / "verify", record)
        section = verify_section(tmp_path)
        assert "2. Click Save — fail" in section and TRACE_FILE in section


class FakeBrowser:
    available = True
    engine = "playwright"
    reasons: list[str] = []

    def __init__(self):
        self.saved: list[bool] = []

    async def save_trace(self, keep: bool = True):
        self.saved.append(keep)
        return Path("/trace.zip") if keep else None

    async def close(self):
        pass


@pytest.fixture
def toolbox(tmp_path):
    spec = tmp_path / "spec"
    spec.mkdir()
    (spec / "task_metadata.json").write_text(
        json.dumps({"verifyScenario": SCENARIO}), encoding="utf-8"
    )
    box = VerifyToolbox(tmp_path, spec, changed_files=[])
    box._browser = FakeBrowser()
    return box


def _record_step(box, **args):
    return asyncio.run(box.call("verify_record", {"kind": "scenario_step", **args}))


class TestTools:
    def test_a_step_is_recorded_with_closed_values(self, toolbox):
        shot = toolbox.base / "screenshots" / "step-1.png"
        shot.parent.mkdir(parents=True)
        shot.write_bytes(b"png")
        answer = _record_step(
            toolbox, step=1, outcome="pass", note="list shown", screenshot=str(shot)
        )
        assert answer == "Recorded step 1 of 3 (pass)."
        assert _record_step(toolbox, step=4, outcome="pass").startswith("Error: step")
        assert _record_step(toolbox, step="x", outcome="pass").startswith("Error: step")
        assert _record_step(toolbox, step=2, outcome="ok").startswith("Error: outcome")
        events = [e for e in read_events(toolbox.base) if e["kind"] == "scenario_step"]
        assert len(events) == 1
        assert events[0]["screenshot"] == str(shot.resolve())

    def test_a_capture_it_did_not_take_is_not_kept(self, toolbox, tmp_path):
        outside = tmp_path / "secret.png"
        outside.write_bytes(b"png")
        _record_step(toolbox, step=1, outcome="pass", screenshot=str(outside))
        _record_step(toolbox, step=2, outcome="pass", screenshot="../../secret.png")
        events = [e for e in read_events(toolbox.base) if e["kind"] == "scenario_step"]
        assert all("screenshot" not in e for e in events)

    def test_no_scenario_no_step(self, tmp_path):
        box = VerifyToolbox(tmp_path, tmp_path / "spec", changed_files=[])
        assert _record_step(box, step=1, outcome="pass").startswith(
            "Error: this card has no scenario"
        )

    def test_the_verdict_writes_the_trace_of_the_toolbox_that_drove(self, toolbox):
        _record_step(toolbox, step=1, outcome="pass")
        asyncio.run(
            toolbox.call("verify_record", {"kind": "verdict", "verdict": "pass"})
        )
        assert toolbox._browser.saved == [True]

    def test_a_toolbox_that_recorded_no_step_drops_its_trace(self, toolbox):
        browser = toolbox._browser
        asyncio.run(toolbox.aclose())
        assert browser.saved == [False]


class TestApi:
    def _client(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from verify.api import router

        app = FastAPI()
        app.include_router(router)
        return TestClient(app)

    def test_steps_point_at_captures_and_the_trace_is_served_without_its_path(
        self, tmp_path
    ):
        spec = tmp_path / ".workpilot" / "specs" / "001-x"
        base = spec / "verify"
        shot = base / "screenshots" / "step-1.png"
        shot.parent.mkdir(parents=True)
        shot.write_bytes(b"\x89PNG\r\n\x1a\n0000")
        (base / TRACE_FILE).write_bytes(b"PK\x03\x04zip")
        record = new_record(status="pass", finished_at=1.0, scenario_requested=STEPS)
        record["screenshots"] = [{"path": str(shot), "label": "step 1"}]
        record["scenario_steps"] = [
            {"step": 1, "outcome": "pass", "screenshot": str(shot)},
            {"step": 2, "outcome": "blocked"},
        ]
        record["trace"] = str(base / TRACE_FILE)
        save_record(base, record)

        client = self._client()
        params = {"project_dir": str(tmp_path), "spec_id": "001-x"}
        body = client.get("/api/verify/", params=params).json()["record"]
        assert body["scenario_steps"] == [
            {"step": 1, "outcome": "pass", "screenshotIndex": 0},
            {"step": 2, "outcome": "blocked"},
        ]
        assert body["trace"] is True and str(tmp_path) not in json.dumps(body)
        trace = client.get("/api/verify/trace", params=params)
        assert trace.status_code == 200 and trace.content.startswith(b"PK")
        assert "001-x-scenario-trace.zip" in trace.headers["content-disposition"]

    def test_a_trace_outside_the_spec_or_of_another_name_is_refused(self, tmp_path):
        spec = tmp_path / ".workpilot" / "specs" / "001-x"
        outside = tmp_path / TRACE_FILE
        outside.write_bytes(b"PK")
        other = spec / "verify" / "notes.zip"
        other.parent.mkdir(parents=True)
        other.write_bytes(b"PK")
        client = self._client()
        params = {"project_dir": str(tmp_path), "spec_id": "001-x"}
        for path in (outside, other, None):
            save_record(
                spec / "verify", new_record(status="pass", trace=path and str(path))
            )
            assert client.get("/api/verify/trace", params=params).status_code == 404
