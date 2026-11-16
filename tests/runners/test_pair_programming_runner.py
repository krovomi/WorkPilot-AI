"""The AI half of a pair programming session, as the app reads it.

The app starts the runner with the goal and the two scopes, appends the
developer's messages to a JSON file, and reads one JSON event per stdout line.
The model is a stand-in client that answers each turn with the text and tool
calls a provider would stream; the messages file and the stdout are real.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import core.client
import pytest
from core.agent_client import AgentMessage, ContentBlock, ContentBlockType, MessageRole
from runners import pair_programming_runner as runner

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"


def text(value: str) -> ContentBlock:
    return ContentBlock(type=ContentBlockType.TEXT, text=value)


def tool(name: str, **arguments) -> ContentBlock:
    return ContentBlock(
        type=ContentBlockType.TOOL_USE, tool_name=name, tool_input=arguments
    )


class Model:
    """A client that plays one scripted answer per turn and keeps the prompts."""

    def __init__(self, answers, *, on_block=None, fail: Exception | None = None):
        self.answers = list(answers)
        self.prompts: list[str] = []
        self.on_block = on_block
        self.fail = fail
        self.closed = False
        self.created_with: dict = {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        self.closed = True

    async def query(self, prompt: str) -> None:
        self.prompts.append(prompt)

    async def receive_response(self):
        if self.fail:
            raise self.fail
        for block in self.answers.pop(0):
            if self.on_block:
                self.on_block(block)
            yield AgentMessage(role=MessageRole.ASSISTANT, content=[block])


@pytest.fixture
def session(tmp_path, monkeypatch, capsys):
    project = tmp_path / "shop"
    project.mkdir()
    messages = tmp_path / "messages.json"
    messages.write_text(json.dumps({"pending": []}), encoding="utf-8")

    def start(model: Model, *, dev_scope="Frontend login components"):
        def create_agent_client(**kwargs):
            model.created_with = kwargs
            return model

        monkeypatch.setattr(core.client, "create_agent_client", create_agent_client)
        asyncio.run(
            runner.run_pair_programming_session(
                project_dir=str(project),
                project_id="proj-1",
                session_id="pair_1",
                goal="Add user authentication",
                dev_scope=dev_scope,
                ai_scope="Backend auth API",
                messages_file=str(messages),
            )
        )
        lines = capsys.readouterr().out.splitlines()
        # The app reads the lines that parse as JSON (the workflow logger
        # prints its own lines too)
        return [json.loads(line) for line in lines if line.startswith("{")]

    return start, messages, project


def say(messages: Path, *contents: str) -> None:
    """What the app's appendUserMessage does."""
    data = json.loads(messages.read_text(encoding="utf-8"))
    data["pending"] += [{"content": c, "timestamp": "t"} for c in contents]
    messages.write_text(json.dumps(data), encoding="utf-8")


class TestASession:
    def test_the_work_is_streamed_and_the_session_ends_done(self, session):
        start, _messages, project = session
        model = Model([[text("Plan: add routes."), text(" Done.")]])

        events = start(model)

        assert [e["type"] for e in events] == [
            "status",
            "status",
            "stream",
            "stream",
            "done",
        ]
        assert "".join(e["content"] for e in events if e["type"] == "stream") == (
            "Plan: add routes. Done."
        )
        assert "Backend auth API" in events[-1]["summary"]
        assert model.closed
        assert model.created_with["agent_type"] == "coder"
        assert model.created_with["project_dir"] == str(project)
        prompt = model.prompts[0]
        assert "Add user authentication" in prompt
        assert "Do NOT touch files in the developer's scope: Frontend login" in prompt

    @pytest.mark.parametrize(
        ("block", "action", "path"),
        [
            (tool("Write", file_path="api/auth.py"), "file_created", "api/auth.py"),
            (tool("write_file", path="api/auth.py"), "file_created", "api/auth.py"),
            (tool("Edit", file_path="api/app.py"), "file_modified", "api/app.py"),
            (tool("str_replace_editor", path="a.py"), "file_modified", "a.py"),
            (tool("Bash", command="pytest -q"), "command_run", ""),
            (tool("run_command", cmd="pytest -q"), "command_run", ""),
        ],
    )
    def test_each_providers_tool_calls_are_reported(self, session, block, action, path):
        start, _messages, _project = session

        events = start(Model([[block]]))

        (reported,) = [e for e in events if e["type"] == "action"]
        assert reported["action_type"] == action
        assert reported["file_path"] == path
        if action == "command_run":
            assert reported["description"] == "Running: pytest -q"

    def test_a_read_or_a_thought_is_not_an_action(self, session):
        start, _messages, _project = session
        blocks = [
            tool("Read", file_path="api/auth.py"),
            ContentBlock(type=ContentBlockType.THINKING, text="hmm"),
            text(""),
        ]

        events = start(Model([blocks]))

        assert not [e for e in events if e["type"] in ("action", "stream")]

    def test_a_file_in_the_developers_scope_is_flagged(self, session):
        start, _messages, _project = session
        blocks = [
            tool("Write", file_path="src/components/LoginForm.tsx"),
            tool("Edit", file_path="api/auth.py"),
            tool("Edit", file_path="src/components/LoginForm.tsx"),
        ]

        events = start(Model([blocks]), dev_scope="Frontend (login) components")

        conflicts = [e for e in events if e["type"] == "conflict"]
        assert [c["file_path"] for c in conflicts] == ["src/components/LoginForm.tsx"]
        assert "looks like part of your scope" in conflicts[0]["message"]

    def test_a_failing_session_says_so(self, session):
        start, _messages, _project = session

        events = start(Model([], fail=ConnectionError("provider unreachable")))

        assert events[-1] == {
            "type": "error",
            "message": "Session failed: provider unreachable",
        }
        assert not [e for e in events if e["type"] == "done"]


