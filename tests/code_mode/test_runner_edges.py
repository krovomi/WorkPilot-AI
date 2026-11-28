"""``run_script`` when the script host, Node or the script itself misbehave.

`test_runner.py` runs real scripts in real Node. Here a stand-in host (a
short Python program speaking the same line protocol) sends what a broken or
hostile script could: junk lines, calls without a tool, more calls than
allowed, a line over the size limit, an exit before ``done``. Each must end
as a `ScriptError` or a refused call, never a hung session.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import pytest
from code_mode import runner
from code_mode.runner import ScriptError, ScriptResult, _edit_file, _Session

#: The stand-in host: reads the code line, then plays its script (argv[1]).
#: ``{"out": text}`` writes a line, ``{"reply": n}`` reads n answers and logs
#: them back, ``{"sleep": s}`` waits, ``{"exit": code, "stderr": text}`` ends.
HOST = r"""
import json, sys, time
sys.stdin.readline()
for step in json.loads(sys.argv[1]):
    if "out" in step:
        sys.stdout.write(step["out"] + "\n")
        sys.stdout.flush()
    elif "reply" in step:
        for _ in range(step["reply"]):
            answer = sys.stdin.readline()
            sys.stdout.write(json.dumps({"type": "log", "text": answer.strip()}) + "\n")
            sys.stdout.flush()
    elif "sleep" in step:
        time.sleep(step["sleep"])
    elif "exit" in step:
        sys.stderr.write(step.get("stderr", ""))
        sys.stderr.flush()
        sys.exit(step["exit"])
