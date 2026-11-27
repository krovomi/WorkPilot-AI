"""Docker Sandboxes (``sbx``): one microVM per task worktree.

The third backend of the OS sandbox, after bubblewrap and Seatbelt, and the
only one on Windows. It is chosen only when the person turned it on
(Settings, Sandbox, ``agentSafety.sandbox.microvm.enabled``, off by default);
off, everything is the OS sandbox of before.

What runs in the VM, in this lot: the commands of the WorkPilot loop
(``run_command`` of `core/runtimes/tool_executor.py`), through ``sbx exec``.
The model calls stay in the backend, on the host: no credential enters the
VM. A CLI that runs its own commands keeps the OS sandbox.

- **Files**: the VM sees only what is mounted, at creation: the worktree, the
  spec directory, the git directory it commits into and the person's
  ``WORKPILOT_WRITE_ROOTS``. Inside those, the paths the OS sandbox holds
  read-only (git hooks and config, security configuration) are mounted again
  read-only over themselves, and the hidden ones (``.workpilot/.env``) are
  covered by an empty file or folder. The home directory, its credentials and
  the host's package caches are never mounted: the VM has its own.
- **Network**: created with ``--deny-network``, then the same allowlist as the
  OS sandbox, as rules scoped to that VM (``sbx policy allow network
  --sandbox``). A local endpoint (``127.0.0.1:11434``) is reached from inside
  as ``host.docker.internal``.
- **Resources**: ``--memory`` and ``--cpus`` from the settings, or sized from
  the machine (`vm_resources`): sbx would otherwise take half the RAM per VM.
- **Privacy**: every ``sbx`` call runs with ``SBX_NO_TELEMETRY=1``.

One VM per worktree, named from its path (`vm_name`), reused by every session
of the task (planner, coder, QA) so what a session installs stays for the
next; removed with the worktree (`remove_vm`).
"""

from __future__ import annotations

import functools
import hashlib
import json
import logging
import os
import shutil
import subprocess
import threading
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath, PureWindowsPath

from foundation.platform import find_executable, is_linux, is_macos, is_windows
from security.path_guard import WRITE_ROOTS_ENV_VAR, workpilot_scratch_dir

from .hosts import HostAllowlist, HostRule, _is_loopback
from .launch import ISOLATED, MISSING, REFUSED, UNAVAILABLE, UNSUPPORTED, SandboxStatus
from .policy import SandboxPolicy, _git_common_dir

logger = logging.getLogger(__name__)

BACKEND = "microvm"
NAME_PREFIX = "workpilot-"
TELEMETRY_ENV = {"SBX_NO_TELEMETRY": "1"}
#: The hostname a VM reaches the host's services by.
HOST_ALIAS = "host.docker.internal"

#: What the VM's own system and Docker engine install from, on top of the
#: allowlist every sandbox has (the package registries).
VM_HOSTS: tuple[str, ...] = (
    "registry-1.docker.io",
    "auth.docker.io",
    "production.cloudflare.docker.com",
    "deb.debian.org",
    "security.debian.org",
    "archive.ubuntu.com",
    "security.ubuntu.com",
    "ports.ubuntu.com",
)

#: Host variables a command inside the VM receives. The host's environment
#: holds the backend's keys: nothing else crosses.
FORWARDED_ENV: tuple[str, ...] = (
    "LANG",
    "LC_ALL",
    "TZ",
    "CI",
    "NO_COLOR",
    "FORCE_COLOR",
)

_QUICK_TIMEOUT = 60
_CREATE_TIMEOUT = 900
_GIB = 1024**3


class MicrovmError(RuntimeError):
    """``sbx`` could not prepare the task's VM; the message says why."""


def _install_dirs() -> list[str]:
    """Where the sbx installers put it, for an app started before its PATH
    was updated (winget's per-user install, the machine-wide MSI)."""
    if not is_windows():
        return []
    dirs: list[str] = []
    for base in (os.environ.get("LOCALAPPDATA"), os.environ.get("ProgramFiles")):
        if base:
            root = Path(base) / "DockerSandboxes"
            dirs += [str(root / "bin"), str(root)]
    return dirs


def sbx_executable() -> str | None:
    return find_executable("sbx", _install_dirs()) or shutil.which("sbx")


