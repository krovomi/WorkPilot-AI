"""An agent CLI in the task's microVM: when it goes there, and how it starts."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import os_sandbox
import pytest
from core.agent_clients import cli_microvm
from core.agent_clients.opencode_cli import OpenCodeCliAgentClient
from os_sandbox import microvm
from os_sandbox.launch import ISOLATED, SandboxStatus
from skills_registry.providers import (
    MicrovmSpec,
    SandboxSpec,
    _parse_microvm,
    get_provider_capabilities,
)

CLI_ON = json.dumps({"sandbox": {"microvm": {"enabled": True, "cliAgents": True}}})
VM_ONLY = json.dumps({"sandbox": {"microvm": {"enabled": True}}})

PROFILE = SandboxSpec(
    microvm=MicrovmSpec(
        command="opencode",
        install="npm install -g opencode-ai@latest",
        secrets=(
            ("anthropic", ("ANTHROPIC_API_KEY",)),
            ("google", ("GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY")),
        ),
    )
)


@pytest.fixture
def sbx_ready(monkeypatch):
    monkeypatch.setenv("WORKPILOT_AGENT_SAFETY", CLI_ON)
    monkeypatch.setattr(
        microvm, "probe_microvm", lambda: SandboxStatus(ISOLATED, microvm.BACKEND)
    )
    stored: set[str] = set()
    monkeypatch.setattr(microvm, "secret_services", lambda: frozenset(stored))
    return stored


# ── providers.yaml ───────────────────────────────────────────────────────


def test_opencode_has_a_microvm_profile():
    spec = get_provider_capabilities("opencode").sandbox
    assert spec is not None and spec.microvm is not None
    assert spec.microvm.command == "opencode"
    assert dict(spec.microvm.secrets)["openai"] == ("OPENAI_API_KEY",)


@pytest.mark.parametrize(
    "raw",
    [
        {"command": "rm -rf /", "install": "x"},
        {"command": "opencode", "install": "a\nb"},
        {"command": "opencode", "install": "x", "secrets": {"vault": ["X"]}},
        {"command": "opencode", "install": "x", "secrets": {"openai": ["lower"]}},
        {"command": "opencode", "install": "x", "secrets": {"openai": []}},
    ],
)
def test_a_bad_microvm_profile_is_refused(raw):
    with pytest.raises(ValueError):
        _parse_microvm("opencode", raw)


# ── The plan ─────────────────────────────────────────────────────────────


def test_off_unless_both_switches_are_on(monkeypatch, sbx_ready):
    sbx_ready.add("anthropic")
    monkeypatch.setenv("WORKPILOT_AGENT_SAFETY", VM_ONLY)
    assert cli_microvm.plan(PROFILE, "OpenCode", None) == (None, None)
    monkeypatch.delenv("WORKPILOT_AGENT_SAFETY")
    assert cli_microvm.plan(PROFILE, "OpenCode", None) == (None, None)


def test_a_cli_without_a_profile_stays_on_the_host_and_says_why(sbx_ready):
    how, why = cli_microvm.plan(SandboxSpec(), "Gemini CLI", None)
    assert how is None and "no microVM profile" in why


def test_without_a_key_in_sbx_the_cli_stays_on_the_host(sbx_ready):
    how, why = cli_microvm.plan(PROFILE, "OpenCode", None)
    assert how is None
    assert "no key stored in sbx" in why and "sbx secret set" in why


def test_with_a_key_in_sbx_the_cli_gets_only_placeholders(sbx_ready):
    sbx_ready.update({"google", "openai"})
    how, why = cli_microvm.plan(PROFILE, "OpenCode", None)
    assert why is None
    assert how.variables == ("GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY")


def test_the_models_provider_must_have_its_key(sbx_ready):
    sbx_ready.add("google")
    services = ("anthropic", "google")
    assert cli_microvm.model_service("anthropic/claude-x", services) == "anthropic"
    assert cli_microvm.model_service("ollama/qwen", services) == ""
    assert cli_microvm.model_service(None, services) is None
    how, why = cli_microvm.plan(PROFILE, "OpenCode", "anthropic")
    assert how is None and "(anthropic)" in why
    how, why = cli_microvm.plan(PROFILE, "OpenCode", "")
    assert how is None and "not signed by a key" in why


def test_sbx_not_ready_keeps_the_cli_on_the_host(monkeypatch, sbx_ready):
    monkeypatch.setattr(
        microvm,
        "probe_microvm",
        lambda: SandboxStatus("unavailable", microvm.BACKEND, "not signed in"),
    )
    assert cli_microvm.plan(PROFILE, "OpenCode", None) == (None, "not signed in")


# ── Opening the session ──────────────────────────────────────────────────


class _Vm:
    name = "workpilot-x"

    def target_of(self, path):
        return "/vm" + Path(path).as_posix()


def _opener(calls, *, with_vm=True):
    def open_sandbox(*, microvm):
        calls.append(microvm)
        vm = _Vm() if microvm and with_vm else None
        return os_sandbox.SessionSandbox(ISOLATED, "x", None, object(), vm=vm)

    return open_sandbox


def test_the_cli_is_installed_then_run_in_the_vm(monkeypatch, sbx_ready):
    sbx_ready.add("anthropic")
    installed = []
    monkeypatch.setattr(
        microvm, "ensure_tool", lambda vm, command, install: installed.append(command)
    )
    calls: list[bool] = []
    sandbox, how = cli_microvm.open_session(_opener(calls), PROFILE, "OpenCode", None)
    assert calls == [True] and installed == ["opencode"]
    assert how is not None and sandbox.vm is not None


def test_a_failed_install_falls_back_to_the_os_sandbox_and_says_why(
    monkeypatch, sbx_ready
):
    sbx_ready.add("anthropic")

    def broken(vm, command, install):
        raise microvm.MicrovmError("npm: not found")

    monkeypatch.setattr(microvm, "ensure_tool", broken)
    calls: list[bool] = []
    sandbox, how = cli_microvm.open_session(_opener(calls), PROFILE, "OpenCode", None)
    assert calls == [True, False] and how is None
    assert "could not be installed" in sandbox.fallback_reason


def test_staying_on_the_host_is_said_on_the_card(sbx_ready):
    calls: list[bool] = []
    sandbox, how = cli_microvm.open_session(_opener(calls), PROFILE, "OpenCode", None)
    assert calls == [False] and how is None
    assert "no key stored in sbx" in sandbox.fallback_reason
    assert "not used" in sandbox.summary()


def test_off_changes_nothing(monkeypatch):
    monkeypatch.delenv("WORKPILOT_AGENT_SAFETY", raising=False)
    calls: list[bool] = []
    sandbox, how = cli_microvm.open_session(_opener(calls), PROFILE, "OpenCode", None)
    assert calls == [False] and how is None and sandbox.fallback_reason is None


# ── The process ──────────────────────────────────────────────────────────


class _VmSandbox(os_sandbox.SessionSandbox):
    def wrap(self, argv, env, *, cwd=None, stdin=False, vm_env=None):
        return ["SBX", f"stdin={stdin}", json.dumps(vm_env), *argv], {"PATH": "x"}


def test_opencode_starts_in_the_vm_without_a_host_key(tmp_path, monkeypatch):
    how = cli_microvm.CliVm("opencode", "install", ("ANTHROPIC_API_KEY",))
    sandbox = _VmSandbox(ISOLATED, "microvm", None, object(), vm=_Vm())
    monkeypatch.setattr(
        cli_microvm,
        "open_session",
        lambda open_sandbox, spec, label, model: (sandbox, how),
    )
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-0000")
    client = OpenCodeCliAgentClient(
        model="anthropic/claude",
        system_prompt=None,
        project_dir=str(tmp_path),
        agent_type="coder",
    )
    client._mcp_servers = None
    monkeypatch.setattr(
        "core.cli_mcp.cli_mcp_servers", lambda *a: [{"id": "db", "type": "stdio"}]
    )
    assert asyncio.run(client.custom_mcp_servers()) == []
    assert client.runs_in_microvm()
    argv, env = client._launch([r"C:\npm\opencode.cmd", "run", "--format", "json"])
    assert argv[:2] == ["SBX", "stdin=True"]
    vm_env = json.loads(argv[2])
    assert vm_env["ANTHROPIC_API_KEY"] == "proxy-managed"
    assert vm_env["PWD"].startswith("/vm")
    assert argv[3:] == ["opencode", "run", "--format", "json"]
    assert not any("sk-test-0000" in part for part in argv)
