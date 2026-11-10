"""Dated evidence, the controls judged with it, the saved reports and the runner (#357).

The evidence comes from what the tasks, git and the configuration already
left, each item with its date; a control is covered, failing, stale or
missing at the end of the period, and alerted after 30 days without evidence.
A saved report is never rewritten by the monthly run, and nothing is written
through a link.
"""

from __future__ import annotations

import calendar
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from compliance_collector import (
    Evidence,
    build_report,
    collect_evidence,
    list_reports,
    load_config,
    load_frameworks,
    load_report,
    month_period,
    run_monthly,
    save_config,
    save_report,
)
from compliance_collector.evidence import SPEC_RECORDS
from compliance_collector.frameworks import Control, Framework

DAY = 86_400
NOW = time.time()


def _git(root: Path, *args: str, when: int | None = None) -> None:
    # A git hook exports GIT_* variables (index, author): the test's repo ignores them.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(
        GIT_AUTHOR_NAME="Ana", GIT_AUTHOR_EMAIL="ana@example.test",
        GIT_COMMITTER_NAME="Ana", GIT_COMMITTER_EMAIL="ana@example.test",
    )  # fmt: skip
    if when is not None:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = f"@{when} +0000"
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, env=env)


def _write(root: Path, rel: str, data) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    text = data if isinstance(data, str) else json.dumps(data)
    path.write_text(text, encoding="utf-8")


def test_the_records_named_are_the_ones_the_features_write():
    from dependency_guard import RECORD_FILE as guard
    from mutation_gate import RECORD_FILE as mutation
    from provenance import DOSSIER_DIR, DOSSIER_FILE
    from red_team import RECORD_FILE as red_team
    from review.state import REVIEW_STATE_FILE
    from verify.record import RECORD_FILE as verify
    from workflows.hard_gates import GATE_RECORD

    assert SPEC_RECORDS == {
        "review_state": REVIEW_STATE_FILE,
        "plan": "implementation_plan.json",
        "hard_gates": GATE_RECORD,
        "verify": f"verify/{verify}",
        "mutation": mutation,
        "dependency_guard": guard,
        "red_team": red_team,
        "security_scan": "security_scan_results.json",
        "dossier": f"{DOSSIER_DIR}/{DOSSIER_FILE}",
    }


def _task(root: Path, name: str, at: float, *, approved=True, rejected=False) -> None:
    spec = f".workpilot/specs/{name}"
    iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at))
    _write(
        root,
        f"{spec}/review_state.json",
        {"approved": approved, "approved_by": "lea", "approved_at": iso},
    )
    _write(
        root,
        f"{spec}/implementation_plan.json",
        {
            "qa_signoff": {
                "status": "rejected" if rejected else "approved",
                "timestamp": iso,
                "issues_found": [{}],
            }
        },
    )
    _write(
        root,
        f"{spec}/hard_gates.json",
        {
            "at": at,
            "results": [
                {"gate": "tests-pass", "held": not rejected},
                {"gate": "deps-exist", "held": True},
            ],
        },
    )
    _write(
        root,
        f"{spec}/dependency_guard.json",
        {"status": "blocked" if rejected else "pass", "checked_at": iso},
    )
    _write(root, f"{spec}/red_team.json", {"status": "pass", "finished_at": at})


def test_the_tasks_records_are_dated_evidence(tmp_path: Path):
    _task(tmp_path, "001-a", NOW - 2 * DAY)
    _task(tmp_path, "002-b", NOW - DAY, rejected=True)
    _write(tmp_path, ".workpilot/specs/003-c/review_state.json", "{broken")
    found = collect_evidence(tmp_path, 0, NOW, use_git=False)
    by_task = {}
    for item in found:
        by_task.setdefault(item.task, []).append((item.kind, item.outcome))
    assert sorted(by_task["001-a"]) == [
        ("code_review", "pass"),
        ("security", "pass"),
        ("security", "pass"),
        ("spec_approval", "pass"),
        ("tests", "pass"),
    ]
    assert ("code_review", "fail") in by_task["002-b"]
    assert ("security", "fail") in by_task["002-b"]
    approval = next(e for e in found if e.kind == "spec_approval" and e.task == "001-a")
    assert approval.actor == "lea" and abs(approval.at - (NOW - 2 * DAY)) < 2
    assert "003-c" not in by_task


