"""Turn a command into the same command under the OS sandbox.

| OS | Backend | Network |
|---|---|---|
| Linux | bubblewrap: read-only root, write binds, hidden credentials, a fresh network, PID and IPC namespace | only the filtering proxy, reached through `bridge.py` on ``127.0.0.1`` inside |
| macOS | Seatbelt (``sandbox-exec``): writes denied outside the roots, reads denied on credentials | outbound only to loopback, where the proxy listens |
| Windows | none yet | — |

`probe()` runs the sandbox once for real (`bwrap … true`, `sandbox-exec … true`)
before saying it is available: a ``bwrap`` binary that the kernel refuses
(unprivileged user namespaces off, AppArmor) is "unavailable", with the
reason, never "isolated".
"""

from __future__ import annotations

import functools
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from foundation.platform import find_executable, is_linux, is_macos, is_windows
from security.path_guard import workpilot_scratch_dir

from .policy import SandboxPolicy
from .proxy import FilteringProxy, shared_proxy

#: The loopback port the bridge listens on inside a Linux sandbox.
BRIDGE_PORT = 18080
_BRIDGE = Path(__file__).with_name("bridge.py")
_SANDBOX_EXEC = "/usr/bin/sandbox-exec"
_PROBE_TIMEOUT = 15

#: Filesystem sockets that hand out more than the sandbox grants (a
#: container engine is root on the machine). Hidden when they exist.
_ENGINE_SOCKETS = (
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/run/containerd/containerd.sock",
    "/run/podman/podman.sock",
)

ISOLATED = "isolated"
UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class SandboxStatus:
    state: str
    backend: str | None
    reason: str | None = None

    @property
    def available(self) -> bool:
        return self.state == ISOLATED


def _bwrap() -> str | None:
    return find_executable("bwrap") or shutil.which("bwrap")


