"""A custom MCP server that must run confined (issue #369, lot 5).

``confine: {"hosts": [...]}`` on a command server: whichever provider starts
it, it starts under the OS sandbox with only those hosts (and its launcher's
registry) on the network, or it does not start. The field never widens what
the validator accepts. The sandbox itself is faked here (no bubblewrap
needed); `tests/os_sandbox/test_real_sandbox.py` runs the real one.
"""

from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack
from pathlib import Path

import core.mcp_confinement as confinement
import pytest
from core.cli_mcp import cli_mcp_servers, codex_mcp_overrides
from core.custom_mcp_validation import validate_custom_mcp_server
from core.mcp_confinement import (
    CONFINED_MARK,
    MAX_CONFINE_HOSTS,
    confine_hosts,
    confined_launch,
    confined_server,
    valid_confine,
)
from mcp_pins import Verdict
from os_sandbox import launch
from os_sandbox.launch import ISOLATED, UNAVAILABLE, SandboxStatus

SENTRY = {
    "id": "sentry",
    "name": "Sentry",
    "type": "command",
    "command": "npx",
    "args": ["-y", "@sentry/mcp-server@1.2.3"],
    "env": {"SENTRY_ACCESS_TOKEN": "sntrys-test-0000"},  # pragma: allowlist secret
    "confine": {"hosts": ["sentry.io", "*.sentry.io"]},
}
PLAIN = {k: v for k, v in SENTRY.items() if k != "confine"}


class _Proxy:
    def __init__(self, socket_path: Path):
        self.socket_path = socket_path
        self.port = 0


@pytest.fixture
def sandbox(monkeypatch, tmp_path):
    """A machine that can sandbox: the probe says so, the proxy is a double."""
    asked: dict = {}

    def shared(allowlist, *, unix_dir):
        asked["allowlist"] = allowlist
        return _Proxy(tmp_path / "proxy.sock")

    monkeypatch.delenv("WORKPILOT_SANDBOX", raising=False)
    monkeypatch.setattr(launch, "probe", lambda: SandboxStatus(ISOLATED, "bubblewrap"))
    monkeypatch.setattr(launch, "shared_proxy", shared)
    monkeypatch.setattr(launch, "_bwrap", lambda: "/usr/bin/bwrap")
    project = tmp_path / "project"
    project.mkdir()
    asked["project"] = project
    return asked


# ---------------------------------------------------------------------------
# the field


@pytest.mark.parametrize(
    "confine",
    [
        {"hosts": []},
        {"hosts": ["api.example.com", "*.example.org", "127.0.0.1:5432"]},
        {"hosts": ["10.0.0.7", "localhost:8080"]},
    ],
)
def test_a_well_formed_confine_is_accepted(confine):
    server = {**PLAIN, "confine": confine}
    assert valid_confine(server)
    assert validate_custom_mcp_server(server)


@pytest.mark.parametrize(
    "confine",
    [
        None,
        "sentry.io",
        ["sentry.io"],
        {},
        {"hosts": "sentry.io"},
        {"hosts": ["sentry.io"], "ports": [22]},
        {"hosts": [7]},
        {"hosts": [""]},
        {"hosts": ["*.com"]},
        {"hosts": ["localhost"]},
        {"hosts": ["127.0.0.1"]},
        {"hosts": ["example.com:22"]},
        {"hosts": ["*.example.com:443"]},
        {"hosts": ["exa mple.com"]},
        {"hosts": ["a" * 300]},
        {"hosts": [f"h{i}.example.com" for i in range(MAX_CONFINE_HOSTS + 1)]},
    ],
)
def test_a_malformed_confine_refuses_the_server(confine):
    server = {**PLAIN, "confine": confine}
    assert not valid_confine(server)
    assert not validate_custom_mcp_server(server)


def test_an_http_server_cannot_be_confined():
    remote = {
        "id": "remote",
        "name": "Remote",
        "type": "http",
        "url": "https://mcp.example.com/mcp",
        "confine": {"hosts": []},
    }
    assert not validate_custom_mcp_server(remote)