def sbx_env(base: dict[str, str] | None = None) -> dict[str, str]:
    """The environment of an ``sbx`` process on the host."""
    env = dict(os.environ if base is None else base)
    env.update(TELEMETRY_ENV)
    return env


def _install_hint() -> str:
    if is_windows():
        return "install it with `winget install -h Docker.sbx`, then run `sbx login`"
    if is_macos():
        return "install it with `brew install docker/tap/sbx`, then run `sbx login`"
    return "install it (https://docs.docker.com/ai/sandboxes/install/), then run `sbx login`"


def _detail(result: subprocess.CompletedProcess) -> str:
    lines = (result.stderr or result.stdout or "").strip().splitlines()
    return (lines[-1] if lines else f"exit code {result.returncode}")[:300]


def run_sbx(
    args: list[str], *, timeout: float = _QUICK_TIMEOUT
) -> subprocess.CompletedProcess:
    """One ``sbx`` call, never prompting, without a shell."""
    sbx = sbx_executable()
    if not sbx:
        raise MicrovmError(
            "Docker Sandboxes (sbx) is not installed: " + _install_hint()
        )
    try:
        return subprocess.run(
            [sbx, "--no-input", *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
            env=sbx_env(),
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise MicrovmError(f"sbx did not run: {error}") from error


@functools.lru_cache(maxsize=1)
def probe_microvm() -> SandboxStatus:
    """Whether ``sbx`` runs here and answers, found by running it.

    The VM itself is created for real by `ensure_vm`, the first time a task
    needs it: a refusal there (no Hypervisor Platform, not signed in) makes
    that session "unavailable" with sbx's own words, never "isolated".
    """
    if not (is_windows() or is_macos() or is_linux()):
        return SandboxStatus(
            UNAVAILABLE,
            BACKEND,
            "Docker Sandboxes has no build for this platform",
            UNSUPPORTED,
        )
    if not sbx_executable():
        return SandboxStatus(
            UNAVAILABLE,
            BACKEND,
            "Docker Sandboxes (sbx) is not installed: " + _install_hint(),
            MISSING,
        )
    for args in (["version"], ["ls", "--json"]):
        try:
            result = run_sbx(args)
        except MicrovmError as error:
            return SandboxStatus(UNAVAILABLE, BACKEND, str(error), REFUSED)
        if result.returncode != 0:
            return SandboxStatus(
                UNAVAILABLE,
                BACKEND,
                f"`sbx {' '.join(args)}` failed: {_detail(result)}",
                REFUSED,
            )
    return SandboxStatus(ISOLATED, BACKEND)


# ── Paths ────────────────────────────────────────────────────────────────


def vm_path(path: Path | str, *, windows: bool | None = None) -> str:
    """Where a host path is mounted inside the VM.

    The same path on macOS and Linux. A Windows path becomes
    ``/mnt/<drive>/…`` (``C:\\Repos\\app`` → ``/mnt/c/Repos/app``) and a UNC
    path ``/mnt/unc/<server>/<share>/…``. A path sbx cannot take as a mount
    target (a ``:``) raises `MicrovmError`.
    """
    windows = is_windows() if windows is None else windows
    if not windows:
        text = PurePosixPath(str(path)).as_posix()
    else:
        win = PureWindowsPath(str(path))
        rest = [part for part in win.parts[1:] if part not in ("\\", "/")]
        drive = win.drive
        if drive.startswith(("\\\\", "//")):
            unc = [part for part in drive.replace("\\", "/").split("/") if part]
            text = "/".join(["", "mnt", "unc", *unc, *rest])
        elif drive.endswith(":") and len(drive) == 2:
            text = "/".join(["", "mnt", drive[0].lower(), *rest])
        else:
            raise MicrovmError(f"not an absolute Windows path: {path}")
    if ":" in text or "\0" in text or not text.startswith("/") or text == "/":
        raise MicrovmError(f"this path cannot be mounted in a Docker sandbox: {path}")
    return text


def vm_name(worktree: Path | str) -> str:
    """The VM of a worktree: stable for the path, unique per worktree."""
    key = str(Path(worktree).resolve())
    if is_windows():
        key = key.lower()
    return NAME_PREFIX + hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class Mount:
    host: Path
    target: str
    read_only: bool = False

    def spec(self) -> str:
        """``PATH:TARGET[:ro]``, as ``sbx create`` takes a workspace."""
        return f"{self.host}:{self.target}" + (":ro" if self.read_only else "")


def _inside(path: Path, roots: Iterable[Path]) -> bool:
    return any(path == root or path.is_relative_to(root) for root in roots)


def _worktree_gitdir(worktree: Path) -> Path | None:
    """The ``gitdir:`` a linked worktree's ``.git`` file names."""
    marker = worktree / ".git"
    if not marker.is_file():
        return None
    try:
        text = marker.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None
    if not text.startswith("gitdir:"):
        return None
    gitdir = Path(text[len("gitdir:") :].strip())
    return (gitdir if gitdir.is_absolute() else worktree / gitdir).resolve()


def _blank(kind: str) -> Path:
    """An empty folder or file that covers a hidden path inside a mount."""
    folder = workpilot_scratch_dir() / "sandbox-vm"
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    if kind == "dir":
        path = folder / "empty-dir"
        path.mkdir(exist_ok=True, mode=0o700)
    else:
        path = folder / "empty-file"
        if not path.exists():
            path.write_text("", encoding="utf-8")
    return path


def _pointer_file(name: str, gitdir: Path) -> Path:
    """A ``.git`` file for the VM: the host's names a Windows path."""
    folder = workpilot_scratch_dir() / "sandbox-vm" / name
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = folder / "git-pointer"
    path.write_text(f"gitdir: {vm_path(gitdir)}\n", encoding="utf-8")
    return path


def vm_mounts(
    policy: SandboxPolicy, worktree: Path, spec_dir: Path | str | None
) -> list[Mount]:
    """What the task's VM mounts, the worktree first (its default directory)."""
    worktree = worktree.resolve()
    candidates: list[Path] = [worktree]
    if spec_dir:
        candidates.append(Path(spec_dir).resolve())
    git_dir = _git_common_dir(worktree)
    if git_dir is not None:
        candidates.append(git_dir.resolve())
    for entry in os.environ.get(WRITE_ROOTS_ENV_VAR, "").split(os.pathsep):
        if entry.strip():
            candidates.append(Path(entry.strip()).expanduser().resolve())
    roots: list[Path] = []
    for path in candidates:
        if path.is_dir() and not _inside(path, roots):
            roots = [r for r in roots if not r.is_relative_to(path)] + [path]
    # The worktree leads: `sbx exec` starts in the first workspace.
    roots.sort(key=lambda r: r != worktree)
    mounts = [Mount(root, vm_path(root)) for root in roots]

    for path in policy.read_only:
        if _inside(path, roots) and path.exists():
            mounts.append(Mount(path, vm_path(path), read_only=True))
    for path in policy.hidden:
        if _inside(path, roots):
            mounts.append(Mount(_blank("dir"), vm_path(path), read_only=True))
    for path in policy.hidden_files:
        if _inside(path, roots):
            mounts.append(Mount(_blank("file"), vm_path(path), read_only=True))
    gitdir = _worktree_gitdir(worktree)
    if gitdir is not None and is_windows():
        pointer = _pointer_file(vm_name(worktree), gitdir)
        mounts.append(Mount(pointer, vm_path(worktree / ".git"), read_only=True))
    return mounts


# ── Network and resources ────────────────────────────────────────────────


def network_rules(allowlist: HostAllowlist) -> list[str]:
    """The allowlist as ``sbx policy allow network`` resources."""
    rules: list[str] = []
    extra = HostAllowlist.build(VM_HOSTS).rules
    for rule in (*allowlist.rules, *(r for r in extra if r not in allowlist.rules)):
        rules.extend(_rule_resources(rule))
    return list(dict.fromkeys(rules))


def _rule_resources(rule: HostRule) -> list[str]:
    if rule.port is not None:
        # A local endpoint: the host, as the VM reaches it.
        return [f"localhost:{rule.port}"] if _is_loopback(rule.host) else []
    host = ("*." if rule.wildcard else "") + rule.host
    return [f"{host}:443", f"{host}:80"]


@dataclass(frozen=True)
class VmResources:
    memory_gb: int
    cpus: int


def vm_resources(
    memory_gb: int = 0,
    cpus: int = 0,
    *,
    ram_total: int | None = None,
    ram_free: int | None = None,
    cores: int | None = None,
    builds: int = 0,
) -> VmResources:
    """The VM's size: the person's numbers, else a share of the machine.

    A share is what is free now split between this task and the builds
    already running (`test_placement.machine`), between 2 and 16 GiB, and
    half the cores, at least 2: sbx alone would give each VM half the RAM.
    """
    if memory_gb <= 0 or cpus <= 0:
        if ram_total is None or ram_free is None or cores is None:
            from test_placement.machine import sample

            machine = sample(cpu_interval=0.1)
            ram_total, ram_free = machine.ram_total, machine.ram_free
            cores, builds = machine.cores, machine.builds
    if memory_gb <= 0:
        share = (ram_free or 0) / max(1, builds + 1) / _GIB
        ceiling = max(2, int((ram_total or 0) * 0.75 / _GIB))
        memory_gb = int(min(max(share, 2), 16, ceiling))
    if cpus <= 0:
        cpus = max(2, (cores or 2) // 2)
    return VmResources(memory_gb=memory_gb, cpus=cpus)


# ── The VM ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TaskVm:
    """A task's VM, as created; `exec_argv` turns a command into one inside."""

    name: str
    mounts: tuple[Mount, ...]
    resources: VmResources
    network: tuple[str, ...]
    worktree: Path
    _mounted: tuple[Path, ...] = field(default=(), compare=False)

    def fingerprint(self) -> str:
        """What a VM is created with and cannot change after.

        Not its size: sized from the free memory of the moment, it would
        differ from one session to the next and recreate the VM each time.
        """
        data = {
            "mounts": [m.spec() for m in self.mounts],
            "network": list(self.network),
        }
        return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()

    def target_of(self, path: Path | str) -> str:
        """`path` as the VM sees it; the worktree for a path outside the mounts."""
        resolved = Path(path).resolve()
        for mount in self.mounts:
            if not mount.read_only and (
                resolved == mount.host or resolved.is_relative_to(mount.host)
            ):
                return vm_path(resolved)
        return vm_path(self.worktree)

    def exec_argv(
        self, command: list[str], env: dict[str, str], cwd: Path | str | None
    ) -> list[str]:
        argv = [sbx_executable() or "sbx", "--no-input", "exec"]
        argv += ["-w", self.target_of(cwd or self.worktree)]
        for name in FORWARDED_ENV:
            if env.get(name):
                argv += ["-e", f"{name}={env[name]}"]
        return [*argv, self.name, *command]


def _state_file(name: str) -> Path:
    folder = workpilot_scratch_dir() / "sandbox-vm" / name
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    return folder / "vm.json"


def existing_vms() -> set[str]:
    result = run_sbx(["ls", "--json"])
    if result.returncode != 0:
        raise MicrovmError(f"`sbx ls` failed: {_detail(result)}")
    try:
        data = json.loads(result.stdout or "[]")
    except ValueError as error:
        raise MicrovmError(f"`sbx ls --json` was not JSON: {error}") from error
    if isinstance(data, dict):  # sbx before 0.48: {"sandboxes": [...]}
        data = data.get("sandboxes", [])
    return {
        str(item.get("name"))
        for item in data
        if isinstance(item, dict) and item.get("name")
    }


def _check(result: subprocess.CompletedProcess, what: str) -> None:
    if result.returncode != 0:
        detail = _detail(result)
        if "not authenticated" in detail.lower() or "login" in detail.lower():
            detail += " (sign in with `sbx login`)"
        raise MicrovmError(f"{what} failed: {detail}")


def task_vm(
    policy: SandboxPolicy,
    worktree: Path | str,
    spec_dir: Path | str | None = None,
    *,
    memory_gb: int = 0,
    cpus: int = 0,
) -> TaskVm:
    """The VM a task needs, not yet created (`ensure_vm`)."""
    worktree = Path(worktree).resolve()
    mounts = tuple(vm_mounts(policy, worktree, spec_dir))
    return TaskVm(
        name=vm_name(worktree),
        mounts=mounts,
        resources=vm_resources(memory_gb, cpus),
        network=tuple(network_rules(policy.allowlist)),
        worktree=worktree,
    )


_locks: dict[str, threading.Lock] = {}
_locks_mutex = threading.Lock()


def ensure_vm(vm: TaskVm) -> bool:
    """Create the VM unless the same one exists. True when it was created.

    A VM created for other mounts or another allowlist is removed and created
    again: its configuration is fixed at creation. The sessions of a task
    (subagents included) share one backend process: they wait for each other.
    """
    with _locks_mutex:
        lock = _locks.setdefault(vm.name, threading.Lock())
    with lock:
        return _ensure_vm(vm)


def _ensure_vm(vm: TaskVm) -> bool:
    state = _state_file(vm.name)
    fingerprint = vm.fingerprint()
    present = vm.name in existing_vms()
    if present:
        try:
            if (
                json.loads(state.read_text(encoding="utf-8")).get("fingerprint")
                == fingerprint
            ):
                return False
        except (OSError, ValueError):
            pass
        logger.info("[microvm] %s changed: created again", vm.name)
        _check(run_sbx(["rm", "--force", vm.name]), f"`sbx rm {vm.name}`")
    primary, *others = vm.mounts
    args = [
        "create",
        "shell",
        primary.spec(),
        *(m.spec() for m in others),
        "--name",
        vm.name,
        "--memory",
        f"{vm.resources.memory_gb}g",
        "--cpus",
        str(vm.resources.cpus),
        "--deny-network",
        "--no-progress",
    ]
    _check(run_sbx(args, timeout=_CREATE_TIMEOUT), "`sbx create`")
    if vm.network:
        _check(
            run_sbx(
                [
                    "policy",
                    "allow",
                    "network",
                    "--sandbox",
                    vm.name,
                    ",".join(vm.network),
                ]
            ),
            "`sbx policy allow network`",
        )
    _prepare_git(vm)
    state.write_text(
        json.dumps({"fingerprint": fingerprint, "worktree": str(vm.worktree)}),
        encoding="utf-8",
    )
    return True


def _host_git(worktree: Path, key: str) -> str | None:
    git = find_executable("git") or shutil.which("git")
    if not git:
        return None
    try:
        result = subprocess.run(
            [git, "-C", str(worktree), "config", "--get", key],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    value = result.stdout.strip()
    return value if result.returncode == 0 and value else None


def _prepare_git(vm: TaskVm) -> None:
    """Git inside the VM reads the worktree as the host does.

    The mounted files belong to another user there (git would call them
    "dubious"), and line endings follow the host's ``core.autocrlf``: written
    in the VM's own global configuration, never in the repository's.
    """
    settings = [("safe.directory", "*")]
    for key in ("core.autocrlf", "core.eol"):
        value = _host_git(vm.worktree, key)
        if value:
            settings.append((key, value))
    for key, value in settings:
        verb = "--add" if key == "safe.directory" else "--replace-all"
        result = run_sbx(
            ["exec", vm.name, "git", "config", "--global", verb, key, value]
        )
        if result.returncode != 0:
            logger.warning(
                "[microvm] git config %s in %s: %s", key, vm.name, _detail(result)
            )


def remove_vm(worktree: Path | str) -> bool:
    """Remove a worktree's VM and its state; True when one was removed."""
    name = vm_name(worktree)
    if name not in existing_vms():
        shutil.rmtree(workpilot_scratch_dir() / "sandbox-vm" / name, ignore_errors=True)
        return False
    _check(run_sbx(["rm", "--force", name]), f"`sbx rm {name}`")
    shutil.rmtree(workpilot_scratch_dir() / "sandbox-vm" / name, ignore_errors=True)
    return True


def blocked_hosts(name: str) -> dict[str, int]:
    """What the VM's proxy refused so far: ``{host: requests}``.

    Read from ``sbx policy log --json``; a failure reads as nothing refused.
    """
    try:
        result = run_sbx(["policy", "log", name, "--json", "--type", "network"])
    except MicrovmError:
        return {}
    if result.returncode != 0:
        return {}
    try:
        data = json.loads(result.stdout or "{}")
    except ValueError:
        return {}
    blocked = data.get("blocked", []) if isinstance(data, dict) else []
    counts: dict[str, int] = {}
    for entry in blocked if isinstance(blocked, list) else []:
        if not isinstance(entry, dict):
            continue
        host = entry.get("host") or entry.get("resource") or entry.get("destination")
        if not isinstance(host, str) or not host:
            continue
        count = entry.get("count", entry.get("requests", 1))
        counts[host] = counts.get(host, 0) + (count if isinstance(count, int) else 1)
    return counts