def _probe_linux() -> SandboxStatus:
    bwrap = _bwrap()
    if not bwrap:
        return SandboxStatus(
            UNAVAILABLE, "bubblewrap", "bubblewrap (bwrap) is not installed"
        )
    command = [
        bwrap,
        "--die-with-parent",
        "--unshare-net",
        "--unshare-pid",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--",
        "/bin/true" if Path("/bin/true").exists() else "true",
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=_PROBE_TIMEOUT, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return SandboxStatus(UNAVAILABLE, "bubblewrap", f"bwrap did not run: {error}")
    if result.returncode != 0:
        detail = (result.stderr or "").strip().splitlines()[-1:] or ["no detail"]
        return SandboxStatus(
            UNAVAILABLE,
            "bubblewrap",
            "bwrap is installed but the kernel refused it "
            f"(user namespaces disabled or restricted): {detail[0][:200]}",
        )
    return SandboxStatus(ISOLATED, "bubblewrap")


def _probe_macos() -> SandboxStatus:
    if not Path(_SANDBOX_EXEC).exists():
        return SandboxStatus(UNAVAILABLE, "seatbelt", "sandbox-exec is missing")
    try:
        result = subprocess.run(
            [_SANDBOX_EXEC, "-p", "(version 1)(allow default)", "/usr/bin/true"],
            capture_output=True,
            text=True,
            timeout=_PROBE_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return SandboxStatus(
            UNAVAILABLE, "seatbelt", f"sandbox-exec did not run: {error}"
        )
    if result.returncode != 0:
        return SandboxStatus(
            UNAVAILABLE,
            "seatbelt",
            f"sandbox-exec refused: {(result.stderr or '').strip()[:200]}",
        )
    return SandboxStatus(ISOLATED, "seatbelt")


@functools.lru_cache(maxsize=1)
def probe() -> SandboxStatus:
    """Whether this machine can sandbox a command, found by running one."""
    if is_linux():
        return _probe_linux()
    if is_macos():
        return _probe_macos()
    if is_windows():
        return SandboxStatus(
            UNAVAILABLE,
            None,
            "WorkPilot has no OS sandbox on Windows yet (AppContainer is planned)",
        )
    return SandboxStatus(UNAVAILABLE, None, "no OS sandbox for this platform")


def _proxy_dir() -> Path:
    return workpilot_scratch_dir() / "sandbox-proxy"


def _proxy_env(url: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for name in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"):
        env[name] = url
        env[name.lower()] = url
    # Loopback goes through the proxy too: inside a Linux sandbox the
    # machine's loopback is not this one, and an allowed local endpoint
    # (a local model) is reached only through it.
    env["NO_PROXY"] = env["no_proxy"] = ""
    # Node ≥ 24 reads the variables above only when asked to.
    env["NODE_USE_ENV_PROXY"] = "1"
    return env


def _sort(paths) -> list[Path]:
    return sorted(paths, key=lambda p: (len(p.parts), str(p)))


def bwrap_argv(
    bwrap: str, policy: SandboxPolicy, proxy_socket: Path, command: list[str]
) -> list[str]:
    argv = [
        bwrap,
        "--die-with-parent",
        "--new-session",
        "--unshare-net",
        "--unshare-pid",
        "--unshare-ipc",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
    ]
    runtime_dir = Path(f"/run/user/{os.getuid()}") if hasattr(os, "getuid") else None
    if runtime_dir and runtime_dir.is_dir():
        # The session bus (and the keyring behind it) and the user's sockets.
        argv += ["--tmpfs", str(runtime_dir)]
    for path in _sort(policy.readable):
        argv += ["--ro-bind", str(path), str(path)]
    for path in _sort(policy.writable):
        argv += ["--bind", str(path), str(path)]
    argv += ["--bind", str(policy.tmp_dir), str(policy.tmp_dir)]
    argv += ["--ro-bind", str(proxy_socket), str(proxy_socket)]
    for path in _sort(policy.read_only):
        argv += ["--ro-bind", str(path), str(path)]
    for path in _sort(policy.hidden):
        argv += ["--tmpfs", str(path)]
    for path in policy.hidden_files:
        argv += ["--ro-bind", "/dev/null", str(path)]
    for socket_path in _ENGINE_SOCKETS:
        if os.path.exists(socket_path):
            argv += ["--ro-bind", "/dev/null", os.path.realpath(socket_path)]
    argv += ["--chdir", str(policy.cwd), "--"]
    argv += [
        sys.executable,
        "-I",
        str(_BRIDGE),
        str(proxy_socket),
        str(BRIDGE_PORT),
        "--",
    ]
    return argv + list(command)


def _sb_quote(path: Path | str) -> str:
    return '"' + str(path).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _sb_paths(paths) -> list[Path]:
    # Seatbelt matches the real path: /tmp is /private/tmp on macOS.
    out: list[Path] = []
    for path in paths:
        out.append(Path(path))
        real = Path(os.path.realpath(path))
        if real != Path(path):
            out.append(real)
    return out


def seatbelt_profile(policy: SandboxPolicy) -> str:
    writable = _sb_paths([*policy.writable, policy.tmp_dir])
    lines = [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
        "(allow file-write*",
        *(f"  (subpath {_sb_quote(p)})" for p in writable),
        '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
        '  (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    ]
    read_only = _sb_paths(policy.read_only)
    if read_only:
        lines += [
            "(deny file-write*",
            *(f"  (subpath {_sb_quote(p)})" for p in read_only),
            ")",
        ]
    hidden = _sb_paths(policy.hidden)
    hidden_files = _sb_paths([*policy.hidden_files, *map(Path, _ENGINE_SOCKETS)])
    if hidden or hidden_files:
        lines += [
            "(deny file-read* file-write*",
            *(f"  (subpath {_sb_quote(p)})" for p in hidden),
            *(f"  (literal {_sb_quote(p)})" for p in hidden_files),
            ")",
        ]
    lines += [
        "(deny network-outbound)",
        '(allow network-outbound (remote ip "localhost:*"))',
    ]
    return "\n".join(lines) + "\n"


@dataclass(frozen=True)
class SandboxedCommand:
    argv: list[str]
    env: dict[str, str]
    backend: str
    proxy: FilteringProxy


def sandboxed(
    command: list[str], policy: SandboxPolicy, env: dict[str, str]
) -> SandboxedCommand:
    """`command` under this machine's sandbox; raises when there is none."""
    status = probe()
    if not status.available:
        raise RuntimeError(status.reason or "no OS sandbox")
    out_env = dict(env)
    out_env["TMPDIR"] = str(policy.tmp_dir)
    if status.backend == "bubblewrap":
        proxy = shared_proxy(policy.allowlist, unix_dir=_proxy_dir())
        assert proxy.socket_path is not None
        out_env.update(_proxy_env(f"http://127.0.0.1:{BRIDGE_PORT}"))
        argv = bwrap_argv(_bwrap() or "bwrap", policy, proxy.socket_path, command)
        return SandboxedCommand(argv, out_env, "bubblewrap", proxy)
    proxy = shared_proxy(policy.allowlist, unix_dir=None)
    out_env.update(_proxy_env(f"http://127.0.0.1:{proxy.port}"))
    argv = [_SANDBOX_EXEC, "-p", seatbelt_profile(policy), *command]
    return SandboxedCommand(argv, out_env, "seatbelt", proxy)
