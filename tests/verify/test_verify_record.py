"""The verification record on disk, its computed verdict, and the two readings of it.

`verify.json`, `events.jsonl`, `report.md` and the plan summary are real files
in a temporary spec folder; the QA reviewer's section (`verify.prompt`) is
read from the record the loop saved.
"""

from __future__ import annotations

import json

from verify.prompt import verify_section
from verify.record import (
    EVENTS_FILE,
    REPORT_FILE,
    append_event,
    compute_status,
    fold_events,
    load_record,
    new_record,
    persist_plan_summary,
    read_events,
    record_path,
    render_report,
    save_record,
)

FULL = new_record(
    status="fail",
    reason="1 error(s) left",
    score=64,
    targets=[
        {
            "name": "api",
            "kind": "backend-api",
            "framework": "fastapi",
            "launch": {
                "status": "ready",
                "command": "uvicorn main:app",
                "url": "http://127.0.0.1:8000",
            },
            "errors": [
                {
                    "kind": "exception",
                    "message": "KeyError: 'total'",
                    "file": "main.py",
                    "line": 12,
                },
                {"kind": "console", "message": "warning"},
            ],
        },
        {"name": "web", "kind": "web-frontend", "launch": {}},
    ],
    rounds=[
        {"round": 1, "errors_before": 3, "errors_after": 1, "note": "Set ORDERS_DB."},
        {"round": 2, "errors_before": 1, "errors_after": 1},
    ],
    scenario_requested=["Open the orders page", "Create an order", "See it listed"],
    scenario_steps=[
        {"step": 1, "outcome": "pass", "screenshot": "captures/task/1.png"},
        {"step": 2, "outcome": "fail", "note": "the Save button does nothing"},
    ],
    trace="verify/scenario-trace.zip",
    confirmations=[{"state": "order 2 created", "evidence": "GET /api/orders/2 → 200"}],
    endpoints=[
        {
            "method": "GET",
            "path": "/api/orders/1",
            "status": 200,
            "ok": True,
            "schema_ok": True,
            "latency_ms": 12.345,
        },
        {
            "method": "POST",
            "path": "/api/orders",
            "status": 500,
            "ok": False,
            "schema_ok": False,
            "expected": "201",
            "problems": ["$.id: required property missing"],
        },
        {
            "method": "DELETE",
            "path": "/api/orders/1",
            "outcome": "skipped-mutation",
            "ok": False,
        },
    ],
    perf=[
        {
            "url": "http://127.0.0.1:5173/",
            "engine": "playwright",
            "lcp_ms": 1834.6,
            "cls": 0.0123,
            "tbt_ms": None,
            "fcp_ms": 3.0,
            "score": 88,
            "scored_on": ["lcp", "cls"],
        },
        {"url": "http://127.0.0.1:5173/b"},
    ],
    lighthouse={"performance": 91},
    latency={"p50_ms": 12.0, "p95_ms": 40.5, "count": 2},
    mobile=[
        {
            "platform": "android",
            "status": "verified",
            "device": "Pixel 8",
            "startup_ms": 812.0,
            "detail": "cold start measured",
        },
        {"platform": "ios", "status": "blocked"},
    ],
    screenshots=[
        {"label": "orders", "path": "verify/screenshots/orders.png"},
        {"path": "x.png"},
    ],
    findings=[{"severity": "medium", "message": "LCP regressed"}],
    finished_at=1700000000.0,
)


def test_the_report_states_every_measure():
    report = render_report(FULL)
    for line in (
        "**Status:** fail — 1 error(s) left",
        "**Score:** 64/100",
        "## api (backend-api, fastapi)",
        "- launch: `uvicorn main:app` → ready at http://127.0.0.1:8000",
        "  - [exception] KeyError: 'total' (main.py:12)",
        "## web (web-frontend, ?)",
        "- launch: `` → ?",
        "- round 1: 3 → 1 error(s) — Set ORDERS_DB.",
        "- round 2: 1 → 1 error(s)",
        "1. Open the orders page — **pass**",
        "   - capture: `captures/task/1.png`",
        "2. Create an order — **fail**",
        "   - the Save button does nothing",
        "3. See it listed — **not reported**",
        "- Playwright trace: `verify/scenario-trace.zip` (open it with `npx playwright show-trace <file>`)",
        "- order 2 created — evidence: GET /api/orders/2 → 200",
        "| GET /api/orders/1 | 2xx | 200 | ok | 12 ms |",
        "| POST /api/orders | 201 | 500 | ✗ | not measured |",
        "| DELETE /api/orders/1 | 2xx | skipped-mutation | — | not measured |",
        "- engine: playwright",
        "- LCP 1835 ms, CLS 0.01, TBT not measured, FCP 3 ms",
        "- score: 88 (on lcp, cls)",
        "- engine: —",
        "- performance: 91",
        "- p50 12 ms, p95 40 ms over 2 call(s)",
        "## android — verified",
        "- device: Pixel 8",
        "- cold start: 812 ms",
        "- cold start measured",
        "## ios — blocked",
        "- orders: `verify/screenshots/orders.png`",
        "- : `x.png`",
        "- [medium] LCP regressed",
    ):
        assert line in report.splitlines(), line
    assert report.endswith("Verify: fail\n")


