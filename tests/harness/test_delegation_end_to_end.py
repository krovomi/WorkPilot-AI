"""A delegation from end to end, on a real client against a local endpoint.

`tests/harness/test_delegation.py` pins each piece on doubles. This one runs
the real `OpenAIAgentClient` (the WorkPilot loop, `ToolExecutor`, the roster
attached by `create_agent_client`) against a scripted OpenAI-compatible
server on 127.0.0.1, so what is checked is the wire: the parent is offered
one `delegate` tool whose description lists the specialists; the child
request carries the specialist's role and only its tools; the child's
`run_command` really runs in the project directory; the child's last
message comes back to the parent bounded and delimited as data; the
child's calls land on the parent's ledger.

No key, no network: the "API" is an aiohttp server the test owns, and the
project is a temporary Python project so its allowlist lets `python` run.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

aiohttp = pytest.importorskip("aiohttp")
from aiohttp import web  # noqa: E402

CONCLUSION = {
    "conclusion": "3 passed, 0 failed",
    "files": ["tests/test_x.py"],
    "evidence": ["3 passed in 0.01s"],
}


def _python_command(script: str) -> str:
    args = [sys.executable, "-c", script]
    return subprocess.list2cmdline(args) if os.name == "nt" else shlex.join(args)


def _reply(text: str | None = None, calls: list[dict[str, Any]] | None = None):
    message: dict[str, Any] = {"role": "assistant", "content": text or ""}
    if calls:
        message["tool_calls"] = [
            {
                "id": f"call_{i}",
                "type": "function",
                "function": {"name": c["name"], "arguments": json.dumps(c["args"])},
            }
            for i, c in enumerate(calls)
        ]
    return {
        "choices": [
            {"message": message, "finish_reason": "tool_calls" if calls else "stop"}
        ],
        "usage": {"prompt_tokens": 100, "completion_tokens": 10},
    }


class ScriptedServer:
    """Answers each chat completion from what the request contains."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []

    async def handle(self, request: web.Request) -> web.Response:
        payload = await request.json()
        self.requests.append(payload)
        messages = payload["messages"]
        system = messages[0]["content"] if messages[0]["role"] == "system" else ""
        tool_names = [t["function"]["name"] for t in payload.get("tools", [])]
        last = messages[-1]

        if "You are a sub-agent" in system:
            # The child. First ask for the command, then conclude.
            if last["role"] == "tool":
                assert "3 passed" in last["content"]
                return web.json_response(_reply(json.dumps(CONCLUSION)))
            return web.json_response(
                _reply(
                    calls=[
                        {
                            "name": "run_command",
                            "args": {
                                "command": _python_command("print('3 passed in 0.01s')")
                            },
                        }
                    ]
                )
            )

        # The parent. Delegate once, then finish.
        if last["role"] == "tool":
            return web.json_response(_reply("Tests pass; done."))
        assert "delegate" in tool_names
        return web.json_response(
            _reply(
                calls=[
                    {
                        "name": "delegate",
                        "args": {
                            "agent": "test-runner",
                            "task": "Run the test suite and report the counts.",
                        },
                    }
                ]
            )
        )


@pytest.fixture
async def endpoint():
    server = ScriptedServer()
    app = web.Application()
    app.router.add_post("/v1/chat/completions", server.handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # noqa: SLF001
    try:
        yield server, f"http://127.0.0.1:{port}/v1/chat/completions"
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_a_delegation_runs_as_a_child_session_on_the_same_endpoint(
    endpoint, tmp_path: Path, monkeypatch
):
    server, url = endpoint
    project = tmp_path / "project"
    project.mkdir()
    (project / "pyproject.toml").write_text("[project]\nname = 'x'\n", encoding="utf-8")
    spec = tmp_path / "spec"
    spec.mkdir()

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-0000")
    monkeypatch.setenv("OPENAI_AUTH_MODE", "api-key")

    from core.client import create_agent_client

    client = create_agent_client(
        project_dir=project,
        spec_dir=spec,
        model="gpt-4o",
        agent_type="coder",
        provider="openai",
    )
    client._api_base = url
    assert client.delegates()
    assert "test-runner" in client.agents

    texts: list[str] = []
    async with client:
        await client.query("Make sure the tests pass.")
        async for message in client.receive_response():
            for block in message.content:
                if getattr(block, "text", None):
                    texts.append(block.text)

    # Four calls on the wire: parent, child, child, parent.
    assert len(server.requests) == 4
    parent1, child1, child2, parent2 = server.requests

    # The parent was offered one `delegate` tool that names the roster.
    delegate = next(
        t["function"] for t in parent1["tools"] if t["function"]["name"] == "delegate"
    )
    assert "test-runner" in delegate["description"]
    assert delegate["parameters"]["properties"]["agent"]["enum"] == sorted(
        client.agents
    )

    # The child carried the specialist's role and its tools, nothing else.
    assert "You are a sub-agent" in child1["messages"][0]["content"]
    assert "test execution specialist" in child1["messages"][0]["content"]
    assert (
        child1["messages"][-1]["content"] == "Run the test suite and report the counts."
    )
    child_tools = {t["function"]["name"] for t in child1["tools"]}
    assert "run_command" in child_tools and "read_file" in child_tools
    assert "delegate" not in child_tools
    assert "write_file" not in child_tools

    # The command really ran, and its output reached the child.
    assert child2["messages"][-1]["role"] == "tool"
    assert "3 passed in 0.01s" in child2["messages"][-1]["content"]

    # The parent read the child's conclusion as data, and nothing of its work.
    result = parent2["messages"][-1]
    assert result["role"] == "tool"
    assert "3 passed, 0 failed" in result["content"]
    assert (
        "<user_content>" in result["content"] or "subagent_result" in result["content"]
    )
    assert "print('3 passed" not in result["content"]
    assert texts[-1] == "Tests pass; done."

    # The child's calls were recorded on the parent's ledger.
    ledger = client.usage_ledger
    assert ledger is not None
    assert len(ledger.calls) == 4
    assert len(ledger.returns) == 1
