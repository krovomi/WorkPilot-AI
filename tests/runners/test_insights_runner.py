"""The Insights chat, as the app reads it.

The app starts the runner with a question (and the conversation so far in a
file) and reads its stdout line by line: the answer's text, ``__TOOL_START__``
and ``__TOOL_END__`` around each tool, ``__EXPLANATION__`` in Learning Mode. A
non-zero exit is shown with the end of stderr. The model is a stand-in client
that streams what a provider would; the project files and stdout are real.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import core.client
import pytest
from core.agent_client import AgentMessage, ContentBlock, ContentBlockType, MessageRole
from runners import insights_runner as runner

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"


def text(value: str) -> ContentBlock:
    return ContentBlock(type=ContentBlockType.TEXT, text=value)


def tool(name: str, arguments: object) -> ContentBlock:
    return ContentBlock(
        type=ContentBlockType.TOOL_USE, tool_name=name, tool_input=arguments
    )


def result() -> ContentBlock:
    return ContentBlock(type=ContentBlockType.TOOL_RESULT, tool_use_id="t1")


class Model:
    """A client that streams one scripted answer and keeps what it was asked."""

    def __init__(self, blocks, *, usage=None, fail: Exception | None = None):
        self.blocks = list(blocks)
        self.prompts: list[str] = []
        self.created_with: dict = {}
        self.last_usage = usage
        self.fail = fail

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return None

    async def query(self, prompt: str) -> None:
        self.prompts.append(prompt)

    async def receive_response(self):
        if self.fail:
            raise self.fail
        for block in self.blocks:
            yield AgentMessage(role=MessageRole.ASSISTANT, content=[block])


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "shop"
    (root / ".workpilot").mkdir(parents=True)
    return root


@pytest.fixture
def chat(project, tmp_path, monkeypatch, capsys):
    """Run the runner's main() on a stand-in model, as the app starts it."""
    recorded: list[dict] = []

    def start(model: Model, *args: str, provider: str = "copilot", history=None):
        def create_agent_client(**kwargs):
            if start.fail_to_create:
                raise start.fail_to_create
            model.created_with = kwargs
            return model

        monkeypatch.setattr(core.client, "create_agent_client", create_agent_client)
        monkeypatch.setattr(core.client, "peek_active_provider", lambda _p: provider)
        monkeypatch.setattr(
            "core.usage_tracker.record_session_usage",
            start.record or (lambda **kw: recorded.append(kw)),
        )
        history_file = tmp_path / "history.json"
        history_file.write_text(json.dumps(history or []), encoding="utf-8")
        argv = [
            "insights_runner.py",
            "--project-dir",
            str(project),
            "--message",
            "Where is the cart total computed?",
            "--history-file",
            str(history_file),
            *args,
        ]
        monkeypatch.setattr(sys, "argv", argv)
        code = runner.main()
        out = capsys.readouterr()
        return code, out.out.splitlines(), out.err

    start.recorded = recorded
    start.record = None
    start.fail_to_create = None
    return start


def markers(lines: list[str], prefix: str) -> list[dict]:
    return [
        json.loads(line[len(prefix) :]) for line in lines if line.startswith(prefix)
    ]


