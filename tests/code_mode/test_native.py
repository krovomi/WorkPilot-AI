"""Claude Code's own code mode, turned on for a Claude SDK session when it can be."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from code_mode import native
from code_mode.native import (
    CLI_VAR,
    MARKER_FILE,
    SCRIPTS_FILE,
    anthropic_api,
    apply,
    make_script_record_hook,
    model_supports,
    task_worktree,
)

ON = {"WORKPILOT_CODE_MODE": "on"}


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("claude-opus-5-5", True),
        ("claude-sonnet-5-5[1m]", True),
        ("claude-opus-5-6", True),
        ("claude-sonnet-6", True),
        ("claude-fable-5-2", True),
        ("us.anthropic.claude-opus-5-5-v1", True),
        ("claude-opus-5", False),
        ("claude-opus-5-20261101", False),
        ("claude-opus-4-8", False),
        ("claude-haiku-5-5", False),
        ("gpt-5", False),
        ("", False),
        (None, False),
    ],
)
def test_only_the_models_the_cli_accepts(model, expected):
    assert model_supports(model) is expected


@pytest.mark.parametrize(
    ("environ", "expected"),
    [
        ({}, True),
        ({"ANTHROPIC_BASE_URL": "https://api.anthropic.com"}, True),
        ({"ANTHROPIC_BASE_URL": "https://api.anthropic.com:443/v1"}, True),
        ({"ANTHROPIC_BASE_URL": "https://gateway.example.com/anthropic"}, False),
        ({"ANTHROPIC_BASE_URL": "http://localhost:4000"}, False),
        ({"CLAUDE_CODE_USE_BEDROCK": "1"}, False),
        ({"CLAUDE_CODE_USE_VERTEX": "true"}, False),
        ({"CLAUDE_CODE_USE_BEDROCK": "0"}, True),
        ({"ANTHROPIC_AUTH_TOKEN": "tok-test-0000"}, False),
        ({"CLAUDE_AGENT_SDK_MCP_NO_PREFIX": "1"}, False),
    ],
)
def test_only_the_anthropic_api_with_its_own_sign_in(environ, expected):
    assert anthropic_api(environ) is expected


def test_only_a_task_worktree(tmp_path: Path):
    worktree = tmp_path / ".workpilot" / "worktrees" / "tasks" / "001-x"
    worktree.mkdir(parents=True)
    assert task_worktree(worktree)
    assert not task_worktree(tmp_path)
    assert not task_worktree(worktree.parent)


@pytest.fixture
def session(tmp_path: Path):
    project = tmp_path / ".workpilot" / "worktrees" / "tasks" / "001-x"
    spec = project / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    settings_file = project / ".claude_settings.json"
    settings_file.write_text(json.dumps({"permissions": {"allow": []}}), "utf-8")
    return project, spec, settings_file


def _options(**extra):
    return {"model": "claude-opus-5-5", "env": {}, "hooks": {"PreToolUse": []}, **extra}


def _apply(session, options, environ):
    project, spec, settings_file = session
    return apply(options, settings_file, "coder", spec, project, environ=environ)


def test_on_puts_the_cli_switch_in_the_settings_and_records_scripts(session):
    _, spec, settings_file = session
    options = _options()

    assert _apply(session, options, ON) is True

    settings = json.loads(settings_file.read_text("utf-8"))
    assert settings["env"] == {CLI_VAR: "1"}
    assert settings["permissions"] == {"allow": []}
    (matcher,) = options["hooks"]["PreToolUse"]
    assert matcher.matcher == "REPL"
    assert json.loads((spec / MARKER_FILE).read_text("utf-8")) == {"on": True}


@pytest.mark.parametrize(
    ("environ", "extra"),
    [
        ({}, {}),
        ({"WORKPILOT_CODE_MODE": "off"}, {}),
        (ON, {"model": "claude-opus-4-8"}),
        (ON, {"disallowed_tools": ["REPL"]}),
        (ON, {"env": {"ANTHROPIC_BASE_URL": "https://gateway.example.com"}}),
    ],
)
def test_anything_missing_leaves_the_session_as_it_was(session, environ, extra):
    _, spec, settings_file = session
    before = settings_file.read_text("utf-8")
    options = _options(**extra)

    assert _apply(session, options, environ) is False

    assert settings_file.read_text("utf-8") == before
    assert options["hooks"]["PreToolUse"] == []
    assert not (spec / MARKER_FILE).exists()


def test_outside_a_task_worktree_it_stays_off(tmp_path: Path):
    settings_file = tmp_path / ".claude_settings.json"
    settings_file.write_text("{}", "utf-8")
    options = _options()

    on = apply(options, settings_file, "coder", None, tmp_path, environ=ON)

    assert on is False
    assert settings_file.read_text("utf-8") == "{}"


def test_a_code_mode_session_is_not_resumed_without_it(session):
    _, spec, _ = session
    (spec / MARKER_FILE).write_text(json.dumps({"on": True}), "utf-8")
    options = _options(resume="session-1")

    _apply(session, options, {"WORKPILOT_CODE_MODE": "off"})

    assert "resume" not in options
    assert json.loads((spec / MARKER_FILE).read_text("utf-8")) == {"on": False}


def test_a_session_without_code_mode_resumes_as_before(session):
    options = _options(resume="session-1")

    _apply(session, options, {"WORKPILOT_CODE_MODE": "off"})

    assert options["resume"] == "session-1"


def test_a_code_mode_session_resumes_with_it(session):
    _, spec, _ = session
    (spec / MARKER_FILE).write_text(json.dumps({"on": True}), "utf-8")
    options = _options(resume="session-1")

    _apply(session, options, ON)

    assert options["resume"] == "session-1"


def test_the_hook_keeps_each_script_and_never_decides(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(native, "MAX_CODE_CHARS", 5)
    hook = make_script_record_hook(tmp_path, "coder")

    allowed = asyncio.run(
        hook({"tool_name": "REPL", "tool_input": {"code": "return 42"}}, "toolu_1")
    )
    asyncio.run(hook({"tool_name": "Bash", "tool_input": {"command": "ls"}}))
    asyncio.run(hook({"tool_name": "REPL", "tool_input": {}}))

    assert allowed == {}
    (line,) = (tmp_path / SCRIPTS_FILE).read_text("utf-8").splitlines()
    record = json.loads(line)
    assert record["agent"] == "coder"
    assert record["id"] == "toolu_1"
    assert record["code"] == "retur"


def test_the_hook_without_a_spec_folder_does_nothing():
    hook = make_script_record_hook(None, "coder")
    assert asyncio.run(hook({"tool_name": "REPL", "tool_input": {"code": "1"}})) == {}
