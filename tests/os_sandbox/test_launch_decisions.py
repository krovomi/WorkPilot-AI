"""How the sandbox is probed, built and wrapped, on any machine.

`test_real_sandbox.py` runs commands under the real bubblewrap or Seatbelt and
is skipped where neither exists. This file checks the decisions around them
everywhere: what the probe concludes from each answer of `bwrap` or
`sandbox-exec`, the argv and Seatbelt profile built from a policy, what a
session wraps and reports. The OS checks and the probe's commands are
replaced; the proxy is a double that records what it was asked.
"""

from __future__ import annotations

import subprocess
import types
from dataclasses import replace
from pathlib import Path

import os_sandbox
import pytest
from os_sandbox import launch
from os_sandbox.hosts import HostAllowlist
from os_sandbox.launch import ISOLATED, UNAVAILABLE, SandboxStatus
from os_sandbox.policy import SandboxPolicy


@pytest.fixture
def os_is(monkeypatch):
    """Pretend to be one OS; the probe's cache is cleared around each test."""

    def pretend(name: str) -> None:
        monkeypatch.setattr(launch, "is_linux", lambda: name == "linux")
        monkeypatch.setattr(launch, "is_macos", lambda: name == "macos")
        monkeypatch.setattr(launch, "is_windows", lambda: name == "windows")

    launch.probe.cache_clear()
    yield pretend
    launch.probe.cache_clear()


def _answer(monkeypatch, *, code=0, stderr="", raises=None):
    seen = []

    def run(argv, **_kwargs):
        seen.append(argv)
        if raises is not None:
            raise raises
        return subprocess.CompletedProcess(argv, code, "", stderr)

    monkeypatch.setattr(launch.subprocess, "run", run)
    return seen


def a_policy(tmp_path: Path, **extra) -> SandboxPolicy:
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    policy = SandboxPolicy(
        writable=(work,),
        read_only=(work / ".git" / "hooks",),
        hidden=(tmp_path / "secrets",),
        allowlist=HostAllowlist.build(["api.example.com"]),
        tmp_dir=tmp_path / "tmp",
        cwd=work,
        hidden_files=(tmp_path / ".env",),
        readable=(tmp_path / "cli",),
    )
    return replace(policy, **extra)


# ---------------------------------------------------------------------------
# the probe


