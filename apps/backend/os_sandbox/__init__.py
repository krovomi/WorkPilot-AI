"""The OS sandbox around the commands agents run.

Two kinds of process are wrapped:

- every command the WorkPilot loop runs for a provider without tools of its
  own (`run_command` in `core/runtimes/tool_executor.py`: OpenAI, Google,
  Copilot, Windsurf, the compatible and local providers);
- the whole process of a coding-agent CLI that runs its own commands
  (`CliSubprocessAgentClient`: OpenCode, Antigravity, pi), with the state
  directories and hosts its entry declares under ``sandbox:`` in
  ``capabilities/providers.yaml``. A CLI without that block is not wrapped,
  and the card says so.

Claude Code and the Codex CLI sandbox their own commands; WorkPilot reports
theirs (`delegated`) and does not wrap them twice.

With the Docker Sandboxes microVM turned on (Settings, Sandbox;
`os_sandbox.microvm`), the WorkPilot loop's commands run in the task's VM
instead; when the VM cannot be had, the OS sandbox above takes over and the
feed says why.

``WORKPILOT_SANDBOX``:

- ``auto`` (default): sandboxed when the machine can; when it cannot, the
  build runs and its card and feed say, at launch, that commands are not
  isolated and why;
- ``required``: a build that cannot be sandboxed does not start;
- ``off``: never sandboxed, and the card says that too.
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Iterable
from dataclasses import dataclass, field, replace
from pathlib import Path

from .launch import ISOLATED, UNAVAILABLE, SandboxStatus, install_hint, probe, sandboxed
from .microvm import (
    BACKEND,
    MicrovmError,
    TaskVm,
    blocked_hosts,
    ensure_vm,
    probe_microvm,
    sbx_env,
    task_vm,
)
from .policy import SandboxPolicy, build_policy
from .proxy import FilteringProxy

__all__ = [
    "DELEGATED",
    "ISOLATED",
    "MODE_ENV",
    "OFF",
    "UNAVAILABLE",
    "SandboxRequiredError",
    "SessionSandbox",
    "delegated_status",
    "first_report",
    "probe",
    "sandbox_mode",
    "session_sandbox",
]

MODE_ENV = "WORKPILOT_SANDBOX"
MODES = ("auto", "required", "off")
OFF = "off"
DELEGATED = "delegated"


class SandboxRequiredError(RuntimeError):
    """``WORKPILOT_SANDBOX=required`` and this machine cannot sandbox."""


def sandbox_mode() -> str:
    value = os.environ.get(MODE_ENV, "").strip().lower()
    return value if value in MODES else "auto"


@dataclass
class SessionSandbox:
    """One session's sandbox: what it is, and how to launch under it."""

    state: str
    backend: str | None = None
    reason: str | None = None
    policy: SandboxPolicy | None = None
    #: The task's microVM, when the commands run in one (`os_sandbox.microvm`).
    vm: TaskVm | None = None
    #: Why the microVM, turned on, is not the one used.
    fallback_reason: str | None = None
    _started: float = field(default_factory=time.time)
    _proxy: FilteringProxy | None = None
    _blocked_seen: dict[str, int] = field(default_factory=dict)

    @property
    def isolated(self) -> bool:
        return self.state == ISOLATED and self.policy is not None

    def wrap(
        self, argv: list[str], env: dict[str, str], *, cwd: Path | str | None = None
    ) -> tuple[list[str], dict[str, str]]:
        """`argv` and `env` as launched: under the sandbox when it is on."""
        policy = self.policy
        if not self.isolated or policy is None:
            return list(argv), dict(env)
        if self.vm is not None:
            return self.vm.exec_argv(list(argv), env, cwd), sbx_env(env)
        if cwd is not None:
            policy = replace(policy, cwd=Path(cwd).resolve())
        command = sandboxed(list(argv), policy, env)
        self._proxy = command.proxy
        return command.argv, command.env

    def refused_hosts(self, since: float | None = None) -> list[str]:
        """Hosts the proxy refused for this session, oldest first, once each.

        In a microVM: those refused since the previous call (sbx counts
        requests per host, without a time).
        """
        if self.vm is not None:
            counts = blocked_hosts(self.vm.name)
            fresh = [h for h, n in counts.items() if n > self._blocked_seen.get(h, 0)]
            self._blocked_seen = counts
            return fresh
        proxy = self._proxy
        if proxy is None:
            return []
        seen: list[str] = []
        for refusal in proxy.refusals_since(self._started if since is None else since):
            name = f"{refusal.host}:{refusal.port}"
            if name not in seen:
                seen.append(name)
        return seen

    def summary(self) -> str:
        """One line for the task feed. Stable English."""
        if self.state == ISOLATED and self.vm is not None:
            return (
                f"commands run in the task's Docker Sandboxes microVM ({self.vm.name}): "
                "only the worktree and the spec are mounted, network limited to the allowlist"
            )
        line = self._summary()
        if self.fallback_reason:
            line += f" (Docker Sandboxes microVM not used: {self.fallback_reason})"
        return line

    def _summary(self) -> str:
        if self.state == ISOLATED:
            return (
                f"commands run in the OS sandbox ({self.backend}): writes limited to the "
                "worktree and the spec, network limited to the allowlist"
            )
        if self.state == DELEGATED:
            return f"commands are sandboxed by {self.backend}"
        if self.state == OFF:
            return f"commands are NOT isolated: the OS sandbox is off ({MODE_ENV}=off)"
        return f"commands are NOT isolated: {self.reason or 'no OS sandbox on this machine'}"