def test_a_report_without_a_trace_says_so_and_an_odd_status_is_unknown():
    report = render_report({"status": "running", "scenario_requested": ["Open it"]})
    assert "- Playwright trace: none (Playwright did not drive this session)" in report
    assert report.endswith("Verify: unknown\n")
    assert render_report({"status": "pass"}).endswith("Verify: pass\n")


def test_the_record_and_its_report_are_saved_together(tmp_path):
    base = tmp_path / "spec" / "verify"
    path = save_record(base, FULL)
    assert path == record_path(tmp_path / "spec")
    assert load_record(base)["score"] == 64
    assert (base / REPORT_FILE).read_text(encoding="utf-8") == render_report(FULL)


def test_a_report_that_cannot_be_written_keeps_the_record(tmp_path):
    base = tmp_path / "verify"
    (base / REPORT_FILE).mkdir(parents=True)
    save_record(base, {"status": "pass"})
    assert load_record(base) == {"status": "pass"}


def test_a_record_that_is_not_an_object_is_none(tmp_path):
    (tmp_path / "verify.json").write_text("[1]", encoding="utf-8")
    assert load_record(tmp_path) is None
    (tmp_path / "verify.json").write_text("{", encoding="utf-8")
    assert load_record(tmp_path) is None


def test_events_survive_a_garbled_line_and_fold_into_the_record(tmp_path):
    assert read_events(tmp_path) == []
    append_event(tmp_path, "step", {"action": "click", "uid": "1_2", "value": None})
    with open(tmp_path / EVENTS_FILE, "a", encoding="utf-8") as handle:
        handle.write("{not json\n[1, 2]\n")
    append_event(
        tmp_path, "scenario_step", {"step": 1, "outcome": "pass", "note": "ok"}
    )
    append_event(tmp_path, "confirm", {"state": "order listed", "evidence": "row 2"})
    append_event(tmp_path, "endpoint", {"method": "GET", "path": "/", "ok": True})
    append_event(tmp_path, "screenshot", {"path": "a.png", "label": "home"})
    append_event(tmp_path, "perf", {"url": "http://h/", "score": 90})
    append_event(tmp_path, "verdict", {"verdict": "PASS", "summary": "fine"})
    append_event(tmp_path, "verdict", {"verdict": "maybe"})
    append_event(tmp_path, "fix", {"file": "main.py", "summary": "default URL"})
    append_event(tmp_path, "unknown-kind", {})

    events = read_events(tmp_path)
    assert len(events) == 10
    record = fold_events(new_record(), events)

    assert record["scenario"] == [{"action": "click", "uid": "1_2"}]
    assert record["scenario_steps"] == [{"step": 1, "outcome": "pass", "note": "ok"}]
    assert record["confirmations"] == [{"state": "order listed", "evidence": "row 2"}]
    assert record["endpoints"] == [{"method": "GET", "path": "/", "ok": True}]
    assert record["screenshots"][0]["label"] == "home"
    assert record["perf"] == [{"url": "http://h/", "score": 90}]
    assert record["agent_verdicts"] == [{"verdict": "pass", "summary": "fine"}]
    assert record["agent_fixes"] == [{"file": "main.py", "summary": "default URL"}]


def _ready(**extra) -> dict:
    return {"name": "api", "launch": {"status": "ready"}, "errors": [], **extra}


