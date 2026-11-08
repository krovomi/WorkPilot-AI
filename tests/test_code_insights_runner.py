"""runners/code_insights_runner.py and review/polyglot_rules.py: Code review
and Refactoring of the desktop app, for every stack."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from review.ai_code_review import AICodeReviewer, _detect_language
from runners import code_insights_runner as runner

RUNNER = Path(runner.__file__)


def _rules(path: str, content: str) -> set[str]:
    result = AICodeReviewer().review_file_content(content, file_path=path)
    return {c.rule_id for c in result.comments}


@pytest.mark.parametrize(
    ("path", "content", "expected"),
    [
        ("A.cs", "public async void Load() { }", {"BUG008"}),
        ("A.cs", "var r = task.Result;", {"BUG009"}),
        ("A.cs", "try { x(); } catch (Exception) { }", {"ERR003"}),
        ("A.cs", 'Console.WriteLine("x");', {"BUG011"}),
        ("A.java", "System.out.println(x);", {"BUG012"}),
        ("A.java", "try { a(); } catch (IOException e) {}", {"ERR003"}),
        ("a.kt", "val n = name!!.length", {"BUG007"}),
        ("a.go", 'fmt.Println("x")', {"BUG014"}),
        ("a.rs", "let v = opt.unwrap();", {"BUG005"}),
        ("a.rs", 'println!("{}", v);', {"BUG015"}),
        ("a.swift", "let x = try! load()", {"BUG006"}),
        ("a.php", "var_dump($x);", {"BUG016"}),
        ("a.rb", "binding.pry", {"BUG017"}),
        ("a.cpp", "strcpy(a, b);", {"SEC009"}),
        ("A.cs", 'var q = "SELECT a FROM t WHERE id=" + id;', {"SEC005"}),
        ("a.php", '$q = "DELETE FROM t WHERE id=" . $id;', {"SEC005"}),
    ],
)
def test_review_rules_reach_every_stack(path, content, expected):
    assert expected <= _rules(path, content)


def test_stack_rules_stay_in_their_language():
    assert "BUG009" not in _rules("a.py", "value = response.Result")
    assert "BUG005" not in _rules("a.ts", "const v = opt.unwrap();")
    assert "BUG007" not in _rules("a.ts", "const a = b!!")


def test_detect_language_reads_the_last_extension():
    assert _detect_language("build.gradle.kts") == "kotlin"
    assert _detect_language("src/App.Tests/Order.cs") == "csharp"
    assert _detect_language("lib/main.dart") == "dart"
    assert _detect_language("Makefile") == ""


def test_smells_are_shaped_for_the_view_and_guess_the_language():
    result = runner.handle(
        {
            "action": "smells",
            "text": "package shop\n\nfunc F() int {\n\treturn 7 * 6\n}\n",
        }
    )
    assert result["language"] == "go"
    smell = result["smells"][0]
    assert set(smell) == {
        "smell_type",
        "severity",
        "message",
        "line",
        "symbol",
        "metric_value",
        "threshold",
    }
    assert any(s["symbol"] == "F" for s in result["smells"])


def test_proposals_are_shaped_for_the_view():
    source = "def f(a, b, c, d, e, f):\n    return 1\n"
    result = runner.handle({"action": "propose", "text": source, "language": "python"})
    assert result["language"] == "python"
    assert result["proposals"]
    assert set(result["proposals"][0]) == {
        "pattern",
        "description",
        "risk_level",
        "symbol",
        "impact",
    }


def test_review_keeps_the_desktop_contract():
    diff = (
        "diff --git a/x.cs b/x.cs\n--- a/x.cs\n+++ b/x.cs\n@@ -0,0 +1,1 @@\n"
        "+public async void Go() { }\n"
    )
    report = runner.handle({"action": "review", "text": diff})
    assert report["passed"] is False
    assert report["issues"][0]["file"] == "x.cs"
    assert report["issues"][0]["severity"] == "high"


@pytest.mark.parametrize(
    "request_",
    [
        {"action": "rm"},
        {"action": "smells"},
        {"action": "smells", "text": "   "},
        {"action": "review", "text": "a" * (2 * 1024 * 1024 + 1)},
    ],
)
def test_bad_requests_are_refused(request_):
    with pytest.raises(ValueError):
        runner.handle(request_)


def test_unknown_language_falls_back_to_a_guess():
    result = runner.handle(
        {
            "action": "smells",
            "text": "<?php\nfunction f($a) { return 99; }\n",
            "language": "cobol",
        }
    )
    assert result["language"] == "php"


def _run(payload: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 - fixed interpreter and runner path
        [sys.executable, str(RUNNER)],
        input=payload,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def test_runner_reads_stdin_and_prints_one_result_line():
    done = _run(json.dumps({"action": "languages"}))
    assert done.returncode == 0
    line = next(
        line
        for line in done.stdout.splitlines()
        if line.startswith("CODE_INSIGHTS_RESULT:")
    )
    languages = json.loads(line.split(":", 1)[1])["languages"]
    assert any(lang["id"] == "csharp" for lang in languages)


def test_runner_refuses_an_option_shaped_language():
    done = _run(json.dumps({"action": "smells", "text": "x", "language": "--help"}))
    assert done.returncode == 1
    assert "CODE_INSIGHTS_ERROR:Invalid language id" in done.stdout
