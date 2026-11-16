"""Insight extraction after a coding session (analysis/insight_extractor.py).

The git helpers read a real repository; the model session is the agent_runtime
port, replaced by a double that answers like a session would.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import subprocess
import sys
from pathlib import Path

import agent_runtime
import pytest
from analysis import insight_extractor as extractor
from core.runtime import SessionResult, SessionStatus


def _commit(repo: Path, files: dict[str, str], message: str) -> str:
    for name, content in files.items():
        target = repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    subprocess.run(
        ["git", "add", "--", *files], cwd=repo, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "commit", "-q", "-m", message],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


@pytest.fixture
def history(temp_git_repo: Path) -> tuple[Path, str, str]:
    before = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=temp_git_repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    _commit(temp_git_repo, {"src/a.py": "x = 1\n"}, "add a")
    after = _commit(temp_git_repo, {"src/b.py": "# café\n"}, "add b")
    return temp_git_repo, before, after


class _Port:
    """The agent_runtime port as core installs it, with a scripted session."""

    def __init__(
        self,
        token: str | None = "token",
        output: object = None,
        error: Exception | None = None,
    ):
        self.token = token
        self.output = output
        self.error = error
        self.calls: list[dict] = []
        self.prompts: list[str] = []

    def get_auth_token(self) -> str | None:
        return self.token

    def ensure_claude_code_oauth_token(self) -> None:
        return None

    def create_agent_runtime(self, **kwargs):
        self.calls.append(kwargs)
        port = self

        class _Runtime:
            async def run_session(self, prompt: str) -> SessionResult:
                port.prompts.append(prompt)
                if port.error:
                    raise port.error
                return SessionResult(
                    status=SessionStatus.COMPLETED, output=port.output, error=None
                )

        return _Runtime()


@pytest.fixture
def port(monkeypatch: pytest.MonkeyPatch):
    def install(**kwargs) -> _Port:
        p = _Port(**kwargs)
        monkeypatch.setattr(agent_runtime, "_runtime", p)
        monkeypatch.setattr(extractor, "SDK_AVAILABLE", True)
        return p

    return install


# --------------------------------------------------------------------------
# Git helpers
# --------------------------------------------------------------------------


def test_diff_files_and_messages_between_two_commits(history) -> None:
    repo, before, after = history

    diff = extractor.get_session_diff(repo, before, after)

    # Regression: read with the locale codec, a non-ASCII line failed on
    # Windows and the extractor got "(Failed to get diff: ...)".
    assert "+# café" in diff and "+x = 1" in diff
    assert extractor.get_changed_files(repo, before, after) == ["src/a.py", "src/b.py"]
    messages = extractor.get_commit_messages(repo, before, after).splitlines()
    assert [m.split(" ", 1)[1] for m in messages] == ["add b", "add a"]


def test_without_two_distinct_commits_there_is_nothing_to_read(history) -> None:
    repo, before, _ = history

    assert extractor.get_session_diff(repo, None, before) == "(No commits to diff)"
    assert (
        extractor.get_session_diff(repo, before, before) == "(No changes - same commit)"
    )
    assert extractor.get_changed_files(repo, before, before) == []
    assert extractor.get_commit_messages(repo, before, None) == "(No commits)"


def test_a_large_diff_is_truncated(
    temp_git_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = _commit(temp_git_repo, {"big.txt": "a\n"}, "seed")
    after = _commit(temp_git_repo, {"big.txt": "line\n" * 100}, "grow")
    monkeypatch.setattr(extractor, "MAX_DIFF_CHARS", 50)

    diff = extractor.get_session_diff(temp_git_repo, before, after)

    assert len(diff.split("\n\n... (truncated")[0]) == 50
    assert diff.endswith("chars total)")


def test_git_failures_are_reported_not_raised(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    unknown = "0" * 40
    other = "1" * 40
    # Not a repository: git prints to stderr, stdout stays empty.
    assert extractor.get_session_diff(tmp_path, unknown, other) == "(Empty diff)"
    assert extractor.get_commit_messages(tmp_path, unknown, other) == "(No commits)"

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="git", timeout=1)

    monkeypatch.setattr(extractor.subprocess, "run", timeout)
    assert (
        extractor.get_session_diff(tmp_path, unknown, other) == "(Git diff timed out)"
    )

    def missing(*args, **kwargs):
        raise FileNotFoundError("git")

    monkeypatch.setattr(extractor.subprocess, "run", missing)
    assert (
        extractor.get_session_diff(tmp_path, unknown, other)
        == "(Failed to get diff: git)"
    )
    assert extractor.get_changed_files(tmp_path, unknown, other) == []
    assert extractor.get_commit_messages(tmp_path, unknown, other) == "(Failed: git)"


# --------------------------------------------------------------------------
# Inputs
# --------------------------------------------------------------------------


class _Recovery:
    def __init__(self, attempts: list[dict] | None = None, fail: bool = False):
        self.attempts = attempts or []
        self.fail = fail

    def get_subtask_history(self, subtask_id: str) -> dict:
        if self.fail:
            raise KeyError(subtask_id)
        return {"attempts": self.attempts}


def test_inputs_gather_the_plan_the_repository_and_the_attempts(
    history, tmp_path: Path
) -> None:
    repo, before, after = history
    spec = tmp_path / "spec"
    spec.mkdir()
    (spec / "implementation_plan.json").write_text(
        json.dumps(
            {
                "phases": [
                    {"subtasks": [{"id": "s0"}]},
                    {"subtasks": [{"id": "s1", "description": "Add b"}]},
                ]
            }
        ),
        encoding="utf-8",
    )
    attempts = [{"n": i} for i in range(5)]

    inputs = extractor.gather_extraction_inputs(
        spec, repo, "s1", 2, before, after, False, _Recovery(attempts)
    )

    assert inputs["subtask_description"] == "Add b"
    assert inputs["changed_files"] == ["src/a.py", "src/b.py"]
    assert inputs["attempt_history"] == attempts[-3:]
    assert inputs["success"] is False and inputs["session_num"] == 2


@pytest.mark.parametrize(
    "plan",
    [None, "{not json", json.dumps({"phases": [{"subtasks": [{"id": "other"}]}]})],
    ids=["no plan", "unreadable plan", "subtask not in plan"],
)
def test_the_subtask_id_stands_in_for_a_missing_description(
    tmp_path: Path, plan
) -> None:
    if plan is not None:
        (tmp_path / "implementation_plan.json").write_text(plan, encoding="utf-8")

    assert extractor._get_subtask_description(tmp_path, "s9") == "Subtask: s9"


def test_attempt_history_without_or_with_a_broken_recovery_manager() -> None:
    assert extractor._get_attempt_history(None, "s") == []
    assert extractor._get_attempt_history(_Recovery(fail=True), "s") == []


def test_the_prompt_lists_the_session(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    inputs = {
        "subtask_id": "s1",
        "subtask_description": "Add b",
        "session_num": 1,
        "success": False,
        "diff": "+b",
        "changed_files": [],
        "commit_messages": "(No commits)",
        "attempt_history": [
            {"success": True, "approach": "patch"},
            {"error": "boom"},
        ],
    }
    monkeypatch.setattr(extractor, "PROMPT_FILE", tmp_path / "missing.md")

    prompt = extractor._build_extraction_prompt(inputs)

    assert prompt.startswith("Extract structured insights")
    assert "- **Outcome**: FAILED" in prompt
    assert "(No files changed)" in prompt
    assert "**Attempt 1** (SUCCESS): patch" in prompt
    assert "**Attempt 2** (FAILED): Unknown approach\n  Error: boom" in prompt
    assert (
        extractor._format_attempt_history([]) == "(First attempt - no previous history)"
    )


# --------------------------------------------------------------------------
# Enabled, model, session
# --------------------------------------------------------------------------


def test_extraction_needs_the_sdk_a_token_and_the_switch(
    port, monkeypatch: pytest.MonkeyPatch
) -> None:
    port()
    monkeypatch.setenv("INSIGHT_EXTRACTION_ENABLED", "yes")
    assert extractor.is_extraction_enabled() is True
    monkeypatch.setenv("INSIGHT_EXTRACTION_ENABLED", "off")
    assert extractor.is_extraction_enabled() is False

    monkeypatch.delenv("INSIGHT_EXTRACTION_ENABLED")
    port(token=None)
    assert extractor.is_extraction_enabled() is False
    monkeypatch.setattr(agent_runtime, "_runtime", None)
    assert extractor.is_extraction_enabled() is False
    monkeypatch.setattr(extractor, "SDK_AVAILABLE", False)
    assert extractor.is_extraction_enabled() is False


def test_the_model_can_be_overridden(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("INSIGHT_EXTRACTOR_MODEL", raising=False)
    assert extractor.get_extraction_model() == extractor.DEFAULT_EXTRACTION_MODEL
    monkeypatch.setenv("INSIGHT_EXTRACTOR_MODEL", "local-small")
    assert extractor.get_extraction_model() == "local-small"


_INPUTS = {
    "subtask_id": "s1",
    "subtask_description": "d",
    "session_num": 1,
    "success": True,
    "diff": "",
    "changed_files": ["a.py"],
    "commit_messages": "",
    "attempt_history": [],
}


def test_a_fenced_json_answer_is_read(port) -> None:
    p = port(output='Here it is:\n```json\n{"patterns_discovered": ["p"]}\n```\n')

    assert asyncio.run(extractor.run_insight_extraction(dict(_INPUTS))) == {
        "patterns_discovered": ["p"]
    }
    assert p.calls[0]["phase"] == "insight_extraction"


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"output": None}, "returned no output"),
        ({"output": '["a list"]'}, "did not return a JSON object"),
        ({"output": "no json at all"}, ""),
        (
            {"error": RuntimeError("session down")},
            "Insight extraction failed: session down",
        ),
        ({"token": None}, "No authentication token"),
    ],
    ids=["empty", "not an object", "unparsable", "session error", "no token"],
)
def test_a_failed_session_gives_none(port, caplog, kwargs, message) -> None:
    port(**kwargs)

    with caplog.at_level(logging.WARNING, logger=extractor.__name__):
        assert asyncio.run(extractor.run_insight_extraction(dict(_INPUTS))) is None
    assert message in caplog.text


def test_without_the_sdk_no_session_starts(
    port, monkeypatch: pytest.MonkeyPatch
) -> None:
    p = port(output="{}")
    monkeypatch.setattr(extractor, "SDK_AVAILABLE", False)

    assert asyncio.run(extractor.run_insight_extraction(dict(_INPUTS))) is None
    assert p.calls == []


def test_a_parser_crash_stays_inside_the_none_contract(
    port, monkeypatch: pytest.MonkeyPatch
) -> None:
    import foundation.json_document as json_document

    port(output="{}")

    def crash(text: str):
        raise RecursionError("deep")

    monkeypatch.setattr(json_document, "extract_json_document", crash)
    assert asyncio.run(extractor.run_insight_extraction(dict(_INPUTS))) is None


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def _extract(spec: Path, repo: Path, before: str | None, after: str | None) -> dict:
    return asyncio.run(
        extractor.extract_session_insights(
            spec, repo, "s1", 3, before, after, True, None
        )
    )


def test_rich_insights_carry_the_session_metadata(
    port, history, tmp_path: Path
) -> None:
    repo, before, after = history
    p = port(output='{"file_insights": [{"path": "src/b.py"}]}')

    insights = _extract(tmp_path, repo, before, after)

    assert insights == {
        "file_insights": [{"path": "src/b.py"}],
        "subtask_id": "s1",
        "session_num": 3,
        "success": True,
        "changed_files": ["src/a.py", "src/b.py"],
    }
    assert "+# café" in p.prompts[0]


def test_generic_insights_when_extraction_is_off_empty_or_broken(
    port, history, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, before, after = history
    generic = extractor._get_generic_insights("s1", True)
    assert generic["approach_outcome"]["approach_used"] == "Implemented subtask: s1"

    monkeypatch.setattr(agent_runtime, "_runtime", None)
    assert _extract(tmp_path, repo, before, after) == generic

    p = port(output="{}")
    assert _extract(tmp_path, repo, after, after) == generic
    assert p.calls == []

    port(output=None)
    assert _extract(tmp_path, repo, before, after) == generic

    def broken(**kwargs):
        raise OSError("disk")

    port(output="{}")
    monkeypatch.setattr(extractor, "gather_extraction_inputs", broken)
    assert _extract(tmp_path, repo, before, after) == generic


def test_without_the_sdk_installed_extraction_is_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A fresh copy of the module, imported while claude_agent_sdk is missing.
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", None)
    spec = importlib.util.spec_from_file_location("_insight_no_sdk", extractor.__file__)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert module.SDK_AVAILABLE is False
    assert module.ClaudeSDKClient is None
    assert module.is_extraction_enabled() is False