def test_git_and_the_configuration_in_place(tmp_path: Path):
    _git(tmp_path, "init", "-q", "-b", "main")
    old = int(NOW - 400 * DAY)
    _write(tmp_path, "SECURITY.md", "# Security\n")
    _write(tmp_path, ".github/CODEOWNERS", "* @team\n")
    _write(tmp_path, "deploy/Dockerfile", "FROM scratch\n")
    _write(tmp_path, "docs/postmortems/2026-01-outage.md", "# Outage\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "policies", when=old)
    _write(tmp_path, "src/app.go", "package main\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "Add the app (#12)", when=int(NOW - 3 * DAY))
    _git(tmp_path, "tag", "v1.0.0")
    _write(
        tmp_path,
        ".workpilot/incidents/db.json",
        {
            "title": "DB down",
            "detected_at": NOW - 5 * DAY,
            "resolved_at": NOW - 5 * DAY + 7200,
        },
    )

    found = collect_evidence(tmp_path, NOW - 30 * DAY, NOW)
    kinds = {(e.kind, e.source) for e in found}
    assert ("policy", "SECURITY.md") in kinds
    assert ("access", ".github/CODEOWNERS") in kinds
    assert ("deployment", "deploy/Dockerfile") in kinds
    assert ("incident", "docs/postmortems/2026-01-outage.md") in kinds
    assert ("release", "tag v1.0.0") in kinds
    merge = next(e for e in found if e.kind == "merge")
    assert merge.title == "Add the app (#12)" and merge.actor == "Ana"
    policy = next(e for e in found if e.kind == "policy")
    assert abs(policy.at - old) < 2  # dated by its last commit, not by today
    # the "policies" commit is older than the period: not a change of this period
    assert not [e for e in found if e.kind == "change" and e.title == "policies"]
    incident = next(e for e in found if e.source == ".workpilot/incidents/db.json")
    assert incident.title == "DB down (resolved in 2.0 h)"


def _framework() -> Framework:
    def control(cid, groups, age):
        return Control(
            cid, {"en": cid}, tuple(tuple(g) for g in groups), age, {"en": f"do {cid}"}
        )

    return Framework(
        "test",
        "Test",
        "1",
        (
            control("covered", [["change", "merge"], ["tests"]], 30),
            control("failing", [["code_review"]], 30),
            control("stale", [["policy"]], 365),
            control("missing", [["incident"]], 365),
        ),
        "bundled",
    )


def _ev(kind, days_ago, outcome="info", until=NOW):
    return Evidence(kind, until - days_ago * DAY, kind, kind, outcome)


def test_each_control_is_covered_failing_stale_or_missing():
    since, until = NOW - 30 * DAY, NOW
    evidence = [
        _ev("merge", 2, "pass"),
        _ev("tests", 40, "pass"),  # too old alone...
        _ev("tests", 5, "fail"),
        _ev("tests", 4, "pass"),  # ...but a pass this month covers it
        _ev("code_review", 3, "fail"),
        _ev("policy", 500),
    ]
    report = build_report(
        _framework(), evidence, since, until, now=NOW, period="2026-11"
    )
    status = {c["id"]: c["status"] for c in report["controls"]}
    assert status == {
        "covered": "covered",
        "failing": "failing",
        "stale": "stale",
        "missing": "missing",
    }
    assert report["coveragePercent"] == 25.0
    alerts = {c["id"]: c["alert"] for c in report["controls"]}
    assert alerts == {
        "covered": False,
        "failing": False,
        "stale": True,
        "missing": True,
    }
    assert report["risks"] == ["failing", "missing"]
    gaps = {g["controlId"]: g for g in report["gaps"]}
    assert set(gaps) == {"failing", "stale", "missing"}
    assert gaps["missing"]["missingKinds"] == ["incident"]
    assert gaps["missing"]["recommendation"] == {"en": "do missing"}
    assert report["summary"]["testsFailed"] == 1
    assert report["summary"]["reviewsRejected"] == 1
    # the mapping it was judged with travels with the report
    assert report["controls"][0]["requirements"] == [["change", "merge"], ["tests"]]


def test_months():
    start, end = month_period("2026-02")
    assert time.gmtime(start)[:3] == (2026, 2, 1)
    assert time.gmtime(end)[:6] == (2026, 2, 28, 23, 59, 59)
    for bad in ("2026-13", "26-01", "2026-1", "../x"):
        with pytest.raises(ValueError):
            month_period(bad)


def test_reports_are_saved_listed_and_never_through_a_link(tmp_path: Path):
    framework = load_frameworks()[0]["soc2"]
    report = build_report(
        framework, [], *month_period("2026-09"), now=NOW, period="2026-09"
    )
    assert save_report(tmp_path, report) == "soc2-2026-09.json"
    listed = list_reports(tmp_path)
    assert [(r["name"], r["gaps"]) for r in listed] == [
        ("soc2-2026-09.json", len(framework.controls))
    ]
    assert load_report(tmp_path, "soc2-2026-09.json")["period"]["label"] == "2026-09"
    assert load_report(tmp_path, "../../etc/passwd") is None

    linked = tmp_path / "linked"
    (linked / ".workpilot").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (linked / ".workpilot" / "compliance").symlink_to(outside)
    with pytest.raises(OSError):
        save_report(linked, report)
    assert list(outside.iterdir()) == []


def test_the_monthly_run_makes_last_month_once(tmp_path: Path):
    assert run_monthly(tmp_path) == []  # not chosen
    with pytest.raises(ValueError):
        save_config(tmp_path, {"frameworks": ["nope"], "monthly": True})
    assert save_config(
        tmp_path, {"frameworks": ["soc2", "iso27001", "x"], "monthly": True}
    ) == {
        "frameworks": ["soc2", "iso27001"],
        "monthly": True,
    }
    assert load_config(tmp_path)["monthly"] is True
    first_of_december = calendar.timegm((2026, 12, 1, 12, 0, 0))
    made = run_monthly(tmp_path, now=first_of_december)
    assert sorted(m["name"] for m in made) == [
        "iso27001-2026-11.json",
        "soc2-2026-11.json",
    ]
    assert made[0]["report"]["period"]["end"].startswith("2026-11-30T23:59:59")
    assert run_monthly(tmp_path, now=first_of_december + DAY) == []


def test_the_runner(tmp_path: Path, capsys, monkeypatch):
    sys.path.insert(
        0, str(Path(__file__).resolve().parents[2] / "apps" / "backend" / "runners")
    )
    import compliance_runner

    def run(*args):
        monkeypatch.setattr(
            "sys.argv", ["compliance_runner.py", "--project-path", str(tmp_path), *args]
        )
        try:
            compliance_runner.main()
        except SystemExit as exc:
            assert exc.code == 1
        out = capsys.readouterr().out.splitlines()
        result = [x for x in out if x.startswith("COMPLIANCE_RESULT:")]
        if result:
            return json.loads(result[0].removeprefix("COMPLIANCE_RESULT:"))
        return next(x for x in out if x.startswith("COMPLIANCE_ERROR:"))

    listed = run("--frameworks")
    assert {f["id"] for f in listed["frameworks"]} >= {"soc2", "pci_dss"}
    report = run("--framework", "hipaa", "--save")
    assert report["saved"].startswith("hipaa-") and report["controls"]
    assert run("--list")["reports"][0]["framework"] == "hipaa"
    assert run("--load", "../x.json").startswith("COMPLIANCE_ERROR:")
    assert run("--framework", "nope").startswith("COMPLIANCE_ERROR:")
    config = tmp_path.parent / "config.json"
    config.write_text(
        json.dumps({"frameworks": ["pci_dss"], "monthly": True}), encoding="utf-8"
    )
    assert run("--config", str(config))["config"] == {
        "frameworks": ["pci_dss"],
        "monthly": True,
    }