class TestProbe:
    def test_linux_without_bwrap_says_how_to_install_it(self, os_is, monkeypatch):
        os_is("linux")
        monkeypatch.setattr(launch, "_bwrap", lambda: None)
        monkeypatch.setattr(launch.shutil, "which", lambda tool: tool == "dnf")

        status = launch.probe()

        assert status == SandboxStatus(
            UNAVAILABLE,
            "bubblewrap",
            "bubblewrap (bwrap) is not installed: install it with "
            "`sudo dnf install bubblewrap`, then start the task again",
        )

    def test_bwrap_is_looked_up_like_any_tool_then_on_the_path(self, monkeypatch):
        monkeypatch.setattr(launch, "find_executable", lambda _name: None)
        monkeypatch.setattr(launch.shutil, "which", lambda name: f"/opt/{name}")

        assert launch._bwrap() == "/opt/bwrap"

    def test_no_known_package_manager_names_the_package(self, monkeypatch):
        monkeypatch.setattr(launch.shutil, "which", lambda _tool: None)

        assert launch.install_hint("socat") == (
            "install the socat package, then start the task again"
        )

    def test_linux_with_a_working_bwrap_is_isolated(self, os_is, monkeypatch):
        os_is("linux")
        monkeypatch.setattr(launch, "_bwrap", lambda: "/usr/bin/bwrap")
        seen = _answer(monkeypatch)

        assert launch.probe() == SandboxStatus(ISOLATED, "bubblewrap")
        assert seen[0][:4] == [
            "/usr/bin/bwrap",
            "--die-with-parent",
            "--unshare-net",
            "--unshare-pid",
        ]
        assert launch.probe() is launch.probe()  # probed once per process

    def test_a_kernel_that_refuses_namespaces_is_reported(self, os_is, monkeypatch):
        os_is("linux")
        monkeypatch.setattr(launch, "_bwrap", lambda: "/usr/bin/bwrap")
        _answer(
            monkeypatch, code=1, stderr="warning\nbwrap: setting up uid map: denied\n"
        )

        status = launch.probe()

        assert not status.available
        assert status.reason.endswith("bwrap: setting up uid map: denied")

    def test_a_refusal_without_detail_says_so(self, os_is, monkeypatch):
        os_is("linux")
        monkeypatch.setattr(launch, "_bwrap", lambda: "/usr/bin/bwrap")
        _answer(monkeypatch, code=1, stderr="")

        assert launch.probe().reason.endswith("no detail")

    def test_a_bwrap_that_hangs_is_unavailable(self, os_is, monkeypatch):
        os_is("linux")
        monkeypatch.setattr(launch, "_bwrap", lambda: "/usr/bin/bwrap")
        _answer(monkeypatch, raises=subprocess.TimeoutExpired("bwrap", 15))

        assert launch.probe().reason.startswith("bwrap did not run")

    def test_macos_without_sandbox_exec(self, os_is, monkeypatch, tmp_path):
        os_is("macos")
        monkeypatch.setattr(launch, "_SANDBOX_EXEC", str(tmp_path / "sandbox-exec"))

        assert launch.probe() == SandboxStatus(
            UNAVAILABLE, "seatbelt", "sandbox-exec is missing"
        )

    @pytest.mark.parametrize(
        ("answer", "expected"),
        [
            ({}, SandboxStatus(ISOLATED, "seatbelt")),
            (
                {"code": 65, "stderr": " sandbox_apply: Operation not permitted \n"},
                SandboxStatus(
                    UNAVAILABLE,
                    "seatbelt",
                    "sandbox-exec refused: sandbox_apply: Operation not permitted",
                ),
            ),
            (
                {"raises": OSError("exec format error")},
                SandboxStatus(
                    UNAVAILABLE,
                    "seatbelt",
                    "sandbox-exec did not run: exec format error",
                ),
            ),
        ],
    )
    def test_macos_runs_sandbox_exec_once(
        self, os_is, monkeypatch, tmp_path, answer, expected
    ):
        os_is("macos")
        tool = tmp_path / "sandbox-exec"
        tool.write_text("", encoding="utf-8")
        monkeypatch.setattr(launch, "_SANDBOX_EXEC", str(tool))
        _answer(monkeypatch, **answer)

        assert launch.probe() == expected

    def test_windows_has_no_sandbox_yet(self, os_is):
        os_is("windows")

        assert "no OS sandbox on Windows" in launch.probe().reason

    def test_another_platform_has_none(self, os_is):
        os_is("other")

        assert launch.probe() == SandboxStatus(
            UNAVAILABLE, None, "no OS sandbox for this platform"
        )


# ---------------------------------------------------------------------------
# what a policy becomes