@pytest.mark.parametrize(
    "change",
    [
        {"command": "bash"},
        {"command": "/usr/bin/npx"},
        {"command": "curl"},
        {"args": ["-e", "require('child_process')"]},
        {"args": ["--require", "./evil.js"]},
        {"env": {"NODE_OPTIONS": "--require ./evil.js"}},
        {"env": {"LD_PRELOAD": "/tmp/x.so"}},
    ],
)
def test_confine_never_widens_the_launcher_or_the_refused_options(change):
    assert not validate_custom_mcp_server({**SENTRY, **change})


def test_a_server_without_confine_is_unchanged_by_the_check():
    assert valid_confine(PLAIN)
    assert validate_custom_mcp_server(PLAIN)


def test_the_hosts_of_a_server():
    assert confine_hosts(SENTRY) == ["sentry.io", "*.sentry.io"]
    assert confine_hosts(PLAIN) is None
    assert confine_hosts({**PLAIN, "confine": {"hosts": "x"}}) == []


# ---------------------------------------------------------------------------
# the launch


def test_an_unconfined_server_starts_as_written():
    assert confined_launch(PLAIN, "npx", ["-y", "pkg"], None) == ("npx", ["-y", "pkg"])
    copy = confined_server(PLAIN, None)
    assert copy == PLAIN and copy is not PLAIN


def test_a_confined_server_starts_under_the_sandbox(sandbox, monkeypatch):
    monkeypatch.setenv("WORKPILOT_SANDBOX_HOSTS", "mirror.corp.example")

    command, args = confined_launch(
        SENTRY, "npx", list(SENTRY["args"]), sandbox["project"]
    )

    assert command == "/usr/bin/env"
    assert "HTTPS_PROXY=http://127.0.0.1:18080" in args
    assert any(a.startswith("TMPDIR=") for a in args)
    assert "/usr/bin/bwrap" in args and "--unshare-net" in args
    assert args[-3:] == ["npx", "-y", "@sentry/mcp-server@1.2.3"]
    # The server's own secret never reaches a command line.
    assert not any("sntrys-test-0000" in a for a in args)
    # Its hosts and its launcher's registry; the person's global list is not added.
    assert sandbox["allowlist"].describe() == [
        "sentry.io",
        "*.sentry.io",
        "registry.npmjs.org",
    ]


def test_a_launcher_without_a_registry_gets_only_the_listed_hosts(sandbox):
    server = {**SENTRY, "command": "node", "args": ["server.js"]}
    confined_launch(server, "node", ["server.js"], sandbox["project"])
    assert sandbox["allowlist"].describe() == ["sentry.io", "*.sentry.io"]

    uvx = {**SENTRY, "command": "uvx", "confine": {"hosts": []}}
    confined_launch(uvx, "uvx", ["mcp-server-time"], sandbox["project"])
    assert sandbox["allowlist"].describe() == ["pypi.org", "files.pythonhosted.org"]


def test_a_confined_server_without_a_project_does_not_start(sandbox, caplog):
    assert confined_launch(SENTRY, "npx", [], None) is None
    assert "no project to confine it to" in caplog.text


def test_a_confined_server_does_not_start_with_the_sandbox_off(
    sandbox, monkeypatch, caplog
):
    monkeypatch.setenv("WORKPILOT_SANDBOX", "off")
    assert confined_launch(SENTRY, "npx", [], sandbox["project"]) is None
    assert "WORKPILOT_SANDBOX=off" in caplog.text


def test_a_confined_server_does_not_start_without_a_sandbox(
    sandbox, monkeypatch, caplog
):
    monkeypatch.setattr(
        launch,
        "probe",
        lambda: SandboxStatus(UNAVAILABLE, None, "no OS sandbox on Windows yet"),
    )
    assert confined_launch(SENTRY, "npx", [], sandbox["project"]) is None
    assert "no OS sandbox on Windows yet" in caplog.text

    monkeypatch.setattr(launch, "probe", lambda: SandboxStatus(UNAVAILABLE, None))
    assert confined_launch(SENTRY, "npx", [], sandbox["project"]) is None
    assert "this machine has no OS sandbox" in caplog.text