def session_sandbox(
    project_dir: Path | str,
    spec_dir: Path | str | None = None,
    *,
    cwd: Path | str | None = None,
    state_dirs: Iterable[str] = (),
    provider_hosts: Iterable[str] = (),
    unavailable_reason: str | None = None,
    readable: Iterable[Path | str] = (),
    state_read_only: Iterable[str] = (),
    microvm: bool = False,
) -> SessionSandbox:
    """The sandbox a session's commands run in, decided once per session.

    ``unavailable_reason`` says why this session cannot be sandboxed even if
    the machine can (a CLI without a sandbox profile). ``microvm``: this
    session's commands can run in the task's microVM (the WorkPilot loop),
    used when the person turned it on.
    """
    mode = sandbox_mode()
    if mode == "off":
        return SessionSandbox(OFF)
    fallback_reason = None
    if microvm:
        chosen, fallback_reason = _microvm_session(
            project_dir, spec_dir, cwd=cwd, provider_hosts=provider_hosts
        )
        if chosen is not None:
            return chosen
    status: SandboxStatus = probe()
    reason = unavailable_reason or (None if status.available else status.reason)
    if reason is not None and fallback_reason:
        reason = f"Docker Sandboxes microVM unavailable ({fallback_reason}); {reason}"
        fallback_reason = None
    if reason is not None:
        if mode == "required":
            raise SandboxRequiredError(
                f"{MODE_ENV}=required, and this build cannot be sandboxed: {reason}"
            )
        return SessionSandbox(UNAVAILABLE, status.backend, reason)
    policy = build_policy(
        project_dir,
        spec_dir,
        cwd=cwd,
        state_dirs=state_dirs,
        provider_hosts=provider_hosts,
        readable=readable,
        state_read_only=state_read_only,
    )
    return SessionSandbox(
        ISOLATED, status.backend, None, policy, fallback_reason=fallback_reason
    )


def _microvm_session(
    project_dir: Path | str,
    spec_dir: Path | str | None,
    *,
    cwd: Path | str | None,
    provider_hosts: Iterable[str],
) -> tuple[SessionSandbox | None, str | None]:
    """The task's microVM session, or why there is none; (None, None) when off."""
    from security.agent_safety_settings import load_settings

    settings = load_settings().sandbox.microvm
    if not settings.enabled:
        return None, None
    status = probe_microvm()
    if not status.available:
        return None, status.reason
    policy = build_policy(project_dir, spec_dir, cwd=cwd, provider_hosts=provider_hosts)
    try:
        vm = task_vm(
            policy,
            project_dir,
            spec_dir,
            memory_gb=settings.memory_gb,
            cpus=settings.cpus,
        )
        ensure_vm(vm)
    except MicrovmError as error:
        return None, str(error)
    return SessionSandbox(ISOLATED, BACKEND, None, policy, vm=vm), None


def delegated_status(tool: str) -> SessionSandbox:
    """A provider whose own tool sandboxes its commands."""
    return SessionSandbox(DELEGATED, tool)


_reported: set[tuple[str, str, str]] = set()
_reported_lock = threading.Lock()


def first_report(
    spec_dir: Path | str | None, provider: str, sandbox: SessionSandbox
) -> dict | None:
    """The ``SANDBOX_STATUS`` payload the first time a build, provider and
    state are seen, None after: a build opens many sessions.

    `core/client.py` writes it to the card and the feed; this package stays
    below core (`tests/test_import_contracts.py`).
    """
    key = (str(spec_dir or ""), provider, sandbox.state)
    with _reported_lock:
        if key in _reported:
            return None
        _reported.add(key)
    return {
        "provider": provider,
        "state": sandbox.state,
        "backend": sandbox.backend,
        # The app keeps a reason of 500 characters at most (`main/task-sandbox.ts`).
        "reason": (sandbox.reason or sandbox.fallback_reason or "")[:500] or None,
        "network": sandbox.policy.allowlist.describe() if sandbox.policy else [],
    }


def claude_code_status() -> SessionSandbox:
    """Claude Code's own sandbox (``sandbox.enabled`` in `core/client.py`).

    It needs the same OS support as WorkPilot's, plus ``socat`` on Linux for
    its network proxy; without it Claude Code cannot isolate the commands.
    `WORKPILOT_SANDBOX=off` does not turn Claude Code's off.
    """
    import shutil

    from foundation.platform import find_executable, is_linux, is_windows

    if is_windows():
        reason = "Claude Code has no sandbox on Windows"
    else:
        status = probe()
        reason = None if status.available else status.reason
        if (
            reason is None
            and is_linux()
            and not (find_executable("socat") or shutil.which("socat"))
        ):
            reason = (
                "Claude Code's sandbox needs socat on Linux, which is not installed: "
                + install_hint("socat")
            )
    if reason is None:
        return delegated_status("Claude Code")
    if sandbox_mode() == "required":
        raise SandboxRequiredError(
            f"{MODE_ENV}=required, and Claude Code cannot sandbox: {reason}"
        )
    return SessionSandbox(UNAVAILABLE, "Claude Code", reason)
