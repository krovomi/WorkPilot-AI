"""The Linear updater (`integrations/linear/updater.py`).

The mini-agent is the code's own: a stand-in runtime is installed through the
`agent_runtime` port, and its client answers the prompt the updater sends the
way the SDK does (an `AssistantMessage` holding `TextBlock`s). The state file
`.linear_task.json` is written and read for real.
"""

from __future__ import annotations

import json

import agent_runtime
import pytest
from integrations.linear import updater


class AssistantMessage:
    def __init__(self, *blocks):
        self.content = list(blocks)


class TextBlock:
    def __init__(self, text):
        self.text = text


class ToolUseBlock:
    text = "not read: only TextBlock counts"


class ResultMessage:
    pass


class _Client:
    def __init__(self, replies, prompts, fail=None):
        self._replies = replies
        self._prompts = prompts
        self._fail = fail

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        if self._fail:
            raise self._fail
        self._prompts.append(prompt)

    async def receive_response(self):
        for message in self._replies.pop(0) if self._replies else []:
            yield message


class _Runtime:
    def __init__(self):
        self.replies: list[list[object]] = []
        self.prompts: list[str] = []
        self.client_kwargs: list[dict] = []
        self.fail: Exception | None = None
        self.auth_error: Exception | None = None

    def require_auth_token(self):
        if self.auth_error:
            raise self.auth_error
        return "token"

    def ensure_claude_code_oauth_token(self):
        return None

    def create_simple_client(self, **kwargs):
        self.client_kwargs.append(kwargs)
        return _Client(self.replies, self.prompts, self.fail)

    def answer(self, *texts: str) -> None:
        self.replies.append(
            [AssistantMessage(TextBlock(t), ToolUseBlock()) for t in texts]
            + [ResultMessage()]
        )


@pytest.fixture
def runtime(monkeypatch):
    fake = _Runtime()
    monkeypatch.setattr(agent_runtime, "_runtime", fake)
    monkeypatch.setattr(updater, "SDK_AVAILABLE", True)
    monkeypatch.setenv("LINEAR_API_KEY", "lin_api_test")
    return fake


@pytest.fixture
def spec_dir(tmp_path):
    path = tmp_path / "001-feature"
    path.mkdir()
    return path


def _task(spec_dir, **fields):
    state = updater.LinearTaskState(task_id="VAL-1", team_id="team-1", **fields)
    state.save(spec_dir)
    return state


# --------------------------------------------------------------------------
# State and switches
# --------------------------------------------------------------------------


def test_state_round_trips_through_its_file(spec_dir):
    state = updater.LinearTaskState(
        "VAL-9", "Title", "team", updater.STATUS_IN_REVIEW, "2026-11-14"
    )
    state.save(spec_dir)
    on_disk = json.loads(
        (spec_dir / updater.LINEAR_TASK_FILE).read_text(encoding="utf-8")
    )
    assert on_disk["task_id"] == "VAL-9"
    assert updater.LinearTaskState.load(spec_dir) == state


def test_missing_or_broken_state_is_none(spec_dir):
    assert updater.LinearTaskState.load(spec_dir) is None
    (spec_dir / updater.LINEAR_TASK_FILE).write_text("{broken", encoding="utf-8")
    assert updater.LinearTaskState.load(spec_dir) is None


def test_state_defaults_to_todo():
    assert updater.LinearTaskState.from_dict({}).status == updater.STATUS_TODO


def test_enabled_only_with_an_api_key(monkeypatch):
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    assert updater.is_linear_enabled() is False
    assert updater.get_linear_api_key() == ""
    monkeypatch.setenv("LINEAR_API_KEY", "lin_api_test")
    assert updater.is_linear_enabled() is True
    assert updater.get_linear_api_key() == "lin_api_test"


async def test_everything_is_a_no_op_when_disabled(monkeypatch, spec_dir):
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    assert await updater.create_linear_task(spec_dir, "x") is None
    assert await updater.update_linear_status(spec_dir, updater.STATUS_DONE) is False
    assert await updater.add_linear_comment(spec_dir, "x") is False