def test_a_sandbox_that_cannot_be_prepared_starts_nothing(sandbox, monkeypatch, caplog):
    def broken(*_args, **_kwargs):
        raise OSError("scratch dir is read-only")

    monkeypatch.setattr(launch, "sandboxed", broken)
    assert confined_launch(SENTRY, "npx", [], sandbox["project"]) is None
    assert "scratch dir is read-only" in caplog.text


def test_a_cli_gets_the_wrapped_server_with_its_mark(sandbox):
    wrapped = confined_server(SENTRY, sandbox["project"])
    assert wrapped is not None
    assert "confine" not in wrapped and wrapped[CONFINED_MARK] is True
    assert wrapped["command"] == "/usr/bin/env"
    assert wrapped["env"] == SENTRY["env"]
    assert confined_server(SENTRY, None) is None


# ---------------------------------------------------------------------------
# every path that starts a server


def test_the_sdk_entries_are_wrapped_or_left_out(sandbox, monkeypatch):
    import core.mcp_pinning as pinning

    other = {**SENTRY, "id": "other", "name": "Other"}
    remote = {"id": "remote", "name": "R", "type": "http", "url": "https://x.io/mcp"}
    monkeypatch.setattr(
        pinning,
        "pin_verdicts",
        lambda project_dir, probed: {
            str(c["id"]): Verdict(str(c["id"]), "approved") for c, _ in probed
        },
    )
    monkeypatch.setattr(pinning, "probe_tools", lambda project_dir, cfg: [])
    mcp_config = {"CUSTOM_MCP_SERVERS": [SENTRY, PLAIN | {"id": "plain"}, remote]}
    servers = pinning.custom_servers({"sentry", "plain", "remote"}, mcp_config)

    out = pinning.pinned_servers(sandbox["project"], servers, mcp_config)

    assert out["sentry"]["command"] == "/usr/bin/env"
    assert out["sentry"]["env"] == SENTRY["env"]
    assert out["plain"] == {
        "command": "npx",
        "args": PLAIN["args"],
        "env": PLAIN["env"],
    }
    assert out["remote"] == {"type": "http", "url": "https://x.io/mcp"}

    monkeypatch.setenv("WORKPILOT_SANDBOX", "off")
    mcp_config["CUSTOM_MCP_SERVERS"].append(other)
    servers = pinning.custom_servers({"sentry", "other"}, mcp_config)
    assert pinning.pinned_servers(sandbox["project"], servers, mcp_config) == {}


def test_the_workpilot_loop_starts_it_wrapped_or_not_at_all(monkeypatch, tmp_path):
    import mcp.client.stdio as stdio
    from core.mcp_tools import MCPToolManager

    started: list = []

    def stdio_client(params):
        started.append(params)
        raise OSError("not really started")

    monkeypatch.setattr(stdio, "stdio_client", stdio_client)

    async def open_one(project_dir):
        manager = MCPToolManager(project_dir, [SENTRY], pin=False)
        manager._stack = AsyncExitStack()
        try:
            await manager._open_session(SENTRY)
        finally:
            await manager._stack.aclose()

    with pytest.raises(RuntimeError, match="must run confined"):
        asyncio.run(open_one(None))
    assert started == []

    monkeypatch.setattr(
        confinement,
        "confined_launch",
        lambda server, command, args, project_dir: ("/usr/bin/env", ["X=1", command]),
    )
    with pytest.raises(OSError, match="not really started"):
        asyncio.run(open_one(str(tmp_path)))
    assert started[0].command == "/usr/bin/env" and started[0].args == ["X=1", "npx"]


