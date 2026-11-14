"""The Live Companion analyzer and runner.

The analyzer imported `core.session`, which does not exist: every analysis
failed on import, the error was swallowed and the page never showed a single
suggestion. It now goes through `core.oneshot.oneshot_completion` (any
provider), quotes the changed code as data, and reports a provider failure
instead of passing it for "nothing to say".
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

import core.oneshot
import pytest
from live_companion.analyzer import AnalysisError, IncrementalAnalyzer, detect_language
from live_companion.types import FileChangeEvent
from runners import live_companion_runner as runner


def _fake_oneshot(monkeypatch, answer: str = "[]", error: dict | None = None):
    calls: list[dict] = []

    async def fake(prompt, system_prompt=None, **kwargs):
        calls.append({"prompt": prompt, "system_prompt": system_prompt, **kwargs})
        if error is not None:
            kwargs["on_error"](error)
            return ""
        return answer

    monkeypatch.setattr(core.oneshot, "oneshot_completion", fake)
    return calls


def _modified(
    diff: str = "+const a = b.c;\n", path: str = "src/app.ts"
) -> FileChangeEvent:
    return FileChangeEvent(file_path=path, change_type="modified", diff=diff)


def test_the_analysis_goes_through_the_provider_agnostic_oneshot(monkeypatch, tmp_path):
    calls = _fake_oneshot(monkeypatch)
    analyzer = IncrementalAnalyzer(tmp_path)

    assert asyncio.run(analyzer.analyze_change(_modified())) == []

    assert len(calls) == 1
    # No Claude alias forced on the selected provider: its default model.
    assert calls[0]["model"] is None
    assert calls[0]["project_dir"] == str(tmp_path)
    assert calls[0]["max_turns"] == 1


def test_a_provider_failure_raises_with_its_detail(monkeypatch, tmp_path):
    _fake_oneshot(
        monkeypatch,
        error={
            "message": "invalid api key",
            "code": "auth_failed",
            "provider": "mistral",
        },
    )
    analyzer = IncrementalAnalyzer(tmp_path)

    with pytest.raises(AnalysisError) as raised:
        asyncio.run(analyzer.analyze_change(_modified()))

    assert raised.value.detail["code"] == "auth_failed"
    assert raised.value.detail["provider"] == "mistral"


def test_an_empty_answer_is_a_failure_not_an_empty_list(monkeypatch, tmp_path):
    _fake_oneshot(monkeypatch, answer="  ")
    with pytest.raises(AnalysisError) as raised:
        asyncio.run(IncrementalAnalyzer(tmp_path).analyze_change(_modified()))
    assert raised.value.detail["code"] == "empty_response"


def test_nothing_to_read_means_no_call(monkeypatch, tmp_path):
    calls = _fake_oneshot(monkeypatch)
    analyzer = IncrementalAnalyzer(tmp_path)

    deleted = FileChangeEvent(file_path="a.py", change_type="deleted", diff="")
    empty = FileChangeEvent(file_path="a.py", change_type="created", diff="  ")
    assert asyncio.run(analyzer.analyze_change(deleted)) == []
    assert asyncio.run(analyzer.analyze_change(empty)) == []
    assert calls == []


def test_the_changed_code_enters_the_prompt_quoted_and_in_the_app_language(
    monkeypatch, tmp_path
):
    calls = _fake_oneshot(monkeypatch)
    analyzer = IncrementalAnalyzer(tmp_path, language="fr")
    created = FileChangeEvent(
        file_path="lib/main.dart",
        change_type="created",
        diff="void main() { print('hi'); }",
    )

    asyncio.run(analyzer.analyze_change(created))

    prompt = calls[0]["prompt"]
    assert "Language: Dart" in prompt
    assert "start of the file" in prompt
    assert "in French" in prompt
    # quote_untrusted fences the content as data.
    assert "void main()" in prompt
    assert prompt.count("void main()") == 1


def test_suggestions_are_filtered_capped_and_tolerate_invented_values(
    monkeypatch, tmp_path
):
    answer = json.dumps(
        [
            {"title": "low", "confidence": 0.3},
            {
                "title": "a",
                "confidence": 0.9,
                "suggestion_type": "made_up",
                "priority": "urgent",
            },
            {"title": "b", "confidence": 0.8, "suggestion_type": "security_issue"},
            {"title": "c", "confidence": 0.7},
            {"title": "", "confidence": 0.99},
            "not an object",
        ]
    )
    _fake_oneshot(monkeypatch, answer=f"Here you go:\n```json\n{answer}\n```")
    analyzer = IncrementalAnalyzer(tmp_path, min_confidence=0.5, max_per_file=2)

    found = asyncio.run(analyzer.analyze_change(_modified()))

    assert [s.title for s in found] == ["a", "b"]
    assert found[0].suggestion_type.value == "general"
    assert found[0].priority.value == "medium"
    assert found[1].suggestion_type.value == "security_issue"
    assert all(s.file_path == "src/app.ts" for s in found)


@pytest.mark.parametrize(
    ("path", "language"),
    [
        ("Pages/Index.razor", "Razor (Blazor)"),
        ("Program.cs", "C#"),
        ("app/src/Main.kt", "Kotlin"),
        ("ios/App.swift", "Swift"),
        ("lib/main.dart", "Dart"),
        ("src/lib.rs", "Rust"),
        ("main.go", "Go"),
        ("index.php", "PHP"),
        ("app.component.html", "HTML"),
        ("README", "Unknown"),
    ],
)
def test_every_stack_gets_its_language(path, language):
    assert detect_language(path) == language


def test_a_change_without_kind_reads_as_a_diff_only_when_modified():
    assert FileChangeEvent(file_path="a", change_type="modified").content_kind == "diff"
    assert FileChangeEvent(file_path="a", change_type="created").content_kind == "file"
    explicit = FileChangeEvent.from_dict(
        {"file_path": "a", "change_type": "modified", "content_kind": "file"}
    )
    assert explicit.content_kind == "file"


# ── Runner ──────────────────────────────────────────────────────────


def _args(tmp_path: Path, changes: list[dict]) -> argparse.Namespace:
    changes_file = tmp_path / "changes.json"
    changes_file.write_text(json.dumps({"changes": changes}), encoding="utf-8")
    return runner.build_parser().parse_args(
        [
            "analyze-batch",
            "--project-dir",
            str(tmp_path),
            "--changes-file",
            str(changes_file),
            "--language",
            "fr",
            "--min-confidence",
            "0.6",
        ]
    )


def _events(capsys) -> list[dict]:
    out = capsys.readouterr().out
    prefix = "LIVE_COMPANION_EVENT:"
    return [
        json.loads(line[len(prefix) :])
        for line in out.splitlines()
        if line.startswith(prefix)
    ]


def test_the_batch_reads_the_last_change_of_each_file_and_skips_deletions(
    monkeypatch, tmp_path, capsys
):
    calls = _fake_oneshot(
        monkeypatch, answer=json.dumps([{"title": "check null", "confidence": 0.9}])
    )
    args = _args(
        tmp_path,
        [
            {"file_path": "a.ts", "change_type": "modified", "diff": "+first"},
            {"file_path": "b.py", "change_type": "deleted", "diff": ""},
            {"file_path": "a.ts", "change_type": "modified", "diff": "+second"},
        ],
    )

    assert asyncio.run(runner.run_batch(args)) == 0

    assert len(calls) == 1
    assert "+second" in calls[0]["prompt"]
    assert "+first" not in calls[0]["prompt"]
    [event] = _events(capsys)
    assert event["type"] == "complete"
    assert event["data"]["files_analyzed"] == 1
    assert event["data"]["suggestions"][0]["title"] == "check null"


def test_the_batch_reports_the_provider_error_when_nothing_was_analyzed(
    monkeypatch, tmp_path, capsys
):
    _fake_oneshot(monkeypatch, error={"message": "rate limited", "code": "rate_limit"})
    args = _args(
        tmp_path, [{"file_path": "a.ts", "change_type": "modified", "diff": "+x"}]
    )

    assert asyncio.run(runner.run_batch(args)) == 1

    [event] = _events(capsys)
    assert event["type"] == "error"
    assert event["data"]["code"] == "rate_limit"
    assert event["data"]["file_path"] == "a.ts"


def test_an_empty_batch_completes_without_a_call(monkeypatch, tmp_path, capsys):
    calls = _fake_oneshot(monkeypatch)
    args = _args(tmp_path, [{"file_path": "gone.ts", "change_type": "deleted"}])

    assert asyncio.run(runner.run_batch(args)) == 0

    assert calls == []
    [event] = _events(capsys)
    assert event == {
        "type": "complete",
        "data": {
            "suggestions": [],
            "files_analyzed": 0,
            "errors": [],
            "files_skipped": 1,
        },
    }


def test_a_missing_changes_file_is_an_error_event(tmp_path, capsys):
    args = runner.build_parser().parse_args(
        [
            "analyze-batch",
            "--project-dir",
            str(tmp_path),
            "--changes-file",
            str(tmp_path / "x.json"),
        ]
    )
    assert asyncio.run(runner.run_batch(args)) == 1
    [event] = _events(capsys)
    assert event["data"]["code"] == "changes_missing"