class TestAnAnswer:
    def test_the_answer_and_its_tools_are_streamed(self, chat):
        model = Model(
            [
                tool("Grep", {"pattern": "total"}),
                result(),
                tool("Read", {"file_path": "src/cart.py"}),
                result(),
                text("It is computed in src/cart.py."),
            ]
        )

        code, lines, _ = chat(model)

        assert code == 0
        assert markers(lines, "__TOOL_START__:") == [
            {"name": "Grep", "input": "pattern: total"},
            {"name": "Read", "input": "src/cart.py"},
        ]
        # Each tool closes, so the app stops showing it as running.
        assert markers(lines, "__TOOL_END__:") == [{"name": "Grep"}, {"name": "Read"}]
        assert "It is computed in src/cart.py." in lines
        assert lines[-1] == ""  # the answer ends on its own line

    def test_the_chat_runs_on_the_project_s_provider_with_its_read_tools(
        self, chat, project
    ):
        model = Model([text("ok\n")])

        chat(model, "--model", "haiku", "--thinking-level", "none", provider="openai")

        made = model.created_with
        assert made["provider"] == "openai"
        assert made["agent_type"] == "insights"
        assert made["use_subagents"] is False
        assert made["project_dir"] == project.resolve()
        assert made["spec_dir"] == project.resolve() / ".workpilot" / "insights"
        assert made["max_thinking_tokens"] is None

    def test_what_a_tool_works_on_is_shown(self, chat):
        long_path = "d/" * 1500 + "f.py"
        model = Model(
            [
                tool("Glob", {"path": "src"}),
                tool("Read", {"file_path": long_path}),
                tool("WebSearch", {"query": "x"}),
                tool("Odd", "not a dict"),
            ]
        )

        _, lines, _ = chat(model)

        shown = [m["input"] for m in markers(lines, "__TOOL_START__:")]
        assert shown[0] == "src"
        assert shown[1] == "..." + long_path[-1997:] and len(shown[1]) == 2000
        assert shown[2:] == ["", ""]
        # A result with no tool open closes nothing.
        assert markers(lines, "__TOOL_END__:") == []

    def test_the_conversation_so_far_comes_with_the_question(self, chat):
        model = Model([text("ok")])
        history = [
            {"role": "user", "content": "What does the shop sell?"},
            {"role": "assistant", "content": "Shoes."},
            "not a message",
            {"role": "user", "content": "Where is the cart total computed?"},
        ]

        chat(model, history=history)

        prompt = model.prompts[0]
        assert "User: What does the shop sell?" in prompt
        assert "Assistant: Shoes." in prompt
        assert prompt.endswith("Current question: Where is the cart total computed?")

    def test_a_first_question_goes_alone(self, chat):
        model = Model([text("ok")])

        chat(model)

        assert model.prompts == ["Where is the cart total computed?"]

    def test_learning_mode_explains_each_tool(self, chat):
        model = Model([tool("Grep", {"pattern": "total"}), result()])

        _, lines, _ = chat(model, "--learning-mode", "--explanation-level", "beginner")

        (explanation,) = markers(lines, "__EXPLANATION__:")
        assert explanation["difficulty"] == "beginner"
        assert explanation["title"]

    def test_what_the_chat_cost_is_recorded(self, chat, project):
        usage = {"input_tokens": 120, "output_tokens": 30, "cost_usd": 0.01}
        model = Model([text("ok")], usage=usage)

        chat(model, "--model", "sonnet", provider="claude")

        (row,) = chat.recorded
        assert row["phase"] == "insights"
        assert row["provider"] == "claude"
        assert (row["input_tokens"], row["output_tokens"]) == (120, 30)
        assert row["spec_dir"] == project.resolve() / ".workpilot" / "insights"

    def test_a_usage_record_that_fails_does_not_fail_the_answer(self, chat):
        def broken(**_kw):
            raise OSError("disk full")

        chat.record = broken
        code, lines, _ = chat(Model([text("ok")], usage={"input_tokens": 1}))

        assert code == 0
        assert "ok" in lines

    def test_a_project_that_cannot_hold_the_chat_folder_records_at_its_root(
        self, chat, project
    ):
        (project / ".workpilot").rmdir()
        (project / ".workpilot").write_text("not a folder", encoding="utf-8")
        model = Model([text("ok")], usage={"input_tokens": 1})

        code, _, _ = chat(model)

        assert code == 0
        assert model.created_with["spec_dir"] == project.resolve()
        assert chat.recorded[0]["spec_dir"] == project.resolve()

    def test_no_usage_reported_records_nothing(self, chat):
        chat(Model([text("ok")], usage=None))

        assert chat.recorded == []