def test_the_pin_probe_starts_it_in_its_project(monkeypatch, tmp_path):
    import core.mcp_pinning as pinning
    import core.mcp_tools as mcp_tools

    seen: list = []

    class Manager:
        def __init__(self, project_dir, servers, **kwargs):
            seen.append((project_dir, servers, kwargs))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        def listed(self):
            return {"sentry": []}

    monkeypatch.setattr(mcp_tools, "MCPToolManager", Manager)
    assert asyncio.run(pinning._list(SENTRY, tmp_path)) == []
    assert seen == [(str(tmp_path), [SENTRY], {"pin": False})]


def test_the_probe_hands_its_project_to_the_listing(monkeypatch, tmp_path):
    import core.mcp_pinning as pinning

    seen: list = []

    async def listing(cfg, project_dir):
        seen.append(project_dir)
        return []

    monkeypatch.setattr(pinning, "_list", listing)
    pinning._reset_probe_cache()
    try:
        assert pinning.probe_tools(tmp_path, SENTRY) == []
    finally:
        pinning._reset_probe_cache()
    assert seen == [tmp_path]


def test_the_app_view_session_keeps_confine_and_the_project(monkeypatch, tmp_path):
    import core.mcp_tools as mcp_tools

    seen: list = []

    class Manager:
        def __init__(self, project_dir, servers, **kwargs):
            seen.append((project_dir, servers))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        def connected(self):
            return False

    monkeypatch.setattr(mcp_tools, "MCPToolManager", Manager)
    for project, expected in ((tmp_path, str(tmp_path)), (None, None)):
        hook = mcp_tools.make_app_view_hook(tmp_path / "spec", [SENTRY], project)
        asyncio.run(hook({"tool_name": "mcp__sentry__search", "tool_input": {}}))
        assert seen[-1][0] == expected
        assert seen[-1][1][0]["confine"] == SENTRY["confine"]


def test_a_cli_gets_a_confined_server_wrapped_or_not_at_all(sandbox, monkeypatch):
    import core.mcp_pinning as pinning
    import core.mcp_tools as mcp_tools

    monkeypatch.setattr(
        mcp_tools,
        "load_mcp_server_configs_for",
        lambda agent_type, project_dir, spec_dir=None: [SENTRY, PLAIN | {"id": "p"}],
    )
    monkeypatch.setattr(pinning, "probe_tools", lambda project_dir, cfg: [])
    monkeypatch.setattr(
        pinning,
        "pin_verdicts",
        lambda project_dir, probed: {
            "sentry": Verdict("sentry", "approved"),
            "p": Verdict("p", "approved"),
        },
    )
    servers = cli_mcp_servers("coder", sandbox["project"])
    assert [s["id"] for s in servers] == ["sentry", "p"]
    assert servers[0][CONFINED_MARK] is True and servers[1] == PLAIN | {"id": "p"}

    monkeypatch.setenv("WORKPILOT_SANDBOX", "off")
    assert [s["id"] for s in cli_mcp_servers("coder", sandbox["project"])] == ["p"]


def test_codex_quotes_a_confined_launcher_whole(monkeypatch):
    import foundation.platform as platform

    confined = {
        **PLAIN,
        CONFINED_MARK: True,
        "command": "/usr/bin/env",
        "args": ["TMPDIR=/tmp/work pilot/x", "--", 'say "hi"\n'],
        "env": {},
    }
    monkeypatch.setattr(platform, "is_windows", lambda: False)
    args, _env = codex_mcp_overrides([confined])
    assert args[1::2] == [
        'mcp_servers.sentry.command="/usr/bin/env"',
        'mcp_servers.sentry.args=["TMPDIR=/tmp/work pilot/x","--","say \\"hi\\"\\n"]',
    ]
    # Unmarked, the same words are not plain: left out as before.
    assert codex_mcp_overrides([{**confined, CONFINED_MARK: False}]) == ([], {})
    # No sandbox on Windows, so a marked server there is refused too.
    monkeypatch.setattr(platform, "is_windows", lambda: True)
    assert codex_mcp_overrides([confined]) == ([], {})
