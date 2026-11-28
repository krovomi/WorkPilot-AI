"""What the person chose for the reinforced sandbox and the anomaly watch.

The two Settings pages (Sandbox, Anomaly detection) save their values in the
app's settings; Electron passes them to every agent process as one JSON
variable, ``WORKPILOT_AGENT_SAFETY`` (``main/agent/agent-safety-env.ts``). The
value comes from a file the renderer wrote, so it is read here as data: every
field is optional, typed, bounded, and anything malformed falls back to its
default rather than turning a guard off.

Pure (no I/O beyond the environment); read by ``security.sandbox``,
``security.path_guard`` and ``agents.safety_watch``.
"""

from __future__ import annotations

import json
import math
import os
import posixpath
from dataclasses import dataclass, field
from typing import Any

ENV_VAR = "WORKPILOT_AGENT_SAFETY"

#: The longest list of writable paths read from the settings.
MAX_ALLOWED_PATHS = 50

#: Bounds of a task microVM, as Docker Sandboxes takes them (sbx caps CPUs at 16
#: on some hosts and memory at the host's).
MAX_VM_MEMORY_GB = 256
MAX_VM_CPUS = 64


@dataclass(frozen=True)
class SnapshotSettings:
    """A git snapshot of the task's worktree before each agent session."""

    enabled: bool = True
    #: Snapshots kept per task; older ones are pruned.
    keep: int = 10
    #: Restore the session's snapshot when the watch stops the session.
    auto_rollback: bool = True


@dataclass(frozen=True)
class MicrovmSettings:
    """Docker Sandboxes (``sbx``): a microVM per task (`os_sandbox.microvm`).

    Off by default: off is exactly the OS sandbox of before.
    """

    enabled: bool = False
    #: Memory of each task's VM, in GiB; ``0`` sizes it from the machine.
    memory_gb: int = 0
    #: CPUs of each task's VM; ``0`` sizes it from the machine.
    cpus: int = 0
    #: Agent CLIs (OpenCode…) run in the VM too, keyed by sbx's own secrets.
    cli_agents: bool = False


@dataclass(frozen=True)
class SandboxSettings:
    """The limits a session works within, on top of the build's write roots."""

    #: ``normal``: the build's roots only. ``restricted``: writes in the
    #: project only under ``allowed_paths`` (the spec directory stays writable).
    mode: str = "normal"
    allowed_paths: tuple[str, ...] = ()
    #: Distinct files a session may write; ``0`` is no limit.
    max_files_written: int = 200
    #: Largest file a write may leave on disk, in MB; ``0`` is no limit.
    max_file_size_mb: float = 10.0
    #: Longest session, in minutes; ``0`` is no limit.
    max_session_minutes: int = 0
    microvm: MicrovmSettings = field(default_factory=MicrovmSettings)


@dataclass(frozen=True)
class AnomalySettings:
    """The trust score each session starts at 100 and the two thresholds."""

    enabled: bool = True
    pause_below: float = 40.0
    stop_below: float = 20.0
    mass_deletion_count: int = 5
    max_error_count: int = 10
    rapid_change_count: int = 20
    rapid_change_window_s: int = 10

    def thresholds(self) -> dict[str, Any]:
        """The detector's threshold table for these settings."""
        return {
            "mass_deletion_count": self.mass_deletion_count,
            "max_error_count": self.max_error_count,
            "rapid_file_change_count": self.rapid_change_count,
            "rapid_file_change_window_s": self.rapid_change_window_s,
            "trust_score_pause_threshold": self.pause_below,
            "trust_score_terminate_threshold": self.stop_below,
        }


@dataclass(frozen=True)
class AgentSafetySettings:
    snapshots: SnapshotSettings = field(default_factory=SnapshotSettings)
    sandbox: SandboxSettings = field(default_factory=SandboxSettings)
    anomaly: AnomalySettings = field(default_factory=AnomalySettings)


def _section(raw: dict[str, Any], key: str) -> dict[str, Any]:
    value = raw.get(key)
    return value if isinstance(value, dict) else {}


def _bool(raw: dict[str, Any], key: str, default: bool) -> bool:
    value = raw.get(key)
    return value if isinstance(value, bool) else default


def _number(
    raw: dict[str, Any], key: str, default: float, low: float, high: float
) -> float:
    value = raw.get(key)
    if isinstance(value, bool) or not isinstance(value, int | float):
        return default
    if math.isnan(value):
        return default
    return float(min(max(value, low), high))