class TestAChatThatCannotBeAnswered:
    def test_a_failing_provider_says_why_and_exits_1(self, chat):
        model = Model([], fail=RuntimeError("rate limited"))

        code, lines, err = chat(model, provider="copilot")

        assert code == 1
        assert err.strip().endswith("Insights could not answer: rate limited")
        # No stand-in answer and no other provider.
        assert lines == []

    def test_a_client_that_cannot_be_made_says_why(self, chat):
        chat.fail_to_create = ValueError("No OAuth token found")

        code, lines, err = chat(Model([]), provider="claude")

        assert code == 1
        assert err.strip().endswith("Insights could not answer: No OAuth token found")
        assert lines == []


class TestTheProjectContext:
    def test_the_index_roadmap_and_tasks_are_summarised(self, project):
        workpilot = project / ".workpilot"
        (workpilot / "project_index.json").write_text(
            json.dumps(
                {
                    "project_root": "/shop",
                    "project_type": "monorepo",
                    "services": {"api": {}, "web": {}},
                    "infrastructure": {"docker": True},
                }
            ),
            encoding="utf-8",
        )
        (workpilot / "roadmap").mkdir()
        (workpilot / "roadmap" / "roadmap.json").write_text(
            json.dumps(
                {"features": [{"title": "Checkout", "status": "planned"}, "junk"]}
            ),
            encoding="utf-8",
        )
        for name in ("002-cart", "001-login"):
            (workpilot / "specs" / name).mkdir(parents=True)
        (workpilot / "specs" / "notes.txt").write_text("x", encoding="utf-8")

        context = runner.load_project_context(str(project))

        assert '"services": [\n    "api",\n    "web"\n  ]' in context
        assert '"title": "Checkout"' in context
        assert "junk" not in context
        assert context.endswith("- 001-login\n- 002-cart")

    @pytest.mark.parametrize(
        "index",
        ["{not json", "[1, 2]", json.dumps({"services": ["api"]})],
    )
    def test_an_unreadable_or_odd_file_is_left_out(self, project, index):
        (project / ".workpilot" / "project_index.json").write_text(
            index, encoding="utf-8"
        )
        (project / ".workpilot" / "roadmap").mkdir()
        (project / ".workpilot" / "roadmap" / "roadmap.json").write_text(
            json.dumps({"features": "none"}), encoding="utf-8"
        )

        context = runner.load_project_context(str(project))

        if index.startswith('{"'):
            assert '"services": []' in context
        else:
            assert context == "No project context available yet."

    def test_a_project_with_nothing_yet_says_so(self, tmp_path):
        prompt = runner.build_system_prompt(str(tmp_path))

        assert "No project context available yet." in prompt
        assert "__TASK_SUGGESTION__" in prompt


class TestTheCommandLine:
    def test_every_argument_the_app_passes_is_required(self):
        run = subprocess.run(
            [sys.executable, "runners/insights_runner.py", "--message", "x"],
            cwd=BACKEND,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
        )

        assert run.returncode == 2
        assert "--project-dir" in run.stderr

    def test_inline_history_is_read_and_a_bad_one_is_dropped(self, monkeypatch):
        seen = []

        async def run_chat(_project, _message, history, *_rest):
            seen.append(history)

        monkeypatch.setattr(runner, "run_chat", run_chat)
        for value in ('[{"role": "user", "content": "hi"}]', "{oops", '{"a": 1}'):
            monkeypatch.setattr(
                sys,
                "argv",
                ["r", "--project-dir", ".", "--message", "m", "--history", value],
            )
            assert runner.main() == 0

        assert seen == [[{"role": "user", "content": "hi"}], [], []]

    def test_a_missing_history_file_is_an_empty_conversation(
        self, monkeypatch, tmp_path
    ):
        seen = []

        async def run_chat(_project, _message, history, *_rest):
            seen.append(history)

        monkeypatch.setattr(runner, "run_chat", run_chat)
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "r",
                "--project-dir",
                ".",
                "--message",
                "m",
                "--history-file",
                str(tmp_path / "gone.json"),
            ],
        )

        assert runner.main() == 0
        assert seen == [[]]
