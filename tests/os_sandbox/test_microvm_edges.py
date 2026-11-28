"""The microVM backend where sbx, git or the host answer badly.

`test_microvm.py` drives a task's VM through a fake `sbx` that answers well;
these are the answers it must survive: sbx missing or failing to start, old
or broken JSON, a host git that is absent, and the size it reads from the
machine when the person set none.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from pathlib import Path

import pytest
from os_sandbox import microvm
from os_sandbox.hosts import HostAllowlist
from os_sandbox.launch import MISSING, REFUSED, UNAVAILABLE, UNSUPPORTED
from os_sandbox.policy import SandboxPolicy
from security.path_guard import WRITE_ROOTS_ENV_VAR


def _done(args, code=0, out="", err=""):
    return subprocess.CompletedProcess(args, code, out, err)


@pytest.fixture(autouse=True)
def _fresh_probe():
    microvm.probe_microvm.cache_clear()
    yield
    microvm.probe_microvm.cache_clear()


# ── Finding and running sbx ──────────────────────────────────────────────


def test_sbx_on_the_path_is_found_when_no_installer_put_it_elsewhere(monkeypatch):
    monkeypatch.setattr(microvm, "find_executable", lambda name, dirs=None: None)
    monkeypatch.setattr(microvm.shutil, "which", lambda name: f"/usr/bin/{name}")
    assert microvm.sbx_executable() == "/usr/bin/sbx"


@pytest.mark.parametrize(
    ("windows", "macos", "expected"),
    [
        (True, False, "winget install -h Docker.sbx"),
        (False, True, "brew install docker/tap/sbx"),
        (False, False, "docs.docker.com/ai/sandboxes/install"),
    ],
)
def test_the_install_hint_is_the_one_of_this_system(
    monkeypatch, windows, macos, expected
):
    monkeypatch.setattr(microvm, "is_windows", lambda: windows)
    monkeypatch.setattr(microvm, "is_macos", lambda: macos)
    monkeypatch.setattr(microvm, "sbx_executable", lambda: None)
    with pytest.raises(microvm.MicrovmError, match="not installed") as raised:
        microvm.run_sbx(["version"])
    assert expected in str(raised.value)


def test_sbx_runs_without_a_prompt_a_shell_or_the_hosts_credentials(monkeypatch):
    seen: dict = {}

    def run(cmd, **kwargs):
        seen["cmd"], seen["kwargs"] = cmd, kwargs
        return _done(cmd, out="v0.54")

    monkeypatch.setattr(microvm, "sbx_executable", lambda: "/opt/sbx")
    monkeypatch.setattr(microvm.subprocess, "run", run)
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_should_not_reach_sbx")
    assert microvm.run_sbx(["version"], timeout=5).stdout == "v0.54"
    assert seen["cmd"] == ["/opt/sbx", "--no-input", "version"]
    assert seen["kwargs"]["timeout"] == 5
    assert seen["kwargs"]["stdin"] is subprocess.DEVNULL
    assert "shell" not in seen["kwargs"]
    assert "GITHUB_TOKEN" not in seen["kwargs"]["env"]


@pytest.mark.parametrize(
    "error", [OSError("exec format error"), subprocess.TimeoutExpired("sbx", 5)]
)
def test_sbx_that_cannot_start_or_hangs_is_an_error_that_says_so(monkeypatch, error):
    def run(cmd, **kwargs):
        raise error

    monkeypatch.setattr(microvm, "sbx_executable", lambda: "/opt/sbx")
    monkeypatch.setattr(microvm.subprocess, "run", run)
    with pytest.raises(microvm.MicrovmError, match="sbx did not run"):
        microvm.run_sbx(["version"])


def test_the_probe_says_sbx_has_no_build_for_an_unknown_system(monkeypatch):
    for name in ("is_windows", "is_macos", "is_linux"):
        monkeypatch.setattr(microvm, name, lambda: False)
    status = microvm.probe_microvm()
    assert status.state == UNAVAILABLE
    assert status.kind == UNSUPPORTED
    assert "no build for this platform" in (status.reason or "")


def test_the_probe_reports_sbx_that_does_not_start_as_refused(monkeypatch):
    def broken(args, timeout=60):
        raise microvm.MicrovmError("sbx did not run: permission denied")

    monkeypatch.setattr(microvm, "is_linux", lambda: True)
    monkeypatch.setattr(microvm, "sbx_executable", lambda: "/opt/sbx")
    monkeypatch.setattr(microvm, "run_sbx", broken)
    status = microvm.probe_microvm()
    assert (status.state, status.kind) == (UNAVAILABLE, REFUSED)
    assert "permission denied" in (status.reason or "")


def test_the_probe_without_sbx_says_it_is_missing(monkeypatch):
    monkeypatch.setattr(microvm, "is_linux", lambda: True)
    monkeypatch.setattr(microvm, "sbx_executable", lambda: None)
    assert microvm.probe_microvm().kind == MISSING


# ── Mounts ───────────────────────────────────────────────────────────────


def _policy(tree: Path, **kwargs) -> SandboxPolicy:
    values = {
        "writable": (tree,),
        "read_only": (),
        "hidden": (),
        "allowlist": HostAllowlist.build([]),
        "tmp_dir": tree,
        "cwd": tree,
    }
    values.update(kwargs)
    return SandboxPolicy(**values)


def test_a_plain_folder_has_no_linked_worktree_pointer(tmp_path):
    assert microvm._worktree_gitdir(tmp_path) is None
    (tmp_path / ".git").mkdir()
    assert microvm._worktree_gitdir(tmp_path) is None


def test_a_git_file_that_names_no_gitdir_is_not_followed(tmp_path):
    (tmp_path / ".git").write_text("something else\n", encoding="utf-8")
    assert microvm._worktree_gitdir(tmp_path) is None


def test_an_unreadable_git_file_is_not_followed(tmp_path, monkeypatch):
    marker = tmp_path / ".git"
    marker.write_text("gitdir: ../repo/.git/worktrees/x\n", encoding="utf-8")
    real = Path.read_text

    def read_text(self, *args, **kwargs):
        if self == marker:
            raise PermissionError("denied")
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)
    assert microvm._worktree_gitdir(tmp_path) is None


def test_a_relative_gitdir_is_read_from_the_worktree(tmp_path):
    (tmp_path / ".git").write_text(
        "gitdir: ../repo/.git/worktrees/x\n", encoding="utf-8"
    )
    assert (
        microvm._worktree_gitdir(tmp_path)
        == (tmp_path.parent / "repo" / ".git" / "worktrees" / "x").resolve()
    )


def test_extra_write_roots_are_mounted_and_hidden_folders_covered(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(microvm, "workpilot_scratch_dir", lambda: tmp_path / "scratch")
    tree = (tmp_path / "wt").resolve()
    (tree / "secrets").mkdir(parents=True)
    (tree / "secrets" / "key.pem").write_text("x", encoding="utf-8")
    cache = (tmp_path / "cache").resolve()
    cache.mkdir()
    monkeypatch.setenv(WRITE_ROOTS_ENV_VAR, f"  {cache}  {microvm.os.pathsep} ")
    mounts = microvm.vm_mounts(_policy(tree, hidden=(tree / "secrets",)), tree, None)
    assert [m.host for m in mounts if not m.read_only] == [tree, cache]
    cover = next(m for m in mounts if m.target == microvm.vm_path(tree / "secrets"))
    assert cover.read_only and cover.host.is_dir()
    assert list(cover.host.iterdir()) == []


def test_a_hidden_path_outside_every_mount_is_not_mounted(tmp_path, monkeypatch):
    monkeypatch.setattr(microvm, "workpilot_scratch_dir", lambda: tmp_path / "scratch")
    monkeypatch.delenv(WRITE_ROOTS_ENV_VAR, raising=False)
    tree = (tmp_path / "wt").resolve()
    tree.mkdir()
    elsewhere = (tmp_path / "elsewhere").resolve()
    mounts = microvm.vm_mounts(_policy(tree, hidden=(elsewhere,)), tree, None)
    assert [m.host for m in mounts] == [tree]


# ── Size ─────────────────────────────────────────────────────────────────


def test_without_the_persons_numbers_the_machine_is_sampled(monkeypatch):
    import test_placement.machine as machine

    gib = 1024**3
    sampled: list[float] = []

    class Sample:
        ram_total, ram_free, cores, builds = 32 * gib, 24 * gib, 12, 2

    def sample(cpu_interval):
        sampled.append(cpu_interval)
        return Sample()

    monkeypatch.setattr(machine, "sample", sample)
    # 24 GiB free shared by this task and the 2 builds running: 8 GiB, 6 cores.
    assert microvm.vm_resources() == microvm.VmResources(8, 6)
    assert sampled == [0.1]


# ── What sbx answers ─────────────────────────────────────────────────────


def _answering(monkeypatch, code=0, out="", err=""):
    monkeypatch.setattr(
        microvm, "run_sbx", lambda args, timeout=60: _done(args, code, out, err)
    )


def test_a_failed_listing_is_an_error_with_sbxs_last_line(monkeypatch):
    _answering(monkeypatch, code=1, err="warming up\ndaemon not running\n")
    with pytest.raises(microvm.MicrovmError, match="daemon not running"):
        microvm.existing_vms()


def test_a_listing_that_is_not_json_is_an_error(monkeypatch):
    _answering(monkeypatch, out="NAME STATUS\nx running\n")
    with pytest.raises(microvm.MicrovmError, match="not JSON"):
        microvm.existing_vms()


def test_the_listing_of_sbx_before_0_48_is_read(monkeypatch):
    data = {"sandboxes": [{"name": "workpilot-a"}, {"name": ""}, "noise", {"id": 3}]}
    _answering(monkeypatch, out=json.dumps(data))
    assert microvm.existing_vms() == {"workpilot-a"}


def test_an_empty_listing_has_no_vm(monkeypatch):
    _answering(monkeypatch, out="")
    assert microvm.existing_vms() == set()


def test_a_global_rule_naming_one_resource_is_read(monkeypatch):
    rules = [
        {"scope": "global", "resource": "pypi.org:443"},
        {"scope": "global", "resources": "not a list", "resource": ""},
        {"scope": "workpilot-x", "resource": "mine.example:443"},
        "noise",
    ]
    _answering(monkeypatch, out=json.dumps(rules))
    assert microvm.global_allowed() == ["pypi.org:443"]


def test_any_host_pattern_covers_every_host():
    assert microvm._covers(microvm.ALL_HOSTS, "anything.example")
    assert microvm._overlaps("**", "pypi.org:443")


def test_a_signed_out_sbx_is_told_to_sign_in():
    with pytest.raises(microvm.MicrovmError, match="sign in with `sbx login`"):
        microvm._check(
            _done(["create"], 1, err="error: not authenticated"), "`sbx create`"
        )


# ── Git inside the VM ────────────────────────────────────────────────────


def test_the_hosts_git_setting_is_read_from_the_worktree(tmp_path):
    if not shutil.which("git"):
        pytest.skip("git is not installed")
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    subprocess.run(
        ["git", "-C", str(tmp_path), "config", "core.autocrlf", "input"], check=True
    )
    assert microvm._host_git(tmp_path, "core.autocrlf") == "input"
    assert microvm._host_git(tmp_path, "core.eol") is None


def test_without_git_on_the_host_no_setting_is_read(tmp_path, monkeypatch):
    monkeypatch.setattr(microvm, "find_executable", lambda name, dirs=None: None)
    monkeypatch.setattr(microvm.shutil, "which", lambda name: None)
    assert microvm._host_git(tmp_path, "core.autocrlf") is None


@pytest.mark.parametrize(
    "error", [OSError("no such file"), subprocess.TimeoutExpired("git", 10)]
)
def test_a_host_git_that_fails_to_run_reads_as_no_setting(tmp_path, monkeypatch, error):
    def run(cmd, **kwargs):
        raise error

    monkeypatch.setattr(
        microvm, "find_executable", lambda name, dirs=None: "/usr/bin/git"
    )
    monkeypatch.setattr(microvm.subprocess, "run", run)
    assert microvm._host_git(tmp_path, "core.autocrlf") is None


def test_the_vm_git_follows_the_hosts_line_endings_and_a_refusal_is_logged(
    tmp_path, monkeypatch, caplog
):
    calls: list[list[str]] = []

    def sbx(args, timeout=60):
        calls.append(args)
        return _done(args, 1 if "core.autocrlf" in args else 0, err="read-only home")

    monkeypatch.setattr(microvm, "run_sbx", sbx)
    monkeypatch.setattr(
        microvm,
        "_host_git",
        lambda tree, key: "true" if key == "core.autocrlf" else None,
    )
    vm = microvm.TaskVm(
        name="workpilot-t",
        mounts=(),
        resources=microvm.VmResources(2, 2),
        network=(),
        worktree=tmp_path,
    )
    with caplog.at_level(logging.WARNING, logger=microvm.logger.name):
        microvm._prepare_git(vm)
    assert calls == [
        [
            "exec",
            "workpilot-t",
            "git",
            "config",
            "--global",
            "--add",
            "safe.directory",
            "*",
        ],
        [
            "exec",
            "workpilot-t",
            "git",
            "config",
            "--global",
            "--replace-all",
            "core.autocrlf",
            "true",
        ],
    ]
    assert "core.autocrlf" in caplog.text and "read-only home" in caplog.text


# ── What the proxy refused ───────────────────────────────────────────────


def test_a_log_sbx_cannot_give_reads_as_nothing_refused(monkeypatch):
    def broken(args, timeout=60):
        raise microvm.MicrovmError("sbx did not run")

    monkeypatch.setattr(microvm, "run_sbx", broken)
    assert microvm.blocked_hosts("workpilot-t") == {}
    _answering(monkeypatch, code=1, err="no such sandbox")
    assert microvm.blocked_hosts("workpilot-t") == {}
    _answering(monkeypatch, out="<html>")
    assert microvm.blocked_hosts("workpilot-t") == {}


def test_refused_hosts_are_counted_whatever_sbx_calls_them(monkeypatch):
    blocked = [
        {"host": "evil.example", "count": 2},
        {"resource": "evil.example", "requests": 3},
        {"destination": "other.example", "count": "many"},
        {"count": 4},
        "noise",
    ]
    _answering(monkeypatch, out=json.dumps({"blocked": blocked}))
    assert microvm.blocked_hosts("workpilot-t") == {
        "evil.example": 5,
        "other.example": 1,
    }
