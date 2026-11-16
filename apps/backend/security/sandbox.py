"""The reinforced sandbox: what a session may write, and how much.

The build's write roots (``security.path_guard``) say *where* an agent may
write at all: its checkout, its spec directory, ``<tmp>/workpilot``. The
reinforced sandbox narrows that inside the project, from the Sandbox page of
Settings (``security.agent_safety_settings``):

- ``restricted`` mode: a write in the project lands under one of the listed
  paths, or is refused. The spec directory and the scratch directory stay
  writable, since the build itself keeps its plan there.
- the largest file a single write may hold.

Two places apply it before the write happens: the SDK's write-path hook
(``path_guard.make_write_path_hook``) and the executor of the providers that
run WorkPilot's own tools (``core.runtimes.tool_executor``). The CLI agents
that write with their own tools (Codex, OpenCode, pi, ACP agents) are judged
after the fact by the session watch (``agents.safety_watch``), which pauses
the task and, by default, restores the snapshot taken before the session.

The other limits (files written per session, session length) are counted by
that same watch. Pure: no I/O but ``Path.resolve``.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .agent_safety_settings import SandboxSettings, load_settings
from .scratch_dir import workpilot_scratch_dir

MODE_NORMAL = "normal"
MODE_RESTRICTED = "restricted"


@dataclass(frozen=True)
class SandboxPolicy:
    """The write rules of one build, from its settings."""

    mode: str = MODE_NORMAL
    allowed_paths: tuple[str, ...] = ()
    max_file_bytes: int = 0
    max_files_written: int = 0
    max_session_seconds: int = 0

    @classmethod
    def from_settings(cls, settings: SandboxSettings) -> SandboxPolicy:
        return cls(
            mode=settings.mode,
            allowed_paths=settings.allowed_paths,
            max_file_bytes=int(settings.max_file_size_mb * 1024 * 1024),
            max_files_written=settings.max_files_written,
            max_session_seconds=settings.max_session_minutes * 60,
        )

    @property
    def restricted(self) -> bool:
        return self.mode == MODE_RESTRICTED


def current_policy() -> SandboxPolicy:
    """The policy this process was started with (``WORKPILOT_AGENT_SAFETY``)."""
    return SandboxPolicy.from_settings(load_settings().sandbox)


def _resolved(path: Path) -> Path | None:
    try:
        return path.expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return None


def _within(path: Path, root: Path | None) -> bool:
    return root is not None and (path == root or path.is_relative_to(root))


def project_relative(target: str, project_dir: Path | None) -> str | None:
    """``target`` relative to the project, forward slashes; None when outside."""
    if project_dir is None:
        return None
    root = _resolved(Path(project_dir))
    candidate = Path(target).expanduser()
    if not candidate.is_absolute():
        candidate = Path(project_dir) / candidate
    resolved = _resolved(candidate)
    if root is None or resolved is None or not _within(resolved, root):
        return None
    return PurePosixPath(*resolved.relative_to(root).parts).as_posix()


def path_allowed(relative: str, allowed_paths: tuple[str, ...]) -> bool:
    """Whether a project-relative path is one of, or under one of, the paths."""
    for allowed in allowed_paths:
        if relative == allowed or relative.startswith(allowed + "/"):
            return True
    return False


def _exempt(target: str, project_dir: Path | None, spec_dir: Path | None) -> bool:
    """The build's own files: its spec directory and the scratch directory."""
    candidate = Path(target).expanduser()
    if not candidate.is_absolute() and project_dir is not None:
        candidate = Path(project_dir) / candidate
    resolved = _resolved(candidate)
    if resolved is None:
        return False
    for root in (spec_dir, workpilot_scratch_dir()):
        if root is not None and _within(resolved, _resolved(Path(root))):
            return True
    relative = project_relative(target, project_dir)
    # The build's own state (plans, logs, snapshots of the spec) lives here.
    return relative is not None and (
        relative == ".workpilot" or relative.startswith(".workpilot/")
    )


def write_refusal(
    policy: SandboxPolicy,
    target: str,
    project_dir: Path | str | None,
    spec_dir: Path | str | None = None,
    content_bytes: int | None = None,
) -> str | None:
    """Why the sandbox refuses this write, or None when it allows it."""
    base = Path(project_dir) if project_dir else None
    spec = Path(spec_dir) if spec_dir else None
    if (
        policy.max_file_bytes
        and content_bytes is not None
        and content_bytes > policy.max_file_bytes
    ):
        limit_mb = policy.max_file_bytes / (1024 * 1024)
        return (
            f"Refusing to write '{target}': {content_bytes} bytes is over the "
            f"sandbox's limit of {limit_mb:g} MB per file (Settings, Sandbox)."
        )
    if not policy.restricted or _exempt(target, base, spec):
        return None
    relative = project_relative(target, base)
    if relative is None:
        # Outside the project: the write roots decide, not this narrowing.
        return None
    if path_allowed(relative, policy.allowed_paths):
        return None
    listed = ", ".join(policy.allowed_paths) or "none"
    return (
        f"Refusing to write '{target}': the sandbox is in restricted mode and "
        f"only these project paths are writable: {listed}. Work within them, "
        "or say in your output that the task needs another path."
    )


__all__ = [
    "MODE_NORMAL",
    "MODE_RESTRICTED",
    "SandboxPolicy",
    "current_policy",
    "path_allowed",
    "project_relative",
    "write_refusal",
]
