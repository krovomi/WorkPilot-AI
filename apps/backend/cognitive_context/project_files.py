"""Which files of a project the optimizer may read.

Two jobs, both bounded by the project root:

* :func:`resolve_candidates` turns the paths a caller sends (relative to the
  project, or absolute) into files inside the project. A path that resolves
  elsewhere, a missing file, a binary file or one too large to be context is
  refused with a reason; nothing outside the root is ever opened.
* :func:`discover_candidates` lists the project's own text sources when the
  caller sends none, for every stack (C#, Java, Kotlin, Go, Rust, PHP, Swift,
  Dart, Python, TypeScript, Vue, Razor…), ranked by how many prompt keywords
  their path carries, then by recency.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

# Folders that hold dependencies, build output or tool state, in every stack.
SKIP_DIRS = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".workpilot",
        ".idea",
        ".vs",
        ".vscode",
        "node_modules",
        "bower_components",
        "dist",
        "build",
        "out",
        "target",
        "bin",
        "obj",
        "vendor",
        "Pods",
        "DerivedData",
        ".gradle",
        ".dart_tool",
        ".next",
        ".nuxt",
        ".svelte-kit",
        ".angular",
        ".venv",
        "venv",
        "env",
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".tox",
        "coverage",
        "htmlcov",
    }
)

# Source and configuration files a coding task reads, across stacks.
SOURCE_SUFFIXES = frozenset(
    {
        # .NET
        ".cs", ".fs", ".vb", ".razor", ".cshtml", ".csproj", ".fsproj", ".props",
        ".targets", ".sln", ".slnx",
        # JVM
        ".java", ".kt", ".kts", ".scala", ".groovy", ".gradle",
        # Systems
        ".go", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".zig",
        # Mobile
        ".swift", ".m", ".mm", ".dart",
        # Web
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
        ".astro", ".html", ".css", ".scss", ".less",
        # Scripting
        ".py", ".rb", ".php", ".ex", ".exs", ".erl", ".lua", ".pl", ".r",
        ".sh", ".ps1",
        # Data and configuration
        ".sql", ".graphql", ".proto", ".json", ".yaml", ".yml", ".toml", ".xml",
        ".md",
    }
)  # fmt: skip

# Manifests without a telling suffix.
SOURCE_NAMES = frozenset(
    {"Dockerfile", "Makefile", "Gemfile", "Rakefile", "go.mod", "Cargo.toml"}
)

MAX_FILE_BYTES = 512_000
MAX_DISCOVERED = 300
# Walking stops after this many files, so a huge monorepo stays bounded.
MAX_WALKED = 20_000

_SNIFF_BYTES = 8_192
_WORD = re.compile(r"[A-Za-z][A-Za-z0-9]{2,}")


@dataclass(frozen=True)
class Refusal:
    path: str
    reason: str  # outside | missing | binary | too_large

    def to_dict(self) -> dict[str, str]:
        return {"path": self.path, "reason": self.reason}


def _is_binary(path: Path) -> bool:
    with path.open("rb") as handle:
        return b"\x00" in handle.read(_SNIFF_BYTES)


def _relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def resolve_candidates(
    project_dir: Path, raw_paths: Iterable[str | Path]
) -> tuple[list[str], list[Refusal]]:
    """Paths inside ``project_dir`` (relative, POSIX), and what was refused.

    ``project_dir`` is expected resolved (``validated_dir``). Each path is
    resolved, symlinks included, before the containment check.
    """
    base = os.path.realpath(project_dir)
    root = Path(base)
    prefix = base if base.endswith(os.sep) else base + os.sep
    accepted: list[str] = []
    refused: list[Refusal] = []
    seen: set[str] = set()
    for raw in raw_paths:
        text = str(raw).strip()
        if not text:
            continue
        # realpath, then a prefix check on the result, before any file access:
        # an absolute path replaces the root in the join and is held to the
        # same check. ``~`` is not expanded: a caller's path is the project's.
        try:
            real = os.path.realpath(os.path.join(base, text))
        except (OSError, ValueError):
            refused.append(Refusal(text, "missing"))
            continue
        if real != base and not real.startswith(prefix):
            refused.append(Refusal(text, "outside"))
            continue
        resolved = Path(real)
        try:
            if not resolved.is_file():
                refused.append(Refusal(text, "missing"))
                continue
            if resolved.stat().st_size > MAX_FILE_BYTES:
                refused.append(Refusal(text, "too_large"))
                continue
            if _is_binary(resolved):
                refused.append(Refusal(text, "binary"))
                continue
        except OSError:
            refused.append(Refusal(text, "missing"))
            continue
        rel = _relative(resolved, root)
        if rel not in seen:
            seen.add(rel)
            accepted.append(rel)
    return accepted, refused


def _is_source(name: str) -> bool:
    if name in SOURCE_NAMES:
        return True
    return os.path.splitext(name)[1].lower() in SOURCE_SUFFIXES


def discover_candidates(
    project_dir: Path, prompt: str, limit: int = MAX_DISCOVERED
) -> list[str]:
    """The project's text sources most likely to matter for ``prompt``."""
    root = project_dir.resolve()
    words = {w.lower() for w in _WORD.findall(prompt)}
    found: list[tuple[int, float, str]] = []
    walked = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")
        )
        for name in sorted(filenames):
            if not _is_source(name):
                continue
            walked += 1
            if walked > MAX_WALKED:
                break
            path = Path(dirpath) / name
            try:
                stat = path.stat()
            except OSError:
                continue
            if stat.st_size == 0 or stat.st_size > MAX_FILE_BYTES:
                continue
            rel = _relative(path, root)
            lowered = rel.lower()
            hits = sum(1 for w in words if w in lowered)
            found.append((hits, stat.st_mtime, rel))
        if walked > MAX_WALKED:
            break
    found.sort(key=lambda item: (-item[0], -item[1], item[2]))
    return [rel for _hits, _mtime, rel in found[:limit]]
