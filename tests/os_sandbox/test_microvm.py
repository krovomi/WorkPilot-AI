"""The Docker Sandboxes backend: a task's microVM, driven through a fake `sbx`."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path, PurePosixPath

import os_sandbox
import pytest
from os_sandbox import microvm
from os_sandbox.hosts import HostAllowlist
from os_sandbox.launch import ISOLATED, UNAVAILABLE, SandboxStatus
from os_sandbox.policy import build_policy

SAFETY_ON = json.dumps({"sandbox": {"microvm": {"enabled": True}}})


class FakeSbx:
    """Records every `sbx` call and answers like sbx would."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.vms: set[str] = set()
        self.fail: dict[str, str] = {}
        self.blocked: list[dict] = []

    def __call__(self, args, *, timeout=60):
        self.calls.append(list(args))
        verb = args[0]
        if verb in self.fail:
            return subprocess.CompletedProcess(args, 1, "", self.fail[verb])
        out = ""
        if verb == "ls":
            out = json.dumps([{"name": name} for name in sorted(self.vms)])
        elif verb == "create":
            self.vms.add(args[args.index("--name") + 1])
        elif verb == "rm":
            self.vms.discard(args[-1])
        elif verb == "policy" and args[1] == "log":
            out = json.dumps(
                {"updated_at": "now", "allowed": [], "blocked": self.blocked}
            )
        return subprocess.CompletedProcess(args, 0, out, "")

    def verbs(self) -> list[str]:
        return [
            " ".join(call[:2]) if call[0] == "policy" else call[0]
            for call in self.calls
        ]


@pytest.fixture
def sbx(monkeypatch, tmp_path):
    fake = FakeSbx()
    monkeypatch.setattr(microvm, "run_sbx", fake)
    monkeypatch.setattr(microvm, "sbx_executable", lambda: "/opt/sbx")
    monkeypatch.setattr(microvm, "_host_git", lambda worktree, key: None)
    monkeypatch.setattr(microvm, "workpilot_scratch_dir", lambda: tmp_path / "scratch")
    monkeypatch.setattr(
        microvm, "vm_resources", lambda memory_gb=0, cpus=0: microvm.VmResources(4, 2)
    )
    return fake


def _git(*args: str, cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


@pytest.fixture
def worktree(tmp_path) -> Path:
    """A main checkout and a linked worktree, as the Kanban makes them."""
    if not shutil.which("git"):
        pytest.skip("git is not installed")
    main = tmp_path / "repo"
    main.mkdir()
    _git("init", "-q", cwd=main)
    _git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "i",
        cwd=main,
    )
    tree = tmp_path / "wt"
    _git("worktree", "add", "-q", str(tree), "-b", "task", cwd=main)
    (tree / ".workpilot").mkdir()
    (tree / ".workpilot" / ".env").write_text("TOKEN=x\n", encoding="utf-8")
    return tree.resolve()


# ── Paths and names ──────────────────────────────────────────────────────


def test_a_posix_path_is_the_same_inside():
    assert microvm.vm_path("/home/me/app", windows=False) == "/home/me/app"


def test_a_windows_path_goes_where_sbx_mounts_a_workspace_without_target():
    # Seen on Windows 11 with sbx 0.54.1: C:\Users\… is /c/Users/… in the VM.
    assert microvm.vm_path(r"C:\Repos\My App", windows=True) == "/c/Repos/My App"
    assert microvm.vm_path(r"D:\x", windows=True) == "/d/x"


def test_a_network_path_is_refused_its_place_in_the_vm_is_unknown():
    with pytest.raises(microvm.MicrovmError):
        microvm.vm_path(r"\\srv\share\a", windows=True)


@pytest.mark.parametrize("path", ["/a:b", "/"])
def test_a_path_sbx_cannot_mount_is_refused(path):
    with pytest.raises(microvm.MicrovmError):
        microvm.vm_path(path, windows=False)


def test_a_relative_windows_path_is_refused():
    with pytest.raises(microvm.MicrovmError):
        microvm.vm_path("Repos\\app", windows=True)