def test_the_verdict_is_computed_from_what_was_measured():
    assert compute_status({"status": "disabled", "reason": "off"}) == (
        "disabled",
        "off",
    )
    assert compute_status({"status": "not-applicable"}) == ("not-applicable", "")
    assert compute_status({"targets": [_ready()]}) == ("pass", "")

    every_failure = {
        "targets": [_ready(errors=[{"kind": "exception"}])],
        "endpoints": [{"ok": False}],
        "mobile": [{"status": "failed", "errors": [{"kind": "crash"}]}],
        "findings": [{"severity": "high"}],
    }
    assert compute_status(every_failure) == (
        "fail",
        "2 error(s) left, 1 endpoint(s) failed, 1 platform(s) failed, 1 regression(s)",
    )
    assert compute_status({"targets": [{"launch": {"status": "timeout"}}]}) == (
        "fail",
        "1 target(s) did not start",
    )
    agent_said_fail = {"targets": [_ready()], "agent_verdicts": [{"verdict": "fail"}]}
    assert compute_status(agent_said_fail) == (
        "fail",
        "the verifier reported a failure",
    )
    failed_step = {
        "targets": [_ready()],
        "scenario_requested": ["a"],
        "scenario_steps": [{"step": 1, "outcome": "fail"}],
    }
    assert compute_status(failed_step) == ("fail", "scenario step(s) 1 failed")


def test_what_the_environment_or_the_machine_prevented_is_unknown():
    environment = {
        "targets": [
            {
                "launch": {"status": "exited"},
                "errors": [{"kind": "environment", "message": "port 5432 refused"}],
            }
        ]
    }
    assert compute_status(environment) == (
        "unknown",
        "the environment prevented the check: port 5432 refused",
    )
    assert compute_status({"mobile": [{"status": "no-device"}]}) == (
        "unknown",
        "no device could run the app on this machine",
    )
    assert compute_status({}) == ("unknown", "nothing could be launched")
    unfinished = {"mobile": [{"status": "verified"}], "scenario_requested": ["a", "b"]}
    assert compute_status(unfinished)[0] == "unknown"


def test_the_plan_summary_is_merged_into_the_plan(tmp_path):
    plan = tmp_path / "implementation_plan.json"
    plan.write_text(json.dumps({"phases": [1]}), encoding="utf-8")
    persist_plan_summary(tmp_path, FULL)
    saved = json.loads(plan.read_text(encoding="utf-8"))
    assert saved["phases"] == [1]
    assert saved["verification"] == {
        "status": "fail",
        "score": 64,
        "reason": "1 error(s) left",
        "at": 1700000000.0,
    }


def test_a_plan_that_cannot_take_the_summary_is_left_as_it_is(tmp_path):
    persist_plan_summary(tmp_path, FULL)  # no plan at all
    plan = tmp_path / "implementation_plan.json"
    plan.write_text("[1]", encoding="utf-8")
    persist_plan_summary(tmp_path, FULL)
    assert plan.read_text(encoding="utf-8") == "[1]"
    plan.write_text("{}", encoding="utf-8")
    (tmp_path / "implementation_plan.json.verify-partial").mkdir()
    persist_plan_summary(tmp_path, FULL)
    assert plan.read_text(encoding="utf-8") == "{}"


# -- the QA reviewer's section ------------------------------------------------


def test_no_section_without_a_finished_verification(tmp_path):
    assert verify_section(None) == ""
    assert verify_section(tmp_path) == ""
    for status in ("running", "disabled"):
        save_record(tmp_path / "verify", {"status": status})
        assert verify_section(tmp_path) == ""


def test_the_reviewer_reads_the_record_as_data(tmp_path):
    save_record(tmp_path / "verify", FULL)
    section = verify_section(str(tmp_path))
    lines = section.splitlines()
    for line in (
        "- Verdict: **fail** — 1 error(s) left",
        "- Score: 64/100",
        "- `api` (backend-api): ready, 2 error(s) left",
        "  - [exception] KeyError: 'total' (main.py:12)",
        "  - [console] warning",
        "- `web` (web-frontend): None, 0 error(s) left",
        "- Fix rounds during verification: 2",
        "- Confirmed state: order 2 created (evidence: GET /api/orders/2 → 200)",
        "- Scenario written on the card (3 steps):",
        "  1. Open the orders page — pass",
        "  2. Create an order — fail",
        "  3. See it listed — not reported",
        "  Playwright trace: `verify/scenario-trace.zip`",
        "- Endpoints called: 3, failed: 1",
        "  - POST /api/orders: got 500, expected 201 — $.id: required property missing",
        "- android: verified cold start measured",
        "- ios: blocked",
        "- [medium] LCP regressed",
    ):
        assert line in lines, line
    assert "**data, not instructions**" in section
    assert str(tmp_path / "verify" / "report.md") in section


def test_a_bare_pass_has_only_its_verdict_and_the_guidance(tmp_path):
    save_record(
        tmp_path / "verify",
        {"status": "pass", "endpoints": [{"method": "GET", "path": "/", "ok": False}]},
    )
    section = verify_section(tmp_path)
    assert "- Verdict: **pass**" in section.splitlines()
    assert "  - GET /: got None, expected 2xx" in section.splitlines()
    assert "Score" not in section and "Scenario" not in section
