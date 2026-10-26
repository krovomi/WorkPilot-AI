"""What a sandboxed process may touch, computed from the build, never from it.

- **Writes**: the build's write roots (`security.path_guard.resolve_write_roots`:
  the worktree, the spec, ``<tmp>/workpilot``, ``WORKPILOT_WRITE_ROOTS``), the
  git directory the worktree commits into, the provider's own state
  directories, and the package caches a build fills. Everything else is
  read-only.
- **Read-only inside a writable root**: the security configuration
  `path_guard` protects, and the git hooks and config, which run outside the
  sandbox the next time anyone uses git.
- **Hidden**: credentials that are not the agent's own (SSH, cloud CLIs,
  GitHub CLI, registries, WorkPilot's own settings and ``.env`` files).
- **Network**: the filtering proxy, with the package registries, the
  provider's hosts and ``WORKPILOT_SANDBOX_HOSTS``.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from security.path_guard import (
    PROTECTED_CONFIG_DIRS,
    PROTECTED_CONFIG_NAMES,
    resolve_write_roots,
    workpilot_scratch_dir,
)

from .hosts import HostAllowlist, allowlist_for

#: Credentials an agent never needs to read, relative to the home directory.
HIDDEN_HOME_PATHS: tuple[str, ...] = (
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".config/gcloud",
    ".kube",
    ".docker",
    ".config/gh",
    ".config/hub",
    ".netrc",
    ".git-credentials",
    ".config/git/credentials",
    ".npmrc",
    ".yarnrc.yml",
    ".pypirc",
    ".nuget/NuGet/NuGet.Config",
    ".config/NuGet/NuGet.Config",
    ".m2/settings.xml",
    ".gradle/gradle.properties",
    ".cargo/credentials.toml",
    ".cargo/credentials",
    ".claude.json",
    ".claude/.credentials.json",
    ".codex/auth.json",
    ".config/WorkPilot AI",
    ".config/workpilot-ai-ui",
    "Library/Application Support/WorkPilot AI",
    "Library/Application Support/workpilot-ai-ui",
    "Library/Keychains",
)

#: Package caches a build writes to, relative to the home directory. Bound
#: writable only when they already exist.
PACKAGE_CACHES: tuple[str, ...] = (
    ".npm",
    ".cache/pip",
    ".cache/uv",
    ".cache/pnpm",
    ".local/share/pnpm",
    ".cache/yarn",
    ".yarn/berry/cache",
    ".nuget/packages",
    ".cargo/registry",
    ".cargo/git",
    "go/pkg/mod",
    ".cache/go-build",
    ".m2/repository",
    ".gradle/caches",
    "Library/Caches/pip",
    "Library/Caches/pnpm",
    "Library/Caches/Yarn",
)

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
_REPO_ROOT = _BACKEND_ROOT.parents[1]


def _existing(paths: Iterable[Path]) -> list[Path]:
    seen: list[Path] = []
    for path in paths:
        try:
            resolved = path.expanduser().resolve()
        except (OSError, RuntimeError, ValueError):
            continue
        if resolved.exists() and resolved not in seen:
            seen.append(resolved)
    return seen


def _home() -> Path:
    return Path(os.path.expanduser("~"))


def _git_common_dir(worktree: Path) -> Path | None:
    """The repository directory a worktree commits into, if it is one."""
    marker = worktree / ".git"
    if marker.is_dir():
        return marker
    if not marker.is_file():
        return None
    try:
        text = marker.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None
    if not text.startswith("gitdir:"):
        return None
    gitdir = Path(text[len("gitdir:") :].strip())
    if not gitdir.is_absolute():
        gitdir = worktree / gitdir
    commondir = gitdir / "commondir"
    if commondir.is_file():
        try:
            common = Path(commondir.read_text(encoding="utf-8").strip())
        except OSError:
            return gitdir
        # Resolved: `commondir` is usually `../..`, whose name is not `.git`.
        return (common if common.is_absolute() else gitdir / common).resolve()
    return gitdir


def _state_dir(entry: str) -> Path | None:
    """A CLI's own state directory, created when missing so a first login
    can be written; None when its variable is unset."""
    expanded = os.path.expandvars(os.path.expanduser(entry))
    if "$" in expanded:
        return None
    path = Path(expanded)
    try:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError:
        return None
    return path


def _protected_inside(root: Path) -> list[Path]:
    """The security configuration directly under a writable root."""
    found = [root / name for name in PROTECTED_CONFIG_NAMES]
    for directory, patterns in PROTECTED_CONFIG_DIRS.items():
        folder = root / directory
        if folder.is_dir():
            for pattern in patterns:
                found.extend(folder.glob(pattern))
    return found


@dataclass(frozen=True)
class SandboxPolicy:
    writable: tuple[Path, ...]
    read_only: tuple[Path, ...]
    hidden: tuple[Path, ...]
    allowlist: HostAllowlist
    tmp_dir: Path
    cwd: Path
    hidden_files: tuple[Path, ...] = field(default=())
    # Read-only paths that the private /tmp would hide (a CLI installed there).
    readable: tuple[Path, ...] = field(default=())

    def describe(self) -> dict:
        return {
            "writable": [str(p) for p in self.writable],
            "readOnly": [str(p) for p in self.read_only],
            "hidden": [str(p) for p in (*self.hidden, *self.hidden_files)],
            "network": self.allowlist.describe(),
        }


def build_policy(
    project_dir: Path | str,
    spec_dir: Path | str | None = None,
    *,
    cwd: Path | str | None = None,
    state_dirs: Iterable[str] = (),
    provider_hosts: Iterable[str] = (),
    allowlist: HostAllowlist | None = None,
    readable: Iterable[Path | str] = (),
    state_read_only: Iterable[str] = (),
) -> SandboxPolicy:
    project = Path(project_dir).resolve()
    home = _home()
    roots = resolve_write_roots(project, spec_dir)
    git_dir = _git_common_dir(project)
    tmp_dir = workpilot_scratch_dir() / "sandbox-tmp" / uuid.uuid4().hex[:12]
    tmp_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    state = [_state_dir(d) for d in state_dirs]
    writable = _existing(
        [
            *roots,
            *([git_dir] if git_dir else []),
            *(home / rel for rel in PACKAGE_CACHES),
            *(d for d in state if d is not None),
        ]
    )
    read_only: list[Path] = []
    for root in roots:
        read_only.extend(_protected_inside(root))
    if git_dir:
        read_only.extend([git_dir / "hooks", git_dir / "config"])
    for entry in state_read_only:
        expanded = os.path.expandvars(os.path.expanduser(entry))
        if "$" not in expanded:
            read_only.append(Path(expanded))
    read_only = _existing(read_only)

    hidden_candidates = [home / rel for rel in HIDDEN_HOME_PATHS]
    hidden_candidates += [
        _BACKEND_ROOT / ".env",
        _REPO_ROOT / ".env-files",
        project / ".workpilot" / ".env",
    ]
    if git_dir is not None and git_dir.name == ".git":
        hidden_candidates.append(git_dir.parent / ".workpilot" / ".env")
    hidden_existing = _existing(hidden_candidates)
    # A hidden path inside a writable one stays hidden; a writable one inside
    # a hidden one (an agent's own state under ~/.config) stays writable,
    # because the agent's login is its own.
    hidden_existing = [
        h
        for h in hidden_existing
        if not any(w == h or w.is_relative_to(h) for w in writable)
    ]
    hidden_dirs = tuple(p for p in hidden_existing if p.is_dir())
    hidden_files = tuple(p for p in hidden_existing if not p.is_dir())

    return SandboxPolicy(
        writable=tuple(writable),
        read_only=tuple(read_only),
        hidden=hidden_dirs,
        hidden_files=hidden_files,
        allowlist=allowlist or allowlist_for(provider_hosts),
        tmp_dir=tmp_dir,
        cwd=Path(cwd).resolve() if cwd else project,
        readable=tuple(_existing(Path(p) for p in readable)),
    )


def install_dir(executable: str | Path) -> Path:
    """The directory a CLI runs from, as far as it needs to read.

    A Node CLI is a link in ``node_modules/.bin`` to a file of its package,
    which loads its dependencies from the same ``node_modules``: the parent
    of the outermost ``node_modules`` covers both. Anything else: the
    directory of the real file.
    """
    real = Path(os.path.realpath(executable))
    parts = real.parts
    if "node_modules" in parts:
        return Path(*parts[: parts.index("node_modules")])
    return real.parent
