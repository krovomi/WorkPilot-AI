"""What a session is told about its sandbox, and when it is refused a start."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import os_sandbox
import pytest
from os_sandbox.launch import ISOLATED, UNAVAILABLE, SandboxStatus


@pytest.fixture
def unavailable(monkeypatch):
    monkeypatch.setattr(
        os_sandbox,
        "probe",
        lambda: SandboxStatus(UNAVAILABLE, "bubblewrap", "bwrap is not installed"),
    )


@pytest.fixture
def available(monkeypatch):
    monkeypatch.setattr(
        os_sandbox, "probe", lambda: SandboxStatus(ISOLATED, "bubblewrap")
    )


def test_off_is_off_and_says_so(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKPILOT_SANDBOX", "off")
    sandbox = os_sandbox.session_sandbox(tmp_path)
    assert sandbox.state == os_sandbox.OFF
    assert "NOT isolated" in sandbox.summary()
    assert sandbox.wrap(["true"], {"A": "1"}) == (["true"], {"A": "1"})


def test_auto_without_a_sandbox_runs_and_says_why(tmp_path, monkeypatch, unavailable):
    monkeypatch.setenv("WORKPILOT_SANDBOX", "auto")
    sandbox = os_sandbox.session_sandbox(tmp_path)
    assert sandbox.state == UNAVAILABLE
    assert sandbox.summary() == "commands are NOT isolated: bwrap is not installed"
    assert not sandbox.isolated


def test_required_without_a_sandbox_does_not_start(tmp_path, monkeypatch, unavailable):
    monkeypatch.setenv("WORKPILOT_SANDBOX", "required")
    with pytest.raises(os_sandbox.SandboxRequiredError, match="bwrap is not installed"):
        os_sandbox.session_sandbox(tmp_path)


def test_a_cli_without_a_profile_is_not_wrapped_even_when_the_machine_can(
    tmp_path, monkeypatch, available
):
    monkeypatch.setenv("WORKPILOT_SANDBOX", "auto")
    sandbox = os_sandbox.session_sandbox(
        tmp_path, unavailable_reason="Antigravity has no profile"
    )
    assert (
        sandbox.state == UNAVAILABLE and sandbox.reason == "Antigravity has no profile"
    )
    monkeypatch.setenv("WORKPILOT_SANDBOX", "required")
    with pytest.raises(os_sandbox.SandboxRequiredError):
        os_sandbox.session_sandbox(
            tmp_path, unavailable_reason="Antigravity has no profile"
        )


def test_an_unknown_mode_is_auto(monkeypatch):
    monkeypatch.setenv("WORKPILOT_SANDBOX", "yes please")
    assert os_sandbox.sandbox_mode() == "auto"


def test_the_launch_is_reported_once_per_build_provider_and_state(tmp_path, capsys):
    spec = tmp_path / "spec"
    spec.mkdir()
    sandbox = os_sandbox.SessionSandbox(
        UNAVAILABLE, "bubblewrap", "bwrap is not installed"
    )
    from core import client as factory

    factory._report_sandbox(spec, "openai", sandbox)
    factory._report_sandbox(spec, "openai", sandbox)
    events = [
        json.loads(line.split(":", 1)[1])
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("__TASK_EVENT__:")
    ]
    sandbox_events = [e for e in events if e["type"] == "SANDBOX_STATUS"]
    assert len(sandbox_events) == 1
    assert sandbox_events[0]["sandbox"] == {
        "provider": "openai",
        "state": UNAVAILABLE,
        "backend": "bubblewrap",
        "reason": "bwrap is not installed",
        "network": [],
    }


class _Client:
    def __init__(self, name: str, sandbox=None):
        self._name = name
        self._sandbox = sandbox

    def provider_name(self) -> str:
        return self._name


def test_launch_asks_each_kind_of_client_its_own_way(
    tmp_path, monkeypatch, unavailable
):
    from core import client as factory

    seen = []
    monkeypatch.setattr(
        factory,
        "_report_sandbox",
        lambda spec, provider, sb: seen.append((provider, sb)),
    )
    monkeypatch.setattr(
        os_sandbox,
        "claude_code_status",
        lambda: os_sandbox.delegated_status("Claude Code"),
    )
    monkeypatch.setenv("WORKPILOT_SANDBOX", "auto")

    ClaudeAgentClient = type("ClaudeAgentClient", (_Client,), {})
    CodexCliAgentClient = type("CodexCliAgentClient", (_Client,), {})

    class Cli(_Client):
        def session_sandbox(self, spec_dir=None):
            return os_sandbox.SessionSandbox(UNAVAILABLE, None, "no profile")

    factory._sandbox_at_launch(ClaudeAgentClient("claude"), tmp_path, tmp_path)
    factory._sandbox_at_launch(CodexCliAgentClient("openai"), tmp_path, tmp_path)
    factory._sandbox_at_launch(Cli("antigravity"), tmp_path, tmp_path)
    factory._sandbox_at_launch(_Client("google"), tmp_path, tmp_path)
    assert [(p, sb.state, sb.backend) for p, sb in seen] == [
        ("claude", os_sandbox.DELEGATED, "Claude Code"),
        ("openai", os_sandbox.DELEGATED, "Codex CLI"),
        ("antigravity", UNAVAILABLE, None),
        ("google", UNAVAILABLE, "bubblewrap"),
    ]


def test_launch_refuses_a_session_under_required(tmp_path, monkeypatch, unavailable):
    from core import client as factory

    monkeypatch.setenv("WORKPILOT_SANDBOX", "required")
    with pytest.raises(os_sandbox.SandboxRequiredError):
        factory._sandbox_at_launch(_Client("google"), tmp_path, tmp_path)


def test_claude_code_needs_socat_on_linux(monkeypatch, available):
    import foundation.platform as platform

    monkeypatch.setattr(platform, "is_windows", lambda: False)
    monkeypatch.setattr(platform, "is_linux", lambda: True)
    monkeypatch.setattr(platform, "find_executable", lambda name, *a, **k: None)
    monkeypatch.setattr("shutil.which", lambda name, *a, **k: None)
    monkeypatch.setenv("WORKPILOT_SANDBOX", "auto")
    status = os_sandbox.claude_code_status()
    assert status.state == UNAVAILABLE and "socat" in (status.reason or "")


class _Process:
    returncode = 0

    def __init__(self):
        self.stdin = None


async def _capture_spawn(client, command):
    seen = {}

    async def factory(*argv, **kwargs):
        seen["argv"] = list(argv)
        seen["env"] = kwargs.get("env")
        raise OSError("stop here")

    client._process_factory = factory
    with pytest.raises(OSError):
        await client._spawn(command, b"")
    return seen


class _Wrapping(os_sandbox.SessionSandbox):
    def wrap(self, argv, env, *, cwd=None):
        return ["SANDBOX", "--", *argv], {**env, "SANDBOXED": "1"}


def test_a_cli_process_is_started_through_its_sandbox(tmp_path, monkeypatch):
    from core.agent_clients.opencode_cli import OpenCodeCliAgentClient

    captured = {}

    def fake_session_sandbox(project_dir, spec_dir=None, **kwargs):
        captured.update(kwargs)
        return _Wrapping(ISOLATED, "bubblewrap")

    monkeypatch.setattr(os_sandbox, "session_sandbox", fake_session_sandbox)
    client = OpenCodeCliAgentClient(
        model="anthropic/claude",
        system_prompt=None,
        project_dir=str(tmp_path),
        agent_type="coder",
    )
    seen = asyncio.run(_capture_spawn(client, ["opencode", "run"]))
    assert seen["argv"] == ["SANDBOX", "--", "opencode", "run"]
    assert seen["env"]["SANDBOXED"] == "1"
    # Its profile from providers.yaml: its own state and its hosts.
    assert "~/.config/opencode" in captured["state_dirs"]
    # Compared as a set of host names (not a substring of a URL).
    assert {"api.anthropic.com"} <= set(captured["provider_hosts"])
    assert captured["unavailable_reason"] is None


def test_a_cli_without_a_profile_says_so(tmp_path, monkeypatch, available):
    from core.agent_clients.antigravity_cli import AntigravityCliAgentClient

    monkeypatch.setenv("WORKPILOT_SANDBOX", "auto")
    client = AntigravityCliAgentClient(
        model=None, system_prompt=None, project_dir=str(tmp_path), agent_type="coder"
    )
    sandbox = client.session_sandbox()
    assert sandbox.state == UNAVAILABLE
    assert "no sandbox profile" in (sandbox.reason or "")
    assert Path(client._project_dir) == tmp_path