class TestTheDevelopersMessages:
    def test_a_message_sent_while_the_ai_works_is_its_next_turn(
        self, session, monkeypatch
    ):
        start, messages, _project = session
        monkeypatch.setattr(runner, "MESSAGE_POLL_SECONDS", 0)
        sent = []

        def developer_types(block):
            if not sent:
                sent.append(True)
                say(messages, "Use JWT, not sessions")

        model = Model(
            [[text("Starting."), text("Still working.")], [text("Switched to JWT.")]],
            on_block=developer_types,
        )

        events = start(model)

        assert len(model.prompts) == 2
        assert "- Use JWT, not sessions" in model.prompts[1]
        assert any(
            e["type"] == "status" and "Message received" in e["message"] for e in events
        )
        assert events[-1]["type"] == "done"
        assert json.loads(messages.read_text("utf-8")) == {"pending": []}

    def test_a_message_waiting_at_the_end_of_a_turn_is_answered_too(self, session):
        start, messages, _project = session
        say(messages, "Add rate limiting", "And tests")

        model = Model([[text("Routes added.")], [text("Rate limiting added.")]])
        start(model)

        assert len(model.prompts) == 2
        assert "- Add rate limiting\n- And tests" in model.prompts[1]

    @pytest.mark.parametrize(
        "content",
        [None, "{", "[]", '{"pending": "nope"}', '{"pending": [{"content": ""}, 3]}'],
    )
    def test_a_messages_file_with_nothing_readable_gives_nothing(
        self, tmp_path, content
    ):
        path = tmp_path / "messages.json"
        if content is not None:
            path.write_text(content, encoding="utf-8")

        assert runner.read_pending_messages(str(path)) == []

    def test_messages_that_cannot_be_cleared_stay_for_the_next_read(
        self, tmp_path, monkeypatch
    ):
        path = tmp_path / "messages.json"
        path.write_text('{"pending": [{"content": "hi"}]}', encoding="utf-8")
        real_open = open

        def read_only(file, mode="r", *args, **kwargs):
            if "w" in mode:
                raise PermissionError(file)
            return real_open(file, mode, *args, **kwargs)

        monkeypatch.setattr("builtins.open", read_only)

        assert runner.read_pending_messages(str(path)) == []
        monkeypatch.setattr("builtins.open", real_open)
        assert runner.read_pending_messages(str(path)) == [{"content": "hi"}]


class TestTheCommandLine:
    def test_every_argument_the_app_passes_is_required(self, tmp_path):
        result = subprocess.run(
            [sys.executable, "runners/pair_programming_runner.py", "--goal", "x"],
            cwd=BACKEND,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
        )

        assert result.returncode == 2
        assert "--project-dir" in result.stderr

    def test_main_runs_the_session_with_the_apps_arguments(self, monkeypatch):
        seen = {}

        async def session(**kwargs):
            seen.update(kwargs)

        monkeypatch.setattr(runner, "run_pair_programming_session", session)
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "pair_programming_runner.py",
                "--project-dir",
                "/p",
                "--project-id",
                "proj-1",
                "--session-id",
                "pair_1",
                "--goal",
                "g",
                "--dev-scope",
                "d",
                "--ai-scope",
                "a",
                "--messages-file",
                "/m.json",
            ],
        )

        runner.main()

        assert seen == {
            "project_dir": "/p",
            "project_id": "proj-1",
            "session_id": "pair_1",
            "goal": "g",
            "dev_scope": "d",
            "ai_scope": "a",
            "messages_file": "/m.json",
        }