# --------------------------------------------------------------------------
# The mini-agent client
# --------------------------------------------------------------------------


def test_client_is_the_linear_updater_type_with_only_the_linear_server(runtime):
    updater._create_linear_client()
    kwargs = runtime.client_kwargs[-1]
    assert kwargs["agent_type"] == "linear_updater"
    assert kwargs["max_turns"] == 10
    server = kwargs["mcp_servers"]["linear"]
    assert set(kwargs["mcp_servers"]) == {"linear"}
    assert server["url"] == "https://mcp.linear.app/mcp"
    assert server["headers"] == {"Authorization": "Bearer lin_api_test"}


def test_client_refused_without_the_sdk(monkeypatch):
    monkeypatch.setattr(updater, "SDK_AVAILABLE", False)
    with pytest.raises(ImportError, match="claude_agent_sdk"):
        updater._create_linear_client()


def test_client_refused_without_a_linear_key(runtime, monkeypatch):
    monkeypatch.delenv("LINEAR_API_KEY")
    with pytest.raises(ValueError, match="LINEAR_API_KEY not set"):
        updater._create_linear_client()


async def test_agent_reply_keeps_only_assistant_text(runtime):
    runtime.answer("TASK_ID: VAL-1", "\nTEAM_ID: T")
    assert await updater._run_linear_agent("prompt") == "TASK_ID: VAL-1\nTEAM_ID: T"
    assert runtime.prompts == ["prompt"]


async def test_agent_failure_is_reported_and_none(runtime, capsys):
    runtime.auth_error = ValueError("no token")
    assert await updater._run_linear_agent("prompt") is None
    assert "Linear update failed: no token" in capsys.readouterr().out


# --------------------------------------------------------------------------
# Task creation and status
# --------------------------------------------------------------------------


async def test_create_task_parses_ids_and_saves_state(runtime, spec_dir):
    runtime.answer("Done.\n  TASK_ID: VAL-123  \nTEAM_ID: team-9\n")

    state = await updater.create_linear_task(spec_dir, "Add login", "OAuth flow")

    assert (state.task_id, state.team_id, state.task_title) == (
        "VAL-123",
        "team-9",
        "Add login",
    )
    assert state.status == updater.STATUS_TODO
    assert updater.LinearTaskState.load(spec_dir).task_id == "VAL-123"
    assert 'title: "Add login"' in runtime.prompts[0]
    assert 'description: "OAuth flow"' in runtime.prompts[0]


async def test_create_task_without_description_leaves_it_out(runtime, spec_dir):
    runtime.answer("TASK_ID: VAL-2")
    state = await updater.create_linear_task(spec_dir, "Title")
    assert state.team_id is None
    assert "description:" not in runtime.prompts[0]


async def test_existing_task_is_reused(runtime, spec_dir, capsys):
    _task(spec_dir)
    state = await updater.create_linear_task(spec_dir, "again")
    assert state.task_id == "VAL-1"
    assert runtime.prompts == []
    assert "already exists: VAL-1" in capsys.readouterr().out


async def test_create_task_without_an_answer_or_an_id(runtime, spec_dir, capsys):
    runtime.answer("")
    assert await updater.create_linear_task(spec_dir, "t") is None
    runtime.answer("I could not create it")
    assert await updater.create_linear_task(spec_dir, "t") is None
    assert "Failed to parse task ID" in capsys.readouterr().out
    assert updater.LinearTaskState.load(spec_dir) is None


async def test_status_update_saves_the_new_status(runtime, spec_dir):
    _task(spec_dir)
    runtime.answer("ok")
    assert await updater.update_linear_status(spec_dir, updater.STATUS_DONE) is True
    assert updater.LinearTaskState.load(spec_dir).status == updater.STATUS_DONE
    assert 'teamId: "team-1"' in runtime.prompts[0]
    assert 'issueId: "VAL-1"' in runtime.prompts[0]


async def test_status_update_skips_the_same_status(runtime, spec_dir):
    _task(spec_dir, status=updater.STATUS_IN_PROGRESS)
    assert (
        await updater.update_linear_status(spec_dir, updater.STATUS_IN_PROGRESS) is True
    )
    assert runtime.prompts == []