def test_the_name_is_stable_and_one_per_worktree(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    assert microvm.vm_name(a) == microvm.vm_name(a)
    assert microvm.vm_name(a) != microvm.vm_name(b)
    name = microvm.vm_name(a)
    assert name.startswith("workpilot-") and 2 <= len(name) <= 63


# ── Mounts ───────────────────────────────────────────────────────────────


def test_the_worktree_its_git_and_the_spec_are_mounted_nothing_else(
    worktree, tmp_path, monkeypatch
):
    monkeypatch.setattr(microvm, "workpilot_scratch_dir", lambda: tmp_path / "scratch")
    spec = tmp_path / "specs" / "001"
    spec.mkdir(parents=True)
    policy = build_policy(worktree, spec)
    mounts = microvm.vm_mounts(policy, worktree, spec)
    writable = [m.host for m in mounts if not m.read_only]
    git_dir = (tmp_path / "repo" / ".git").resolve()
    assert writable[0] == worktree
    assert set(writable) == {worktree, spec.resolve(), git_dir}
    # sbx refuses a target for the first (primary) workspace.
    assert mounts[0].target is None and mounts[0].spec() == str(worktree)
    assert all(m.target is not None for m in mounts[1:])
    read_only = {m.target for m in mounts if m.read_only}
    assert microvm.vm_path(git_dir / "hooks") in read_only
    assert microvm.vm_path(git_dir / "config") in read_only
    # The task's own .env is covered by an empty file, read-only.
    env_mount = next(m for m in mounts if m.vm_target.endswith("/.workpilot/.env"))
    assert env_mount.read_only and env_mount.host.read_text(encoding="utf-8") == ""
    # Never the home directory or its caches.
    assert not any(str(Path.home()) == str(m.host) for m in mounts)


def test_on_windows_the_git_pointer_is_rewritten_for_the_vm(
    worktree, tmp_path, monkeypatch
):
    monkeypatch.setattr(microvm, "workpilot_scratch_dir", lambda: tmp_path / "scratch")
    monkeypatch.setattr(microvm, "is_windows", lambda: True)
    monkeypatch.setattr(
        microvm, "vm_path", lambda path, windows=None: Path(path).as_posix()
    )
    policy = build_policy(worktree)
    mounts = microvm.vm_mounts(policy, worktree, None)
    pointer = next(m for m in mounts if m.target == (worktree / ".git").as_posix())
    assert pointer.read_only
    assert pointer.host.read_text(encoding="utf-8").startswith("gitdir: ")
    # The host's own pointer is untouched.
    assert (worktree / ".git").read_text(encoding="utf-8").startswith("gitdir:")


# ── Network and size ─────────────────────────────────────────────────────


def test_the_allowlist_becomes_rules_scoped_to_ports():
    rules = microvm.network_rules(
        HostAllowlist.build(["pypi.org", "*.example.com", "127.0.0.1:11434"])
    )
    assert rules[:5] == [
        "pypi.org:443",
        "pypi.org:80",
        "*.example.com:443",
        "*.example.com:80",
        "localhost:11434",
    ]
    assert "registry-1.docker.io:443" in rules
    assert len(rules) == len(set(rules))


def test_the_size_is_the_persons_or_a_share_of_the_machine():
    gib = 1024**3
    assert microvm.vm_resources(8, 4) == microvm.VmResources(8, 4)
    share = microvm.vm_resources(
        ram_total=32 * gib, ram_free=16 * gib, cores=8, builds=1
    )
    assert share == microvm.VmResources(8, 4)
    small = microvm.vm_resources(ram_total=4 * gib, ram_free=1 * gib, cores=2)
    assert small == microvm.VmResources(2, 2)
    big = microvm.vm_resources(ram_total=256 * gib, ram_free=200 * gib, cores=64)
    assert big.memory_gb == 16


# ── Creating, reusing, removing ──────────────────────────────────────────


def _vm(worktree: Path) -> microvm.TaskVm:
    return microvm.task_vm(build_policy(worktree), worktree)


def test_a_missing_vm_is_created_closed_then_opened_to_the_allowlist(sbx, worktree):
    vm = _vm(worktree)
    assert microvm.ensure_vm(vm) is True
    create = next(c for c in sbx.calls if c[0] == "create")
    assert create[1] == "shell"
    assert create[2] == str(worktree)
    for flag, value in (("--name", vm.name), ("--memory", "4g"), ("--cpus", "2")):
        assert create[create.index(flag) + 1] == value
    assert "--deny-network" in create
    allow = next(c for c in sbx.calls if c[:3] == ["policy", "allow", "network"])
    assert allow[3:5] == ["--sandbox", vm.name]
    assert "registry.npmjs.org:443" in allow[5].split(",")
    assert any(c[:2] == ["exec", vm.name] and "safe.directory" in c for c in sbx.calls)


def test_the_same_vm_is_reused_and_a_changed_one_created_again(sbx, worktree):
    vm = _vm(worktree)
    microvm.ensure_vm(vm)
    sbx.calls.clear()
    assert microvm.ensure_vm(vm) is False
    assert sbx.verbs() == ["ls"]
    changed = microvm.TaskVm(
        vm.name, vm.mounts[:1], vm.resources, vm.network, vm.worktree
    )
    sbx.calls.clear()
    assert microvm.ensure_vm(changed) is True
    assert sbx.verbs()[:3] == ["ls", "rm", "create"]


def test_a_refused_creation_says_why_and_how(sbx, worktree):
    sbx.fail["create"] = "You are not authenticated to Docker"
    with pytest.raises(microvm.MicrovmError, match="sbx login"):
        microvm.ensure_vm(_vm(worktree))


def test_removing_a_worktree_removes_its_vm(sbx, worktree):
    microvm.ensure_vm(_vm(worktree))
    assert microvm.remove_vm(worktree) is True
    assert microvm.remove_vm(worktree) is False


def test_a_command_runs_in_the_vm_without_the_hosts_secrets(sbx, worktree):
    vm = _vm(worktree)
    argv = vm.exec_argv(
        ["/bin/sh", "-c", "npm test"],
        {"OPENAI_API_KEY": "sk-secret", "LANG": "C.UTF-8"},
        worktree / "src",
    )
    assert argv[:5] == [
        "/opt/sbx",
        "--no-input",
        "exec",
        "-w",
        microvm.vm_path(worktree / "src"),
    ]
    assert "LANG=C.UTF-8" in argv and not any("sk-secret" in a for a in argv)
    assert argv[-4:] == [vm.name, "/bin/sh", "-c", "npm test"]
    outside = vm.exec_argv(["true"], {}, Path("/etc"))
    assert outside[4] == microvm.vm_path(worktree)
    assert "-i" not in argv


def test_a_command_that_reads_stdin_gets_it_forwarded(sbx, worktree):
    argv = _vm(worktree).exec_argv(["cat"], {}, None, stdin=True)
    assert argv[:4] == ["/opt/sbx", "--no-input", "exec", "-i"]


def test_blocked_hosts_are_counted(sbx):
    sbx.blocked = [{"host": "evil.example", "count": 2}, {"resource": "x.io"}, "junk"]
    assert microvm.blocked_hosts("vm") == {"evil.example": 2, "x.io": 1}
    sbx.fail["policy"] = "boom"
    assert microvm.blocked_hosts("vm") == {}


def test_the_probe_runs_sbx(monkeypatch):
    microvm.probe_microvm.cache_clear()
    monkeypatch.setattr(microvm, "sbx_executable", lambda: None)
    status = microvm.probe_microvm()
    assert status.state == UNAVAILABLE and "not installed" in (status.reason or "")
    microvm.probe_microvm.cache_clear()
    fake = FakeSbx()
    monkeypatch.setattr(microvm, "sbx_executable", lambda: "/opt/sbx")
    monkeypatch.setattr(microvm, "run_sbx", fake)
    assert microvm.probe_microvm().available
    microvm.probe_microvm.cache_clear()
    fake.fail["ls"] = "daemon not running"
    assert "daemon not running" in (microvm.probe_microvm().reason or "")
    microvm.probe_microvm.cache_clear()


# ── The session ──────────────────────────────────────────────────────────


@pytest.fixture
def microvm_on(monkeypatch, sbx):
    monkeypatch.setenv("WORKPILOT_SANDBOX", "auto")
    monkeypatch.setenv("WORKPILOT_AGENT_SAFETY", SAFETY_ON)
    monkeypatch.setattr(
        os_sandbox, "probe_microvm", lambda: SandboxStatus(ISOLATED, "microvm")
    )
    return sbx


def test_off_by_default_nothing_changes(worktree, monkeypatch, sbx):
    monkeypatch.setenv("WORKPILOT_SANDBOX", "auto")
    monkeypatch.delenv("WORKPILOT_AGENT_SAFETY", raising=False)
    monkeypatch.setattr(
        os_sandbox, "probe", lambda: SandboxStatus(UNAVAILABLE, None, "none here")
    )
    sandbox = os_sandbox.session_sandbox(worktree, microvm=True)
    assert sandbox.vm is None and sandbox.state == UNAVAILABLE
    assert sandbox.summary() == "commands are NOT isolated: none here"
    assert sbx.calls == []


def test_turned_on_the_loop_runs_in_the_vm(worktree, microvm_on):
    sandbox = os_sandbox.session_sandbox(worktree, microvm=True)
    assert sandbox.isolated and sandbox.backend == "microvm" and sandbox.vm is not None
    argv, env = sandbox.wrap(["/bin/sh", "-c", "ls"], {"GH_TOKEN": "x"}, cwd=worktree)
    assert argv[2] == "exec" and argv[-3:] == ["/bin/sh", "-c", "ls"]
    assert env["SBX_NO_TELEMETRY"] == "1"
    assert "microVM" in sandbox.summary()
    microvm_on.blocked = [{"host": "a.io", "count": 1}]
    assert sandbox.refused_hosts() == ["a.io"]
    assert sandbox.refused_hosts() == []


def test_a_cli_keeps_the_os_sandbox(worktree, microvm_on, monkeypatch):
    monkeypatch.setattr(
        os_sandbox, "probe", lambda: SandboxStatus(UNAVAILABLE, None, "none")
    )
    assert os_sandbox.session_sandbox(worktree).vm is None
    assert microvm_on.calls == []


def test_without_the_vm_the_os_sandbox_takes_over_and_says_why(
    worktree, microvm_on, monkeypatch
):
    microvm_on.fail["create"] = "Hypervisor Platform is not enabled"
    monkeypatch.setattr(
        os_sandbox, "probe", lambda: SandboxStatus(ISOLATED, "bubblewrap")
    )
    sandbox = os_sandbox.session_sandbox(worktree, microvm=True)
    assert sandbox.backend == "bubblewrap" and sandbox.vm is None
    assert "Hypervisor Platform" in sandbox.summary()


def test_required_without_either_does_not_start(worktree, microvm_on, monkeypatch):
    monkeypatch.setenv("WORKPILOT_SANDBOX", "required")
    monkeypatch.setattr(
        os_sandbox,
        "probe_microvm",
        lambda: SandboxStatus(UNAVAILABLE, "microvm", "sbx missing"),
    )
    monkeypatch.setattr(
        os_sandbox, "probe", lambda: SandboxStatus(UNAVAILABLE, None, "no bwrap")
    )
    with pytest.raises(os_sandbox.SandboxRequiredError, match="sbx missing.*no bwrap"):
        os_sandbox.session_sandbox(worktree, microvm=True)


# ── Settings and the model's tool ────────────────────────────────────────


def test_the_setting_is_off_by_default_and_bounded():
    from security.agent_safety_settings import parse_settings

    assert parse_settings({}).sandbox.microvm.enabled is False
    vm = parse_settings(
        {"sandbox": {"microvm": {"enabled": True, "memoryGb": 9999, "cpus": -3}}}
    ).sandbox.microvm
    assert vm.enabled and vm.memory_gb == 256 and vm.cpus == 0
    assert (
        parse_settings(
            {"sandbox": {"microvm": {"enabled": "yes"}}}
        ).sandbox.microvm.enabled
        is False
    )


def test_the_model_is_told_its_commands_run_in_linux_only_when_on(monkeypatch):
    from core.runtimes.tool_executor import get_tool_definitions

    def description() -> str:
        tools = get_tool_definitions("coder")
        return next(t for t in tools if t["name"] == "run_command")["description"]

    monkeypatch.delenv("WORKPILOT_AGENT_SAFETY", raising=False)
    assert "microVM" not in description()
    monkeypatch.setenv("WORKPILOT_AGENT_SAFETY", SAFETY_ON)
    assert "Linux microVM" in description()


def test_the_reported_reason_fits_what_the_app_keeps(tmp_path):
    long = os_sandbox.SessionSandbox(
        ISOLATED, "bubblewrap", None, None, fallback_reason="x" * 900
    )
    payload = os_sandbox.first_report(tmp_path / "long", "openai", long)
    assert payload is not None and len(payload["reason"]) == 500


def test_sbx_is_looked_for_where_its_windows_installers_put_it(monkeypatch, tmp_path):
    monkeypatch.setattr(microvm, "is_windows", lambda: True)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setenv("ProgramFiles", str(tmp_path / "pf"))
    dirs = microvm._install_dirs()
    assert str(tmp_path / "local" / "DockerSandboxes" / "bin") in dirs
    assert str(tmp_path / "pf" / "DockerSandboxes") in dirs
    monkeypatch.setattr(microvm, "is_windows", lambda: False)
    assert microvm._install_dirs() == []


def test_the_name_is_the_apps_for_the_same_path(monkeypatch):
    # The same vector as apps/frontend/src/main/microvm/__tests__/sbx.test.ts:
    # the app removes the VM it never created by this name.
    monkeypatch.setattr(microvm, "is_windows", lambda: False)

    class _Resolved(PurePosixPath):
        # The path as the app resolved it: /home is a link on macOS, and
        # Windows would add a drive.
        def resolve(self) -> _Resolved:
            return self

    monkeypatch.setattr(microvm, "Path", _Resolved)
    assert microvm.vm_name("/home/me/wt") == "workpilot-194449c0cfe5d0df"


# ── Agent CLIs in the VM (lot C2b) ───────────────────────────────────────


def test_network_rules_are_added_to_a_running_vm_never_recreated(sbx, worktree):
    vm = _vm(worktree)
    microvm.ensure_vm(vm)
    wider = microvm.TaskVm(
        vm.name,
        vm.mounts,
        vm.resources,
        (*vm.network, "api.openai.com:443"),
        vm.worktree,
    )
    sbx.calls.clear()
    assert microvm.ensure_vm(wider) is False
    assert sbx.verbs() == ["ls", "policy allow"]
    assert sbx.calls[-1][-1] == "api.openai.com:443"
    sbx.calls.clear()
    assert microvm.ensure_vm(wider) is False
    assert sbx.verbs() == ["ls"]


def test_an_agent_cli_is_installed_once(sbx, worktree):
    vm = _vm(worktree)
    microvm.ensure_vm(vm)
    sbx.calls.clear()
    microvm.ensure_tool(vm, "opencode", "npm install -g opencode-ai@latest")
    microvm.ensure_tool(vm, "opencode", "npm install -g opencode-ai@latest")
    installs = [c for c in sbx.calls if c[0] == "exec"]
    assert len(installs) == 1
    assert installs[0][:4] == ["exec", vm.name, "sh", "-c"]
    assert installs[0][4].startswith("command -v opencode >/dev/null 2>&1 || ")


def test_a_failed_install_says_so(sbx, worktree):
    vm = _vm(worktree)
    microvm.ensure_vm(vm)
    sbx.fail["exec"] = "npm: not found"
    with pytest.raises(microvm.MicrovmError, match="npm: not found"):
        microvm.ensure_tool(vm, "opencode", "npm install -g opencode-ai@latest")


@pytest.mark.parametrize(
    ("stdout", "expected"),
    [
        ('[{"service": "anthropic"}, {"service": "openai"}]', {"anthropic", "openai"}),
        ('{"secrets": [{"name": "OpenAI"}]}', {"openai"}),
        ('["mistral", "unknown"]', {"mistral"}),
        (
            "SERVICE   SCOPE\nanthropic global\ngithub    my-vm\n",
            {"anthropic", "github"},
        ),
    ],
)
def test_the_services_sbx_holds_a_key_for_are_read_never_the_keys(
    monkeypatch, stdout, expected
):
    calls = []

    def fake(args, *, timeout=60):
        calls.append(list(args))
        return subprocess.CompletedProcess(args, 0, stdout, "")

    monkeypatch.setattr(microvm, "run_sbx", fake)
    assert microvm.secret_services() == expected
    assert calls[0] == ["secret", "ls", "--json"]


def test_no_secret_list_reads_as_no_key(monkeypatch):
    monkeypatch.setattr(
        microvm,
        "run_sbx",
        lambda args, timeout=60: subprocess.CompletedProcess(args, 1, "", "boom"),
    )
    assert microvm.secret_services() == frozenset()


def test_the_vm_gets_placeholders_never_a_name_it_could_abuse(sbx, worktree):
    vm = _vm(worktree)
    argv = vm.exec_argv(
        ["opencode"], {}, None, stdin=True, vm_env={"OPENAI_API_KEY": "proxy-managed"}
    )
    assert "OPENAI_API_KEY=proxy-managed" in argv
    for bad in ({"LD_PRELOAD=x": "1"}, {"lower": "1"}, {"OK": "a\nb"}):
        with pytest.raises(microvm.MicrovmError):
            vm.exec_argv(["opencode"], {}, None, vm_env=bad)