def _int(raw: dict[str, Any], key: str, default: int, low: int, high: int) -> int:
    return int(_number(raw, key, default, low, high))


def normalize_allowed_path(entry: Any) -> str | None:
    """A project-relative path, forward slashes, no ``..``; None when unusable.

    An absolute path, a drive letter or a ``..`` segment is not a path inside
    the project, and a restricted sandbox only ever narrows the project.
    """
    if isinstance(entry, dict):
        entry = entry.get("path")
    if not isinstance(entry, str):
        return None
    text = entry.strip().replace("\\", "/")
    if not text or len(text) > 400 or "\0" in text:
        return None
    if text.startswith("/") or (len(text) > 1 and text[1] == ":"):
        return None
    if ".." in text.split("/"):
        return None
    normalized = posixpath.normpath(text).strip("/")
    if normalized in ("", "."):
        return None
    return normalized


def _allowed_paths(raw: Any) -> tuple[str, ...]:
    if not isinstance(raw, list):
        return ()
    paths: list[str] = []
    for entry in raw[: MAX_ALLOWED_PATHS * 2]:
        normalized = normalize_allowed_path(entry)
        if normalized and normalized not in paths:
            paths.append(normalized)
    return tuple(paths[:MAX_ALLOWED_PATHS])


def parse_settings(raw: Any) -> AgentSafetySettings:
    """Settings from the decoded JSON, every field checked and bounded."""
    if not isinstance(raw, dict):
        return AgentSafetySettings()

    snap = _section(raw, "snapshots")
    snapshots = SnapshotSettings(
        enabled=_bool(snap, "enabled", True),
        keep=_int(snap, "keep", 10, 1, 50),
        auto_rollback=_bool(snap, "autoRollback", True),
    )

    box = _section(raw, "sandbox")
    mode = box.get("mode")
    vm = _section(box, "microvm")
    sandbox = SandboxSettings(
        mode=mode if mode in ("normal", "restricted") else "normal",
        allowed_paths=_allowed_paths(box.get("allowedPaths")),
        max_files_written=_int(box, "maxFilesWritten", 200, 0, 10_000),
        max_file_size_mb=_number(box, "maxFileSizeMb", 10.0, 0.0, 1024.0),
        max_session_minutes=_int(box, "maxSessionMinutes", 0, 0, 24 * 60),
        microvm=MicrovmSettings(
            enabled=_bool(vm, "enabled", False),
            memory_gb=_int(vm, "memoryGb", 0, 0, MAX_VM_MEMORY_GB),
            cpus=_int(vm, "cpus", 0, 0, MAX_VM_CPUS),
            cli_agents=_bool(vm, "cliAgents", False),
        ),
    )

    watch = _section(raw, "anomaly")
    pause_below = _number(watch, "pauseBelow", 40.0, 0.0, 100.0)
    anomaly = AnomalySettings(
        enabled=_bool(watch, "enabled", True),
        pause_below=pause_below,
        # Stopping is the stronger step: never above the pause threshold.
        stop_below=min(_number(watch, "stopBelow", 20.0, 0.0, 100.0), pause_below),
        mass_deletion_count=_int(watch, "massDeletionCount", 5, 1, 1000),
        max_error_count=_int(watch, "maxErrorCount", 10, 1, 1000),
        rapid_change_count=_int(watch, "rapidChangeCount", 20, 2, 1000),
        rapid_change_window_s=_int(watch, "rapidChangeWindowS", 10, 1, 3600),
    )
    return AgentSafetySettings(snapshots=snapshots, sandbox=sandbox, anomaly=anomaly)


def load_settings(environ: dict[str, str] | None = None) -> AgentSafetySettings:
    """The settings this process was started with; defaults when absent."""
    env = os.environ if environ is None else environ
    text = (env.get(ENV_VAR) or "").strip()
    if not text or len(text) > 64_000:
        return AgentSafetySettings()
    try:
        return parse_settings(json.loads(text))
    except (ValueError, RecursionError):
        return AgentSafetySettings()


__all__ = [
    "ENV_VAR",
    "AgentSafetySettings",
    "AnomalySettings",
    "MicrovmSettings",
    "SandboxSettings",
    "SnapshotSettings",
    "load_settings",
    "normalize_allowed_path",
    "parse_settings",
]