class TestBuiltCommands:
    def test_bwrap_binds_follow_the_policy(self, tmp_path, monkeypatch):
        policy = a_policy(tmp_path)
        monkeypatch.setattr(launch.os.path, "exists", lambda p: p == "/run/docker.sock")
        monkeypatch.setattr(launch.os.path, "realpath", lambda p: p)
        socket_path = tmp_path / "proxy.sock"

        argv = launch.bwrap_argv("bwrap", policy, socket_path, ["npm", "test"])
        pairs = list(zip(argv, argv[1:], strict=False))

        work = str(tmp_path / "work")
        assert ("--bind", work) in pairs
        assert ("--ro-bind", str(tmp_path / "cli")) in pairs
        assert ("--tmpfs", str(tmp_path / "secrets")) in pairs
        assert argv[argv.index(str(tmp_path / ".env")) - 1] == "/dev/null"
        assert argv[argv.index("/run/docker.sock") - 1] == "/dev/null"
        assert argv[argv.index("--chdir") + 1] == work
        assert argv[-8:] == [
            launch.sys.executable,
            "-I",
            str(launch._BRIDGE),
            str(socket_path),
            str(launch.BRIDGE_PORT),
            "--",
            "npm",
            "test",
        ]

    def test_the_user_runtime_folder_is_hidden_behind_an_empty_one(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(launch.os, "getuid", lambda: 4242, raising=False)
        real_is_dir = Path.is_dir
        monkeypatch.setattr(
            Path,
            "is_dir",
            lambda self: self.as_posix() == "/run/user/4242" or real_is_dir(self),
        )

        argv = launch.bwrap_argv("bwrap", a_policy(tmp_path), tmp_path / "s", ["true"])

        runtime = str(Path("/run/user/4242"))
        assert argv[argv.index(runtime) - 1] == "--tmpfs"

    def test_the_seatbelt_profile_denies_writes_outside_the_policy(self, tmp_path):
        policy = a_policy(tmp_path)

        profile = launch.seatbelt_profile(policy)

        assert profile.startswith("(version 1)\n(allow default)\n(deny file-write*)")
        assert f'(subpath "{tmp_path / "work"}")' in profile
        assert "(deny network-outbound)" in profile
        assert f'(literal "{tmp_path / ".env"}")' in profile

    def test_a_profile_without_read_only_or_hidden_paths_has_no_such_rules(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(launch, "_ENGINE_SOCKETS", ())
        policy = a_policy(tmp_path, read_only=(), hidden=(), hidden_files=())

        profile = launch.seatbelt_profile(policy)

        assert "(deny file-write*\n" not in profile
        assert "(deny file-read* file-write*" not in profile

    def test_a_quote_in_a_path_cannot_close_the_profile_string(self):
        assert launch._sb_quote('/tmp/a"b\\c') == '"/tmp/a\\"b\\\\c"'

    def test_a_linked_path_is_matched_by_its_real_path_too(self, tmp_path):
        real = tmp_path / "real"
        real.mkdir()
        link = tmp_path / "link"
        try:
            link.symlink_to(real, target_is_directory=True)
        except OSError:
            pytest.skip("symlinks are not available here")

        assert launch._sb_paths([link]) == [link, real.resolve()]


class _Proxy:
    def __init__(self, socket_path=None, port=0, refusals=()):
        self.socket_path = socket_path
        self.port = port
        self._refusals = list(refusals)
        self.asked_since: list[float] = []

    def refusals_since(self, since):
        self.asked_since.append(since)
        return self._refusals


class TestSandboxed:
    def test_without_a_sandbox_nothing_is_wrapped(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            launch, "probe", lambda: SandboxStatus(UNAVAILABLE, None, "none here")
        )

        with pytest.raises(RuntimeError, match="none here"):
            launch.sandboxed(["true"], a_policy(tmp_path), {})

    def test_bubblewrap_goes_through_the_bridge(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            launch, "probe", lambda: SandboxStatus(ISOLATED, "bubblewrap")
        )
        proxy = _Proxy(socket_path=tmp_path / "p.sock")
        asked = {}

        def shared(allowlist, *, unix_dir):
            asked.update(allowlist=allowlist, unix_dir=unix_dir)
            return proxy

        monkeypatch.setattr(launch, "shared_proxy", shared)
        monkeypatch.setattr(launch, "_bwrap", lambda: None)
        policy = a_policy(tmp_path)

        command = launch.sandboxed(["true"], policy, {"KEEP": "1"})

        assert command.backend == "bubblewrap" and command.proxy is proxy
        assert command.argv[0] == "bwrap"
        assert asked["unix_dir"] == launch._proxy_dir()
        assert command.env["KEEP"] == "1"
        assert command.env["TMPDIR"] == str(policy.tmp_dir)
        assert command.env["https_proxy"] == f"http://127.0.0.1:{launch.BRIDGE_PORT}"
        assert (
            command.env["NO_PROXY"] == "" and command.env["NODE_USE_ENV_PROXY"] == "1"
        )

    def test_seatbelt_points_at_the_proxy_s_port(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            launch, "probe", lambda: SandboxStatus(ISOLATED, "seatbelt")
        )
        monkeypatch.setattr(
            launch, "shared_proxy", lambda allowlist, *, unix_dir: _Proxy(port=4567)
        )

        command = launch.sandboxed(["true"], a_policy(tmp_path), {})

        assert command.argv[:2] == [launch._SANDBOX_EXEC, "-p"]
        assert command.argv[-1] == "true"
        assert command.env["HTTPS_PROXY"] == "http://127.0.0.1:4567"


# ---------------------------------------------------------------------------
# a session


@pytest.fixture
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKPILOT_SANDBOX", "auto")
    monkeypatch.setattr(
        os_sandbox, "probe", lambda: SandboxStatus(ISOLATED, "bubblewrap")
    )
    proxy = _Proxy(
        refusals=[
            types.SimpleNamespace(host="evil.test", port=443),
            types.SimpleNamespace(host="evil.test", port=443),
            types.SimpleNamespace(host="other.test", port=80),
        ]
    )
    wrapped = {}

    def sandboxed(argv, policy, env):
        wrapped.update(argv=argv, policy=policy, env=env)
        return launch.SandboxedCommand(
            ["bwrap", *argv], {"W": "1"}, "bubblewrap", proxy
        )

    monkeypatch.setattr(os_sandbox, "sandboxed", sandboxed)
    return types.SimpleNamespace(proxy=proxy, wrapped=wrapped)


class TestSession:
    def test_an_isolated_session_wraps_in_its_own_folder(self, isolated, tmp_path):
        sandbox = os_sandbox.session_sandbox(tmp_path)
        elsewhere = tmp_path / "sub"
        elsewhere.mkdir()

        argv, env = sandbox.wrap(["ls"], {"A": "1"}, cwd=elsewhere)

        assert sandbox.isolated and (argv, env) == (["bwrap", "ls"], {"W": "1"})
        assert isolated.wrapped["policy"].cwd == elsewhere.resolve()
        assert "writes limited to the worktree" in sandbox.summary()

    def test_refused_hosts_are_listed_once_each_since_the_session_began(
        self, isolated, tmp_path
    ):
        sandbox = os_sandbox.session_sandbox(tmp_path)
        assert sandbox.refused_hosts() == []  # nothing launched yet

        sandbox.wrap(["curl", "x"], {})

        assert sandbox.refused_hosts() == ["evil.test:443", "other.test:80"]
        assert sandbox.refused_hosts(since=5.0) == ["evil.test:443", "other.test:80"]
        assert isolated.proxy.asked_since == [sandbox._started, 5.0]

    def test_a_delegated_sandbox_names_its_tool(self):
        assert os_sandbox.delegated_status("Codex").summary() == (
            "commands are sandboxed by Codex"
        )


class TestClaudeCodeStatus:
    @pytest.fixture
    def platform(self, monkeypatch):
        import foundation.platform as fp

        def pretend(name, *, socat=True):
            monkeypatch.setattr(fp, "is_windows", lambda: name == "windows")
            monkeypatch.setattr(fp, "is_linux", lambda: name == "linux")
            monkeypatch.setattr(
                fp,
                "find_executable",
                lambda tool, *a: "/usr/bin/socat" if socat else None,
            )
            monkeypatch.setattr(
                "shutil.which",
                lambda tool, *a, **k: "/usr/bin/socat" if socat else None,
            )

        return pretend

    def test_windows_has_no_claude_code_sandbox(self, platform, monkeypatch):
        platform("windows")
        monkeypatch.setenv("WORKPILOT_SANDBOX", "auto")

        status = os_sandbox.claude_code_status()

        assert status.state == UNAVAILABLE
        assert status.reason == "Claude Code has no sandbox on Windows"

    def test_linux_without_socat_is_unavailable(self, platform, monkeypatch):
        platform("linux", socat=False)
        monkeypatch.setenv("WORKPILOT_SANDBOX", "auto")
        monkeypatch.setattr(
            os_sandbox, "probe", lambda: SandboxStatus(ISOLATED, "bubblewrap")
        )

        assert "needs socat on Linux" in os_sandbox.claude_code_status().reason

    def test_linux_with_socat_delegates(self, platform, monkeypatch):
        platform("linux")
        monkeypatch.setattr(
            os_sandbox, "probe", lambda: SandboxStatus(ISOLATED, "bubblewrap")
        )

        status = os_sandbox.claude_code_status()

        assert status.state == os_sandbox.DELEGATED and status.backend == "Claude Code"

    def test_required_without_one_refuses_to_start(self, platform, monkeypatch):
        platform("windows")
        monkeypatch.setenv("WORKPILOT_SANDBOX", "required")

        with pytest.raises(os_sandbox.SandboxRequiredError, match="Claude Code cannot"):
            os_sandbox.claude_code_status()
