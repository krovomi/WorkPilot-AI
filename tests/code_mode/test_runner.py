"""``run_script`` end to end: real Node, the real executor, its real checks."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

import pytest
from code_mode import runner
from code_mode.protocol import inner_calls
from code_mode.runner import (
    ScriptError,
    host_env,
    node_argv,
    parse_node_version,
    permission_flag,
)
from code_mode.settings import ENV_VAR
from core.runtimes.tool_executor import ToolExecutor, get_tool_definitions

needs_node = pytest.mark.skipif(
    shutil.which("node") is None, reason="run_script runs scripts with Node.js"
)


@pytest.fixture
def project(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setenv(ENV_VAR, "on")
    monkeypatch.setenv("WORKPILOT_SANDBOX", "off")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.py").write_text("x = 1\n", encoding="utf-8")
    (tmp_path / "src" / "b.py").write_text("y = 2\n", encoding="utf-8")
    (tmp_path / "conf.txt").write_text("maxAttempts: 3\n", encoding="utf-8")
    return tmp_path


def _run(executor: ToolExecutor, code: str) -> str:
    return asyncio.run(executor.execute("run_script", {"code": code}))


@needs_node
def test_a_script_chains_calls_in_parallel_and_returns_what_it_needs(project: Path):
    executor = ToolExecutor(str(project), agent_type="coder")
    result = _run(
        executor,
        """
        const [files, conf] = await Promise.all([find('**/*.py'), read('conf.txt')]);
        console.log('found', files.split('\\n').length);
        await edit('conf.txt', 'maxAttempts: 3', 'maxAttempts: 5');
        return { files: files.split('\\n'), before: conf.trim() };
        """,
    )
    assert '"before": "maxAttempts: 3"' in result
    assert "src/a.py" in result and "src/b.py" in result
    assert "Console:\nfound 2" in result
    assert (project / "conf.txt").read_text(encoding="utf-8") == "maxAttempts: 5\n"
    calls = inner_calls(result)
    assert [c[0] for c in calls] == ["find_files", "read_file", "write_file"]
    assert calls[2] == ("write_file", {"path": "conf.txt"}, True)


@needs_node
def test_the_script_has_no_way_out_but_its_functions(project: Path):
    executor = ToolExecutor(str(project), agent_type="coder")
    result = _run(
        executor,
        """
        const out = {};
        const probe = (name, f) => { try { out[name] = String(f()); } catch (e) { out[name] = 'refused'; } };
        probe('ctor', () => read.constructor('return process')());
        probe('eval', () => eval('1 + 1'));
        out.fetch = typeof fetch;
        out.require = typeof require;
        out.process = typeof process;
        out.timer = typeof setTimeout;
        try { await import('node:fs'); out.import = 'loaded'; } catch (e) { out.import = 'refused'; }
        return out;
        """,
    )
    for refused in ('"ctor": "refused"', '"eval": "refused"', '"import": "refused"'):
        assert refused in result
    for absent in ("fetch", "require", "process", "timer"):
        assert f'"{absent}": "undefined"' in result


@needs_node
def test_each_inner_call_meets_the_checks_of_a_direct_one(project: Path):
    # Outside the project: refused by the path guard, recorded as not done.
    executor = ToolExecutor(str(project), agent_type="coder")
    result = _run(executor, "return await read('../../etc/passwd')")
    assert "outside the project directory" in result
    assert inner_calls(result)[0][2] is False
    # A reviewer cannot write, from a script either.
    reviewer = ToolExecutor(str(project), agent_type="pr_reviewer")
    result = _run(reviewer, "return await write('src/c.py', 'z = 3')")
    assert "not available to this agent" in result
    assert not (project / "src" / "c.py").exists()
    assert inner_calls(result) == [("write_file", {"path": "src/c.py"}, False)]
    # Nor can a script call itself.
    result = _run(executor, "return await tool('run_script', {code: 'return 1'})")
    assert "cannot be called from a script" in result


@needs_node
def test_edit_wants_text_that_occurs_once(project: Path):
    executor = ToolExecutor(str(project), agent_type="coder")
    (project / "twice.txt").write_text("a a\n", encoding="utf-8")
    result = _run(executor, "return await edit('twice.txt', 'a', 'b')")
    assert "2 times" in result
    result = _run(executor, "return await edit('twice.txt', 'a', 'b', {all: true})")
    assert (project / "twice.txt").read_text(encoding="utf-8") == "b b\n"
    result = _run(executor, "return await edit('twice.txt', 'zzz', 'b')")
    assert "not in twice.txt" in result


@needs_node
def test_the_limits_hold(project: Path, monkeypatch):
    executor = ToolExecutor(str(project), agent_type="coder")
    result = _run(
        executor,
        "for (let i = 0; i < 60; i++) { await list('.'); } return 'done';",
    )
    assert "more than 50 tool calls" in result
    assert len(inner_calls(result)) == 50
    monkeypatch.setenv(runner.TIMEOUT_ENV, "1")
    with pytest.raises(RuntimeError, match="ran over 1s"):
        _run(executor, "await new Promise(() => {}); return 1;")
    result = _run(executor, "throw new Error('broken on purpose')")
    assert result.startswith("The script failed: broken on purpose")


def test_off_refuses_the_tool_and_offers_nothing(project: Path, monkeypatch):
    monkeypatch.setenv(ENV_VAR, "off")
    executor = ToolExecutor(str(project), agent_type="coder")
    assert "code mode is off" in _run(executor, "return 1")
    assert "run_script" not in [t["name"] for t in get_tool_definitions("coder")]


def test_the_definition_names_only_the_tools_of_the_type(project: Path):
    coder = {t["name"]: t for t in get_tool_definitions("coder")}
    assert "await write(" in coder["run_script"]["description"]
    assert "await run(" in coder["run_script"]["description"]
    reviewer = {t["name"]: t for t in get_tool_definitions("pr_reviewer")}
    description = reviewer["run_script"]["description"]
    assert "await read(" in description
    assert "await write(" not in description and "await run(" not in description
    # A type without tools has nothing to chain.
    assert "run_script" not in [
        t["name"] for t in get_tool_definitions("commit_message")
    ]


def test_node_runs_under_its_permission_model_without_credentials():
    assert parse_node_version("v22.13.1\n") == (22, 13)
    assert parse_node_version("garbage") is None
    assert permission_flag((22, 13)) == "--permission"
    assert permission_flag((20, 18)) == "--experimental-permission"
    argv = node_argv("node", (24, 1))
    assert argv[1] == "--permission"
    assert f"--allow-fs-read={runner.HOST}" in argv
    assert "--disallow-code-generation-from-strings" in argv
    assert not any(
        a.startswith(("--allow-child", "--allow-worker", "--allow-fs-write"))
        for a in argv
    )
    env = host_env({"PATH": "/bin", "OPENAI_API_KEY": "sk-test-0000", "HOME": "/h"})
    assert env == {"PATH": "/bin"}


def test_without_node_the_script_is_refused_in_words(project: Path, monkeypatch):
    monkeypatch.setattr(runner, "find_executable", lambda _name: None)
    executor = ToolExecutor(str(project), agent_type="coder")
    with pytest.raises(RuntimeError, match="needs Node.js"):
        _run(executor, "return 1")
    with pytest.raises(RuntimeError, match="needs the script"):
        asyncio.run(executor.execute("run_script", {"code": "  "}))


def test_in_a_microvm_the_script_runs_on_this_machine(project: Path, monkeypatch):
    """Node stays on the host, in its OS sandbox; the script's commands go to the VM."""
    import os_sandbox

    in_vm = type("Session", (), {"vm": object(), "isolated": True})()
    on_host = type("Session", (), {"vm": None, "isolated": False})()
    asked: list[bool] = []

    def session_sandbox(_project, _spec=None, *, microvm=False, **_kwargs):
        asked.append(microvm)
        return in_vm if microvm else on_host

    monkeypatch.setattr(os_sandbox, "session_sandbox", session_sandbox)
    executor = ToolExecutor(str(project), agent_type="coder")

    assert executor.script_sandbox() is on_host
    assert executor.script_sandbox() is on_host
    assert executor.session_sandbox() is in_vm
    assert asked == [True, False]


def test_without_a_microvm_the_script_shares_the_session_sandbox(
    project: Path, monkeypatch
):
    import os_sandbox

    session = type("Session", (), {"vm": None, "isolated": True})()
    monkeypatch.setattr(os_sandbox, "session_sandbox", lambda *_a, **_k: session)
    executor = ToolExecutor(str(project), agent_type="coder")

    assert executor.script_sandbox() is session