"""


def _line(**message: Any) -> dict[str, str]:
    return {"out": json.dumps(message)}


class FakeExecutor:
    def __init__(self, root: Path, *, delay: float = 0.0, sandbox: Any = None) -> None:
        self.project_dir = root.resolve()
        self.working_directory = self.project_dir
        self.delay = delay
        self.sandbox = sandbox
        self.executed: list[tuple[str, dict]] = []

    async def execute(self, tool_name: str, arguments: dict[str, Any]) -> Any:
        self.executed.append((tool_name, arguments))
        if self.delay:
            await asyncio.sleep(self.delay)
        if tool_name == "boom":
            raise ValueError("the tool broke")
        if tool_name == "object":
            return object()
        return f"ran {tool_name}"

    def script_sandbox(self) -> Any:
        return self.sandbox


@pytest.fixture(autouse=True)
def _node_found(monkeypatch):
    async def node() -> tuple[str, tuple[int, int]]:
        return "node", (22, 13)

    monkeypatch.setattr(runner, "_node", node)


def _spawner(steps: list[dict], *, limit: int | None = None, seen: list | None = None):
    async def spawn(*argv: str, **kwargs: Any) -> asyncio.subprocess.Process:
        if seen is not None:
            seen.append((argv, kwargs))
        if limit is not None:
            kwargs["limit"] = limit
        return await asyncio.create_subprocess_exec(
            sys.executable, "-c", HOST, json.dumps(steps), **kwargs
        )

    return spawn


def _run(
    executor: FakeExecutor, steps: list[dict], **spawn_options: Any
) -> ScriptResult:
    return asyncio.run(
        runner.run_script(executor, "return 1", spawn=_spawner(steps, **spawn_options))
    )


# ── Limits and small pieces ──────────────────────────────────────────────


def test_a_result_without_calls_is_its_body_alone():
    assert ScriptResult("42", "").text() == "42"
    assert ScriptResult("42", "Calls: 1").text() == "42\n\nCalls: 1"


@pytest.mark.parametrize("raw", ["nan", "0", "-3", "soon"])
def test_a_timeout_that_is_not_a_positive_number_is_the_ceiling(monkeypatch, raw):
    monkeypatch.setenv(runner.TIMEOUT_ENV, raw)
    assert runner.timeout() == runner.MAX_SECONDS


def test_a_shorter_timeout_is_kept_and_a_longer_one_capped(monkeypatch):
    monkeypatch.setenv(runner.TIMEOUT_ENV, "12.5")
    assert runner.timeout() == 12.5
    monkeypatch.setenv(runner.TIMEOUT_ENV, "100000")
    assert runner.timeout() == runner.MAX_SECONDS


def test_a_value_json_cannot_hold_reaches_the_script_as_text():
    assert runner._json_value({"a": [1, "b"]}) == {"a": [1, "b"]}
    assert runner._json_value({1, 2}).startswith("{")


# ── Finding Node ─────────────────────────────────────────────────────────


def _probe_node(monkeypatch, version_line: str | None):
    """`_node` for real, with `node --version` answering ``version_line``."""
    monkeypatch.undo()
    monkeypatch.setattr(runner, "find_executable", lambda name: "/opt/node/bin/node")
    monkeypatch.setattr(runner, "_node_versions", {})
    real_exec = asyncio.create_subprocess_exec

    async def exec_(program, *args, **kwargs):
        if version_line is None:
            raise FileNotFoundError(program)
        return await real_exec(
            sys.executable, "-c", f"print({version_line!r})", **kwargs
        )

    monkeypatch.setattr(runner.asyncio, "create_subprocess_exec", exec_)


def test_a_node_that_does_not_start_is_refused_and_asked_only_once(monkeypatch):
    _probe_node(monkeypatch, None)
    with pytest.raises(ScriptError, match="Node.js 20 or later"):
        asyncio.run(runner._node())
    assert runner._node_versions == {"/opt/node/bin/node": None}


def test_a_node_older_than_20_is_refused(monkeypatch):
    _probe_node(monkeypatch, "v18.19.0")
    with pytest.raises(ScriptError, match="Node.js 20 or later"):
        asyncio.run(runner._node())


def test_a_recent_node_is_used_with_its_version(monkeypatch):
    _probe_node(monkeypatch, "v22.13.1")
    assert asyncio.run(runner._node()) == ("/opt/node/bin/node", (22, 13))


def test_without_node_the_model_is_told_to_use_the_other_tools(monkeypatch):
    monkeypatch.undo()
    monkeypatch.setattr(runner, "find_executable", lambda name: None)
    with pytest.raises(ScriptError, match="needs Node.js on this machine"):
        asyncio.run(runner._node())


# ── edit() ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("arguments", "message"),
    [
        ({"old": "a", "new": "b"}, "edit needs a path"),
        ({"path": "", "old": "a", "new": "b"}, "edit needs a path"),
        ({"path": "f.txt", "new": "b"}, "the text to replace and its replacement"),
        ({"path": "f.txt", "old": "", "new": "b"}, "the text to replace and its"),
        ({"path": "f.txt", "old": "a", "new": 3}, "the text to replace and its"),
        ({"path": "../outside.txt", "old": "a", "new": "b"}, "outside the project"),
        ({"path": "folder", "old": "a", "new": "b"}, "edit cannot read folder"),
    ],
)
def test_an_edit_the_runner_cannot_make_is_refused_before_any_write(
    tmp_path, arguments, message
):
    root = tmp_path / "project"
    (root / "folder").mkdir(parents=True)
    executor = FakeExecutor(root)
    with pytest.raises(ScriptError, match=message):
        asyncio.run(_edit_file(executor, arguments))
    assert executor.executed == []


# ── The session ──────────────────────────────────────────────────────────


def test_junk_lines_are_skipped_and_the_value_returned(tmp_path):
    result = _run(
        FakeExecutor(tmp_path),
        [{"out": "not json"}, {"out": "[1, 2]"}, _line(type="done", value="ok")],
    )
    assert result.body == "ok"


def test_a_host_that_stops_before_done_says_why(tmp_path):
    with pytest.raises(ScriptError, match="host stopped: SyntaxError: bad script"):
        _run(
            FakeExecutor(tmp_path), [{"exit": 1, "stderr": "SyntaxError: bad script\n"}]
        )


def test_a_host_that_stops_silently_says_there_was_no_output(tmp_path):
    with pytest.raises(ScriptError, match="host stopped: no output"):
        _run(FakeExecutor(tmp_path), [{"exit": 0}])


def test_a_message_over_the_line_limit_stops_the_script(tmp_path):
    big = _line(type="log", text="x" * 4096)
    with pytest.raises(ScriptError, match="message too large"):
        _run(FakeExecutor(tmp_path), [big], limit=1024)


def test_calls_without_a_tool_or_not_allowed_from_a_script_are_refused(tmp_path):
    executor = FakeExecutor(tmp_path)
    result = _run(
        executor,
        [
            _line(type="call", id=1, tool=None, args={}),
            _line(type="call", id=2, tool="read_file", args="not a dict"),
            _line(type="call", id=3, tool="run_script", args={"code": "1"}),
            {"reply": 3},
            _line(type="done", value=None),
        ],
    )
    assert executor.executed == []
    assert result.body.count("a call needs a tool name and arguments") == 2
    assert "run_script cannot be called from a script" in result.body


def test_calls_past_the_limit_are_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "MAX_CALLS", 1)
    executor = FakeExecutor(tmp_path)
    result = _run(
        executor,
        [
            _line(type="call", id=1, tool="read_file", args={"path": "a"}),
            {"reply": 1},
            _line(type="call", id=2, tool="read_file", args={"path": "b"}),
            {"reply": 1},
            _line(type="done", value="end"),
        ],
    )
    assert executor.executed == [("read_file", {"path": "a"})]
    assert "over 1 calls in one script" in result.body


def test_a_tool_that_raises_is_a_failed_call_the_script_reads(tmp_path):
    result = _run(
        FakeExecutor(tmp_path),
        [
            _line(type="call", id=1, tool="boom", args={}),
            _line(type="call", id=2, tool="object", args={}),
            {"reply": 2},
            _line(type="done", value="end"),
        ],
    )
    assert "the tool broke" in result.body
    assert "<object object at" in result.body
    assert "boom" in result.calls


def test_a_call_still_running_when_the_script_ends_is_finished(tmp_path):
    executor = FakeExecutor(tmp_path, delay=0.3)
    result = _run(
        executor,
        [
            _line(type="call", id=1, tool="read_file", args={"path": "a"}),
            _line(type="done", value="early"),
        ],
    )
    assert result.body == "early"
    assert executor.executed == [("read_file", {"path": "a"})]
    assert "read_file" in result.calls


def test_the_console_stops_at_its_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "MAX_LOG_CHARS", 10)
    result = _run(
        FakeExecutor(tmp_path),
        [
            _line(type="log", text="0123456"),
            _line(type="log", text="789abcdef"),
            _line(type="log", text="dropped"),
            _line(type="done", value="v"),
        ],
    )
    assert result.body == "v\n\nConsole:\n0123456\n789 …"


def test_an_isolated_sandbox_wraps_the_host(tmp_path):
    class Sandbox:
        isolated = True
        wrapped: list = []

        def wrap(self, argv, env, *, cwd):
            self.wrapped.append((argv, cwd))
            return ["sandboxed", *argv], {**env, "SANDBOXED": "1"}

    sandbox = Sandbox()
    seen: list = []
    result = _run(
        FakeExecutor(tmp_path, sandbox=sandbox),
        [_line(type="done", value="in")],
        seen=seen,
    )
    assert result.body == "in"
    assert sandbox.wrapped[0][1] == tmp_path.resolve()
    argv, kwargs = seen[0]
    assert argv[0] == "sandboxed" and kwargs["env"]["SANDBOXED"] == "1"


# ── Sending and stopping, at the pipe ────────────────────────────────────


class _Stdin:
    def __init__(self, *, closing=False, error: Exception | None = None) -> None:
        self.closing, self.error = closing, error
        self.written: list[bytes] = []
        self.closed = False

    def is_closing(self) -> bool:
        return self.closing

    def write(self, data: bytes) -> None:
        if self.error:
            raise self.error
        self.written.append(data)

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True


class _Process:
    def __init__(self, stdin=None, *, kill_error=None, hangs=False) -> None:
        self.stdin = stdin
        self.stdout = None
        self.stderr = None
        self.returncode = None
        self.kill_error, self.hangs = kill_error, hangs

    def kill(self) -> None:
        if self.kill_error:
            raise self.kill_error

    async def wait(self) -> int:
        if self.hangs:
            await asyncio.sleep(3600)
        return -9


def test_nothing_is_sent_to_a_closed_or_broken_pipe(tmp_path):
    executor = FakeExecutor(tmp_path)
    for stdin in (None, _Stdin(closing=True)):
        asyncio.run(_Session(executor, _Process(stdin)).send({"id": 1}))
    for error in (BrokenPipeError(), ConnectionResetError()):
        broken = _Stdin(error=error)
        asyncio.run(_Session(executor, _Process(broken)).send({"id": 1}))
        assert broken.written == []


def test_stop_cancels_calls_and_tolerates_a_host_already_gone(tmp_path):
    async def scenario() -> asyncio.Task:
        session = _Session(
            FakeExecutor(tmp_path), _Process(_Stdin(), kill_error=ProcessLookupError())
        )
        task = asyncio.create_task(asyncio.sleep(3600))
        session.tasks.add(task)
        await session.stop()
        await asyncio.sleep(0)
        assert session.process.stdin.closed
        return task

    assert asyncio.run(scenario()).cancelled()


def test_a_host_that_does_not_exit_is_logged_not_waited_for(
    tmp_path, monkeypatch, caplog
):
    real_wait_for = asyncio.wait_for

    async def short_wait_for(awaitable, timeout):
        return await real_wait_for(awaitable, timeout=min(timeout, 0.05))

    monkeypatch.setattr(runner.asyncio, "wait_for", short_wait_for)
    session = _Session(FakeExecutor(tmp_path), _Process(None, hangs=True))
    with caplog.at_level("WARNING", logger=runner.logger.name):
        asyncio.run(session.stop())
    assert "did not exit" in caplog.text
