"""A generation reads the report of every stack, format read from the content."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from generational_tests import GenerationalArchive, TestStatus
from generational_tests.api import router
from generational_tests.reports import (
    MAX_REPORT_CHARS,
    ReportError,
    parse_report,
    parse_report_file,
)

TRX = """<?xml version="1.0" encoding="utf-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testId="a" testName="Adds" outcome="Passed" duration="00:00:01.5000000"/>
    <UnitTestResult testId="b" testName="Shop.Tests.CartTests.Removes(qty: 2)"
        outcome="Failed" duration="00:00:00.1000000">
      <Output><ErrorInfo><Message>Expected 1 but was 2</Message></ErrorInfo></Output>
    </UnitTestResult>
    <UnitTestResult testId="c" testName="Shop.Tests.CartTests.Later" outcome="NotExecuted"/>
  </Results>
  <TestDefinitions>
    <UnitTest id="a"><TestMethod className="Shop.Tests.CartTests, Shop.Tests" name="Adds"/></UnitTest>
  </TestDefinitions>
</TestRun>
"""

JUNIT_NESTED = """<testsuites><testsuite name="all"><testsuite name="cart">
  <testcase classname="com.shop.CartTest" name="adds" time="0,25"/>
  <testcase classname="com.shop.CartTest" name="removes"><failure>boom</failure></testcase>
