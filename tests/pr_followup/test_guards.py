"""A fix may not turn the CI green by not running the test."""

from __future__ import annotations

import pytest
from pr_followup.guards import check_fix_diff


def _diff(path: str, *added: str) -> str:
    body = "\n".join(f"+{line}" for line in added)
    return f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1 +1 @@\n{body}\n"


@pytest.mark.parametrize(
    ("path", "line"),
    [
        ("tests/test_app.py", "@pytest.mark.skip(reason='flaky')"),
        ("tests/test_app.py", "    pytest.skip('later')"),
        ("tests/test_app.py", "@unittest.skip('x')"),
        ("src/app.test.ts", "it.skip('renders', () => {})"),
        ("src/app.test.ts", "describe.only('suite', () => {})"),
        ("src/app.spec.ts", "xit('renders', () => {})"),
        ("Tests/OrderTests.cs", '[Fact(Skip = "broken on CI")]'),
        ("Tests/OrderTests.cs", "[Ignore]"),
        ("src/test/java/AppTest.java", "@Disabled"),
        ("pkg/app_test.go", '\tt.Skip("later")'),
        ("src/lib.rs", "#[ignore]"),
    ],
)
def test_switching_a_test_off_is_refused(path: str, line: str) -> None:
    violations = check_fix_diff(f"M\t{path}", _diff(path, line))
    assert violations, line
    assert violations[0].path == path


def test_deleting_a_test_file_is_refused() -> None:
    violations = check_fix_diff("D\ttests/test_orders.py", "")
    assert [v.rule for v in violations] == ["test file deleted"]


def test_renaming_a_test_out_of_the_suite_is_refused() -> None:
    violations = check_fix_diff("R100\ttests/test_orders.py\tdocs/orders.py", "")
    assert violations and "renamed out" in violations[0].rule


@pytest.mark.parametrize(
    "path",
    [
        ".github/workflows/ci.yml",
        ".gitlab-ci.yml",
        "azure-pipelines.yml",
        "Jenkinsfile",
    ],
)
def test_editing_the_pipeline_is_refused(path: str) -> None:
    assert check_fix_diff(f"M\t{path}", "")


def test_an_ordinary_fix_passes() -> None:
    diff = _diff("src/orders.py", "    return total * (1 - discount)")
    diff += _diff(
        "tests/test_orders.py",
        "def test_discount_applies():",
        "    assert total(10, 0.5) == 5",
    )
    assert check_fix_diff("M\tsrc/orders.py\nM\ttests/test_orders.py", diff) == []


def test_removing_a_skip_is_welcome() -> None:
    diff = "--- a/tests/test_x.py\n+++ b/tests/test_x.py\n@@ -1 +0,0 @@\n-@pytest.mark.skip\n"
    assert check_fix_diff("M\ttests/test_x.py", diff) == []


def test_words_that_only_look_like_a_skip_pass() -> None:
    diff = _diff("src/util.ts", "const fixit = (x) => max(x, 1)", "maxit(3)")
    assert check_fix_diff("M\tsrc/util.ts", diff) == []
