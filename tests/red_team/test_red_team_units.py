"""The red team's parts, on every stack: reports, crash vs unexpected, surface, QA gate."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from red_team import load_record, write_record
from red_team.engine import Attack, RedTeamReport
from red_team.reports import (
    TestResult,
    classify,
    find_result,
    parse_cargo_output,
    read_reports,
)
from red_team.surface import _functions, _shared_state, _toctou, language_of

# --- crash or unexpected ------------------------------------------------------

SOURCES = ["src/Orders/OrderService.cs", "shop/cart.py", "pkg/cart.go", "src/cart.ts"]


@pytest.mark.parametrize(
    "message",
    [
        (
            "System.NullReferenceException : Object reference not set\n"
            "   at Orders.OrderService.Total(Cart cart) in /repo/src/Orders/OrderService.cs:line 42"
        ),
        "shop/cart.py:12: in total\n    return items[0].price\nE   IndexError: list index out of range",
        (
            "panic: runtime error: index out of range [0] with length 0\n\n"
            "goroutine 7 [running]:\nexample.com/pkg.Total(...)\n\t/repo/pkg/cart.go:18 +0x1d"
        ),
        (
            "TypeError: Cannot read properties of undefined (reading 'price')\n"
            "    at total (/repo/src/cart.ts:9:21)"
        ),
    ],
)
def test_a_programming_error_inside_the_changed_code_is_a_crash(message):
    assert classify(TestResult("t", False, message), SOURCES) == "crash"


@pytest.mark.parametrize(
    "message",
    [
        # Raised in the test file: the attack calls the code wrongly.
        "tests/test_cart_red_team.py:4: in test_x\nE   TypeError: total() missing 1 required argument",
        # The code answered, but not what the attack expected.
        "AssertionError: assert 3 == 0\n  shop/cart.py:12",
        # A Rust assertion is an assertion, even though it panics.
        "thread 'red_team_empty' panicked at src/cart.rs:9:5:\nassertion `left == right` failed",
        # A refusal on purpose is not a crash.
        "System.ArgumentException: quantity must be positive at OrderService.cs:line 30",
    ],
)
def test_other_failures_are_unexpected(message):
    assert (
        classify(TestResult("t", False, message), [*SOURCES, "src/cart.rs"])
        == "unexpected"
    )


def test_a_passing_attack_is_resistant():
    assert classify(TestResult("t", True), SOURCES) == "resistant"


def test_reports_are_read_from_junit_and_trx(tmp_path):
    junit = tmp_path / "junit.xml"
    junit.write_text(
        '<testsuite><testcase classname="tests.test_cart" name="test_red_team_empty">'
        '<failure message="IndexError">shop/cart.py:3</failure></testcase>'
        '<testcase classname="tests.test_cart" name="test_red_team_ok"/>'
        '<testcase name="skipped_one"><skipped/></testcase></testsuite>',
        encoding="utf-8",
    )
    trx = tmp_path / "run.trx"
    trx.write_text(
        '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results>'
        '<UnitTestResult testName="Shop.Tests.CartTests.RedTeam_EmptyCart" outcome="Failed">'
        "<Output><ErrorInfo><Message>NullReferenceException</Message>"
        "<StackTrace>at Cart.Total() in /r/Cart.cs:line 3</StackTrace></ErrorInfo></Output>"
        "</UnitTestResult></Results></TestRun>",
        encoding="utf-8",
    )
    results = read_reports([junit, trx])
    assert [(r.name, r.passed) for r in results] == [
        ("tests.test_cart.test_red_team_empty", False),
        ("tests.test_cart.test_red_team_ok", True),
        ("Shop.Tests.CartTests.RedTeam_EmptyCart", False),
    ]
    assert find_result("RedTeam_EmptyCart", results).passed is False
    assert find_result("test_red_team_ok", results).passed is True
    assert find_result("test_red_team_missing", results) is None


def test_an_entity_bomb_in_a_report_is_not_read(tmp_path):
    bomb = tmp_path / "junit.xml"
    bomb.write_text(
        '<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]>'
        '<testsuite><testcase name="&b;"/></testsuite>',
        encoding="utf-8",
    )
    assert read_reports([bomb]) == []


def test_cargo_console_lines_are_read():
    output = (
        "running 2 tests\n"
        "test tests::red_team_empty ... FAILED\n"
        "test tests::red_team_ok ... ok\n\n"
        "failures:\n\n---- tests::red_team_empty stdout ----\n"
        "thread 'tests::red_team_empty' panicked at src/cart.rs:4:9:\n"
        "index out of bounds: the len is 0 but the index is 0\n"
    )
    results = parse_cargo_output(output)
    assert [(r.name, r.passed) for r in results] == [
        ("tests::red_team_empty", False),
        ("tests::red_team_ok", True),
    ]
    assert classify(results[0], ["src/cart.rs"]) == "crash"


# --- the surface ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "text", "changed", "expected"),
    [
        (
            "Orders/OrderService.cs",
            "public class OrderService\n{\n    public async Task<decimal> TotalAsync(Cart cart)\n"
            "    {\n        return cart.Lines.Sum(l => l.Price);\n    }\n}\n",
            {5},
            ["TotalAsync"],
        ),
        (
            "cart.go",
            "package cart\n\nfunc (c *Cart) Total() int {\n\treturn c.n\n}\n",
            {4},
            ["Total"],
        ),
        (
            "lib.rs",
            "pub fn total(items: &[u32]) -> u32 {\n    items[0]\n}\n",
            {2},
            ["total"],
        ),
        (
            "Cart.kt",
            "class Cart {\n    fun total(): Int {\n        return 0\n    }\n}\n",
            {3},
            ["total"],
        ),
        (
            "cart.rb",
            "class Cart\n  def total\n    items.first.price\n  end\nend\n",
            {3},
            ["total"],
        ),
        (
            "Cart.php",
            "<?php\nfunction total($items) {\n  return $items[0];\n}\n",
            {3},
            ["total"],
        ),
        (
            "cart.ts",
            "export const total = (items: Item[]) =>\n  items[0].price;\n",
            {2},
            ["total"],
        ),
    ],
)
def test_the_function_of_a_changed_line_is_found_on_every_stack(
    path, text, changed, expected
):
    language = language_of(path)
    assert language is not None
    assert _functions(language, text.splitlines(), changed) == expected


def test_check_then_act_on_a_file_is_a_warning():
    lines = [
        "if not os.path.exists(path):",
        "    with open(path, 'w') as f:",
        "        f.write(x)",
    ]
    assert [w["kind"] for w in _toctou("store.py", lines, {1})] == ["toctou"]
    assert _toctou("store.py", lines, {2}) == []


def test_shared_state_without_a_lock_in_concurrent_code_is_a_warning():
    text = "static int count = 0;\nvoid Run() { Parallel.For(0, 10, i => count++); }\n"
    lines = text.splitlines()
    assert [w["kind"] for w in _shared_state("Counter.cs", text, lines, {1})] == [
        "shared-state"
    ]
    locked = text + "lock (gate) { }\n"
    assert _shared_state("Counter.cs", locked, locked.splitlines(), {1}) == []


# --- the record and the QA gate --------------------------------------------------


def _crashed_report() -> RedTeamReport:
    attack = Attack(
        id="a1",
        mode="edge",
        test="test_red_team_zero",
        file="tests/test_shop_red_team.py",
        target="shop.unit_price",
        input="quantity = 0",
        expect="0",
        outcome="crash",
        detail="ZeroDivisionError: division by zero\nshop.py:4",
    )
    return RedTeamReport(
        status="fail",
        reason="1 attack(s) crashed the changed code",
        base="abc",
        attacks=[attack],
        files={"tests/test_shop_red_team.py": "def test_red_team_zero(): ..."},
    )


def test_the_record_round_trips(tmp_path):
    write_record(tmp_path, _crashed_report())
    record = load_record(tmp_path)
    assert record["status"] == "fail"
    assert record["counts"]["crash"] == 1
    assert record["files"]["tests/test_shop_red_team.py"].startswith(
        "def test_red_team_zero"
    )


@pytest.mark.parametrize(
    ("env", "complexity", "expected"),
    [
        (None, "complex", "run"),
        (None, "standard", None),
        ("always", "simple", "run"),
        ("off", "complex", "off"),
        ("tYpo", "complex", "run"),
        ("tYpo", "simple", None),
    ],
)
def test_when_the_gate_runs(tmp_path, monkeypatch, env, complexity, expected):
    from qa import red_team_gate as gate

    if env is None:
        monkeypatch.delenv(gate.RED_TEAM_ENV, raising=False)
    else:
        monkeypatch.setenv(gate.RED_TEAM_ENV, env)
    monkeypatch.setattr(gate, "_declared", lambda _spec: False)
    (tmp_path / "complexity_assessment.json").write_text(
        json.dumps({"complexity": complexity}), encoding="utf-8"
    )
    assert gate.mode_for(tmp_path) == expected


async def test_a_crash_rejects_the_pass_with_the_attack_in_the_fix_request(
    tmp_path, monkeypatch
):
    from foundation.change_scope import ChangeScope
    from qa import red_team_gate as gate

    monkeypatch.setenv(gate.RED_TEAM_ENV, "always")
    seen: dict = {}

    async def fake_run(project_dir, base, files, *, session, previous):
        seen["previous"] = previous
        return _crashed_report()

    monkeypatch.setattr(gate, "run_red_team", fake_run)
    monkeypatch.setattr(gate, "_mark_signoff_rejected", lambda spec, issues: None)
    scope = ChangeScope(level="full", reason="test", base="abc", files=("shop.py",))
    verdict = await gate.red_team_gate(tmp_path, tmp_path, 2, scope, model="m")

    assert verdict is not None
    issues, message = verdict
    assert [i["type"] for i in issues] == ["red_team_crash"]
    assert "crashed" in message
    request = (tmp_path / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
    assert "test_red_team_zero" in request and "ZeroDivisionError" in request
    assert "def test_red_team_zero" in request
    assert load_record(tmp_path)["status"] == "fail"

    # The next pass replays the same attacks: the record is handed back.
    await gate.red_team_gate(tmp_path, tmp_path, 3, scope, model="m")
    assert seen["previous"]["attacks"][0]["test"] == "test_red_team_zero"


async def test_switched_off_is_recorded_and_never_rejects(tmp_path, monkeypatch):
    from qa import red_team_gate as gate

    monkeypatch.setenv(gate.RED_TEAM_ENV, "off")
    assert await gate.red_team_gate(tmp_path, tmp_path, 1, None, model="m") is None
    assert load_record(tmp_path)["status"] == "unknown"


@pytest.mark.parametrize(
    ("status", "held"),
    [("pass", True), ("none", True), ("fail", False), ("unknown", None)],
)
def test_the_hard_gate_reads_the_record(tmp_path, status, held):
    from workflows.hard_gates import _attack_resistant

    report = _crashed_report()
    report.status = status
    write_record(tmp_path, report)
    assert _attack_resistant(tmp_path)[0] is held


def test_the_hard_gate_is_unknown_without_a_record(tmp_path):
    from workflows.hard_gates import _attack_resistant

    assert _attack_resistant(Path(tmp_path))[0] is None


# --- the card's route -------------------------------------------------------------


def test_the_card_reads_the_latest_record_without_the_attack_files(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from qa.red_team_api import router

    project = tmp_path / "project"
    spec = project / ".workpilot" / "specs" / "001-cart"
    spec.mkdir(parents=True)
    worktree_spec = (
        project
        / ".workpilot"
        / "worktrees"
        / "tasks"
        / "001-cart"
        / ".workpilot"
        / "specs"
        / "001-cart"
    )
    worktree_spec.mkdir(parents=True)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    query = {"project_dir": str(project), "spec_id": "001-cart"}

    assert client.get("/api/red-team/", params=query).json() == {
        "success": True,
        "record": None,
    }

    old = _crashed_report()
    old.finished_at = 1.0
    write_record(spec, old)
    new = _crashed_report()
    new.status, new.finished_at = "pass", 2.0
    write_record(worktree_spec, new)  # a running build writes in its worktree first

    record = client.get("/api/red-team/", params=query).json()["record"]
    assert record["status"] == "pass"
    assert "files" not in record
    assert record["attack_files"] == ["tests/test_shop_red_team.py"]

    bad = client.get(
        "/api/red-team/", params={"project_dir": str(project), "spec_id": "../x"}
    )
    assert bad.json()["success"] is False