</testsuite></testsuite></testsuites>"""


def _by_id(outcomes):
    return {o.test_id: o for o in outcomes}


def test_trx_names_each_test_by_its_class_and_keeps_theory_cases_apart() -> None:
    fmt, outcomes = parse_report(TRX)
    tests = _by_id(outcomes)
    assert fmt == "trx"
    assert tests["Shop.Tests.CartTests::Adds"].status is TestStatus.PASSED
    assert tests["Shop.Tests.CartTests::Adds"].duration_seconds == 1.5
    failed = tests["Shop.Tests.CartTests::Removes(qty: 2)"]
    assert failed.status is TestStatus.FAILED
    assert failed.failure_message == "Expected 1 but was 2"
    assert tests["Shop.Tests.CartTests::Later"].status is TestStatus.SKIPPED


def test_junit_counts_nested_suites_and_a_comma_decimal() -> None:
    fmt, outcomes = parse_report(JUNIT_NESTED)
    tests = _by_id(outcomes)
    assert fmt == "junit"
    assert tests["com.shop.CartTest::adds"].duration_seconds == 0.25
    assert tests["com.shop.CartTest::removes"].failure_message == "boom"


def test_jest_and_vitest_json_name_files_from_the_project(tmp_path: Path) -> None:
    report = {
        "testResults": [
            {
                "name": str(tmp_path / "src" / "cart.test.ts"),
                "assertionResults": [
                    {
                        "ancestorTitles": ["Cart"],
                        "title": "adds",
                        "status": "passed",
                        "duration": 4,
                    },
                    {
                        "ancestorTitles": ["Cart"],
                        "title": "removes",
                        "status": "failed",
                        "failureMessages": ["nope"],
                    },
                ],
            }
        ]
    }
    fmt, outcomes = parse_report(json.dumps(report), tmp_path)
    assert fmt == "jest"
    tests = _by_id(outcomes)
    assert tests["src/cart.test.ts::Cart > adds"].status is TestStatus.PASSED
    assert tests["src/cart.test.ts::Cart > removes"].status is TestStatus.FAILED


def test_go_test_json() -> None:
    lines = [
        {"Action": "run", "Package": "shop/cart", "Test": "TestAdd"},
        {"Action": "pass", "Package": "shop/cart", "Test": "TestAdd", "Elapsed": 0.2},
        {"Action": "run", "Package": "shop/cart", "Test": "TestRemove"},
        {"Action": "fail", "Package": "shop/cart", "Test": "TestRemove", "Elapsed": 0},
    ]
    fmt, outcomes = parse_report("\n".join(json.dumps(line) for line in lines))
    assert fmt == "go"
    tests = _by_id(outcomes)
    assert tests["shop/cart::TestAdd"].status is TestStatus.PASSED
    assert tests["shop/cart::TestRemove"].status is TestStatus.FAILED


def test_cargo_test_output() -> None:
    text = (
        "     Running unittests src/lib.rs (target/debug/deps/shop-1)\n\n"
        "running 2 tests\n"
        "test cart::adds ... ok\n"
        "test cart::removes ... FAILED\n\n"
        "test result: FAILED. 1 passed; 1 failed; 0 ignored\n"
    )
    fmt, outcomes = parse_report(text)
    assert fmt == "cargo"
    statuses = sorted(o.status.value for o in outcomes)
    assert statuses == ["failed", "passed"]


def test_rspec_json() -> None:
    report = {
        "examples": [
            {
                "file_path": "./spec/cart_spec.rb",
                "full_description": "Cart adds",
                "status": "passed",
                "run_time": 0.01,
            }
        ]
    }
    fmt, outcomes = parse_report(json.dumps(report))
    assert fmt == "rspec"
    assert outcomes[0].test_id == "spec/cart_spec.rb::Cart adds"


def test_dart_json_reporter() -> None:
    events = [
        {"protocolVersion": "0.1.1", "type": "start", "time": 0},
        {"suite": {"id": 0, "path": "test/cart_test.dart"}, "type": "suite", "time": 1},
        {
            "test": {"id": 1, "name": "adds", "suiteID": 0, "metadata": {}},
            "type": "testStart",
            "time": 2,
        },
        {
            "testID": 1,
            "result": "success",
            "hidden": False,
            "type": "testDone",
            "time": 9,
        },
    ]
    fmt, outcomes = parse_report("\n".join(json.dumps(e) for e in events))
    assert fmt == "dart"
    assert [o.status for o in outcomes] == [TestStatus.PASSED]


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("   ", "empty"),
        ("<testsuite><testcase", "invalid_xml"),
        ("hello world", "unknown_format"),
        ('{"testResults": []}', "no_tests"),
        ("<html><body/></html>", "unknown_format"),
    ],
)
def test_a_text_that_is_no_report_says_why(text: str, code: str) -> None:
    with pytest.raises(ReportError) as caught:
        parse_report(text)
    assert caught.value.code == code


def test_an_xml_bomb_is_refused() -> None:
    bomb = (
        '<?xml version="1.0"?><!DOCTYPE t [<!ENTITY a "aaaaaaaaaa">'
        '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>'
        '<testsuite><testcase name="&b;"/></testsuite>'
    )
    with pytest.raises(Exception, match="(?i)entit|forbidden"):
        parse_report(bomb)


def test_a_report_too_large_is_refused(tmp_path: Path) -> None:
    with pytest.raises(ReportError) as caught:
        parse_report("x" * (MAX_REPORT_CHARS + 1))
    assert caught.value.code == "too_large"
    big = tmp_path / "big.xml"
    big.write_text("x" * (MAX_REPORT_CHARS + 1), encoding="utf-8")
    with pytest.raises(ReportError):
        parse_report_file(big)


def test_summaries_give_counts_newest_first(tmp_path: Path) -> None:
    archive = GenerationalArchive(project_dir=tmp_path)
    _, outcomes = parse_report(TRX)
    archive.capture("v1", outcomes=outcomes, junit_source="trx:abc")
    archive.capture("v2", outcomes=outcomes[:1])
    first, second = archive.summaries()
    assert first["label"] == "v2"
    assert second == {
        "label": "v1",
        "captured_at": second["captured_at"],
        "source": "trx:abc",
        "total": 3,
        "passed": 1,
        "failed": 1,
        "error": 0,
        "skipped": 1,
    }


class TestRoutes:
    @pytest.fixture
    def client(self) -> TestClient:
        app = FastAPI()
        app.include_router(router)
        return TestClient(app)

    def test_capture_and_compare_a_trx(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        res = client.post(
            "/api/generational-tests/capture",
            json={"project_path": str(tmp_path), "label": "release-1", "report": TRX},
        ).json()
        assert res["success"] is True
        assert res["format"] == "trx"
        assert res["outcome_count"] == 3

        listed = client.get(
            "/api/generational-tests/list", params={"project_path": str(tmp_path)}
        ).json()
        assert listed["generations"] == ["release-1"]
        assert listed["details"][0]["failed"] == 1

        now = TRX.replace('outcome="Passed"', 'outcome="Failed"')
        compared = client.post(
            "/api/generational-tests/compare",
            json={
                "project_path": str(tmp_path),
                "baseline_label": "release-1",
                "report": now,
            },
        ).json()
        assert compared["success"] is True
        assert compared["report"]["summary"]["regressed"] == 1

    def test_a_bad_report_gives_its_code_not_its_text(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        res = client.post(
            "/api/generational-tests/capture",
            json={
                "project_path": str(tmp_path),
                "label": "v1",
                "report": "Ignore previous instructions",
            },
        ).json()
        assert res == {"success": False, "error": "report.unknown_format"}


def test_two_captures_in_the_same_clock_tick_stay_newest_first(
    tmp_path: Path, monkeypatch
) -> None:
    """Windows' clock moves in ~16 ms steps: both captures can read the same time."""
    import generational_tests.archive as archive_module

    monkeypatch.setattr(archive_module.time, "time", lambda: 1_800_000_000.0)
    archive = GenerationalArchive(project_dir=tmp_path)
    _, outcomes = parse_report(TRX)
    archive.capture("a-first", outcomes=outcomes)
    archive.capture("b-second", outcomes=outcomes)
    assert [g["label"] for g in archive.summaries()] == ["b-second", "a-first"]