async def test_status_update_without_a_task_or_an_answer(runtime, spec_dir, capsys):
    assert await updater.update_linear_status(spec_dir, updater.STATUS_DONE) is False
    assert "No Linear task found" in capsys.readouterr().out
    _task(spec_dir)
    runtime.answer("")
    assert await updater.update_linear_status(spec_dir, updater.STATUS_DONE) is False
    assert updater.LinearTaskState.load(spec_dir).status == updater.STATUS_TODO


async def test_comment_body_is_json_quoted(runtime, spec_dir):
    _task(spec_dir)
    runtime.answer("ok")
    assert await updater.add_linear_comment(spec_dir, 'say "hi"\nnext') is True
    assert 'body: "say \\"hi\\"\\nnext"' in runtime.prompts[0]


async def test_comment_without_a_task_or_an_answer(runtime, spec_dir):
    assert await updater.add_linear_comment(spec_dir, "x") is False
    _task(spec_dir)
    runtime.answer("")
    assert await updater.add_linear_comment(spec_dir, "x") is False


# --------------------------------------------------------------------------
# Transitions
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("transition", "status", "comment"),
    [
        (updater.linear_task_started, updater.STATUS_IN_PROGRESS, "Build started"),
        (updater.linear_qa_started, updater.STATUS_IN_REVIEW, "QA validation started"),
    ],
)
async def test_status_transitions_also_comment(
    runtime, spec_dir, transition, status, comment
):
    _task(spec_dir)
    runtime.answer("ok")
    runtime.answer("ok")
    assert await transition(spec_dir) is True
    assert updater.LinearTaskState.load(spec_dir).status == status
    assert comment in runtime.prompts[1]


async def test_failed_status_transition_does_not_comment(runtime, spec_dir):
    _task(spec_dir)
    runtime.answer("")
    assert await updater.linear_task_started(spec_dir) is False
    assert len(runtime.prompts) == 1


@pytest.mark.parametrize(
    ("call", "expected"),
    [
        (
            lambda d: updater.linear_subtask_completed(d, "1.2", 3, 5),
            "Completed 1.2 (3/5 subtasks done)",
        ),
        (
            lambda d: updater.linear_subtask_failed(d, "1.2", 2, "x" * 300),
            "Subtask 1.2 failed (attempt 2): " + "x" * 200 + '"',
        ),
        (
            updater.linear_build_complete,
            "All subtasks completed - moving to QA validation",
        ),
        (updater.linear_qa_approved, "QA approved - awaiting human review for merge"),
        (
            lambda d: updater.linear_qa_rejected(d, 4, 2),
            "QA iteration 2: Found 4 issues - applying fixes",
        ),
        (
            lambda d: updater.linear_qa_max_iterations(d, 7),
            "QA reached max iterations (7)",
        ),
        (
            lambda d: updater.linear_task_stuck(d, "2.1", 6),
            "Subtask 2.1 is STUCK after 6 attempts",
        ),
    ],
)
async def test_comment_transitions(runtime, spec_dir, call, expected):
    _task(spec_dir)
    runtime.answer("ok")
    assert await call(spec_dir) is True
    assert expected in runtime.prompts[0]


def test_without_the_sdk_the_module_still_loads_and_says_so(monkeypatch):
    import importlib.util
    import sys

    monkeypatch.setitem(sys.modules, "claude_agent_sdk", None)  # import fails
    spec = importlib.util.spec_from_file_location(
        "_linear_updater_no_sdk", updater.__file__
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert module.SDK_AVAILABLE is False
    with pytest.raises(ImportError, match="claude_agent_sdk is not available"):
        module._create_linear_client()


def test_client_refused_without_an_installed_runtime(monkeypatch):
    monkeypatch.setattr(agent_runtime, "_runtime", None)
    monkeypatch.setattr(updater, "SDK_AVAILABLE", True)
    with pytest.raises(ImportError, match="no agent runtime"):
        updater._create_linear_client()
