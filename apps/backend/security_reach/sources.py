"""The project's source files, read once, bounded, for the reach analysis.

Any language counts: the analysis reads text, not one language's syntax. A
symbolic link is not followed (a repository cannot point the walk at the rest
of the disk), and the folders that hold no code of the project's own are
skipped.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

__all__ = ["SOURCE_SUFFIXES", "Sources", "is_test_path", "read_sources"]

SOURCE_SUFFIXES = frozenset(
    {
        ".py",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".vue",
        ".svelte",
        ".go",
        ".java",
        ".kt",
        ".kts",
        ".scala",
        ".groovy",
        ".cs",
        ".fs",
        ".vb",
        ".rb",
        ".php",
        ".rs",
        ".swift",
        ".dart",
        ".ex",
        ".exs",
        ".c",
        ".h",
        ".cc",
        ".cpp",
        ".hpp",
    }
)
#: Manifests read for their entry points and their declared dependencies.
MANIFEST_NAMES = frozenset(
    {
        "package.json",
        "pyproject.toml",
        "setup.cfg",
        "Procfile",
        "Dockerfile",
        "docker-compose.yml",
        "docker-compose.yaml",
        "serverless.yml",
        "app.yaml",
        "go.mod",
        "Cargo.toml",
        "Gemfile",
        "composer.json",
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
    }
)
_MANIFEST_PATTERNS = (re.compile(r"^requirements.*\.txt$"), re.compile(r".*\.csproj$"))
SKIP_DIRS = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".venv",
        "venv",
        "env",
        "node_modules",
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
        ".tox",
        "dist",
        "build",
        "out",
        "target",
        "bin",
        "obj",
        ".next",
        ".nuxt",
        "coverage",
        "vendor",
        ".workpilot",
    }
)
MAX_FILES = 20_000
MAX_FILE_BYTES = 512 * 1024

_TEST_DIRS = frozenset(
    {"test", "tests", "__tests__", "spec", "specs", "testing", "e2e"}
)
_TEST_NAME = re.compile(
    r"(^test_.+\.py$|.+_test\.(py|go|rb|exs)$|.+\.(test|spec)\.[cm]?[jt]sx?$"
    r"|.+(Test|Tests|Spec)\.(java|kt|cs|scala|swift)$|.+_spec\.rb$|.+_test\.dart$)"
)


def is_test_path(rel: str) -> bool:
    path = PurePosixPath(rel)
    if any(part.lower() in _TEST_DIRS for part in path.parts[:-1]):
        return True
    return bool(_TEST_NAME.match(path.name))


def _is_manifest(name: str) -> bool:
    return name in MANIFEST_NAMES or any(p.match(name) for p in _MANIFEST_PATTERNS)


@dataclass
class Sources:
    #: Repository-relative POSIX path → text, for each source file.
    files: dict[str, str] = field(default_factory=dict)
    #: The same, for each manifest.
    manifests: dict[str, str] = field(default_factory=dict)
    #: The walk stopped at ``MAX_FILES``.
    truncated: bool = False


def _read(path: Path) -> str | None:
    try:
        if path.is_symlink() or path.stat().st_size > MAX_FILE_BYTES:
            return None
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None


def read_sources(project_dir: Path) -> Sources:
    sources = Sources()
    root = Path(project_dir)
    count = 0
    for current, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        base = Path(current)
        for name in sorted(names):
            is_source = Path(name).suffix.lower() in SOURCE_SUFFIXES
            is_manifest = _is_manifest(name)
            if not (is_source or is_manifest):
                continue
            if count >= MAX_FILES:
                sources.truncated = True
                return sources
            text = _read(base / name)
            if text is None:
                continue
            count += 1
            rel = (base / name).relative_to(root).as_posix()
            (sources.files if is_source else sources.manifests)[rel] = text
    return sources
