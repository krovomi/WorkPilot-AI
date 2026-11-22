"""Conflict score of a pair of cards, from the files both of them touch.

Same rules as the desktop (``main/conflict-waves/scorer.ts``): a shared file
weighs by what it is for the whole build, never by its language (3 for a
dependency manifest or lockfile, 2 for shared configuration, 1 otherwise).
Paths compare without case, ``\\`` or ``./``.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping

#: Two cards editing it nearly always conflict: manifests and lockfiles.
DEPENDENCY_FILES = frozenset(
    {
        "package.json",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "yarn.lock",
        "bun.lockb",
        "bun.lock",
        "deno.json",
        "deno.lock",
        "pyproject.toml",
        "poetry.lock",
        "uv.lock",
        "pipfile",
        "pipfile.lock",
        "setup.py",
        "setup.cfg",
        "go.mod",
        "go.sum",
        "go.work",
        "cargo.toml",
        "cargo.lock",
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
        "gradle.properties",
        "libs.versions.toml",
        "gemfile",
        "gemfile.lock",
        "composer.json",
        "composer.lock",
        "pubspec.yaml",
        "pubspec.lock",
        "package.swift",
        "package.resolved",
        "podfile",
        "podfile.lock",
        "mix.exs",
        "mix.lock",
        "directory.packages.props",
        "directory.build.props",
        "packages.config",
        "cmakelists.txt",
        "conanfile.txt",
        "vcpkg.json",
        "build.sbt",
        "stack.yaml",
        "cabal.project",
    }
)

#: Suffixes of project files that list dependencies (.NET, Ruby, Haskell…).
DEPENDENCY_SUFFIXES = (
    ".csproj",
    ".fsproj",
    ".vbproj",
    ".sln",
    ".slnx",
    ".gemspec",
    ".cabal",
    ".nimble",
    ".rockspec",
)

_REQUIREMENTS = re.compile(r"^requirements[^/]*\.(txt|in)$")

#: Shared configuration: read by every part of the build.
CONFIG_PATTERNS = tuple(
    re.compile(pattern)
    for pattern in (
        r"(^|/)\.env(\.[^/]*)?$",
        r"(^|/)[^/]*\.config\.[cm]?[jt]s$",
        r"(^|/)tsconfig[^/]*\.json$",
        r"(^|/)dockerfile[^/]*$",
        r"(^|/)docker-compose[^/]*\.ya?ml$",
        r"(^|/)makefile$",
        r"(^|/)\.github/workflows/",
        r"(^|/)\.gitlab-ci\.ya?ml$",
        r"(^|/)azure-pipelines[^/]*\.ya?ml$",
        r"(^|/)appsettings[^/]*\.json$",
        r"\.(ya?ml|toml|ini|cfg|properties)$",
    )
)

#: Each coupled pair of files between two cards adds 1, at most this much.
MAX_FRAGILE_WEIGHT = 3

#: normalized path -> the path as first written.
Footprint = dict[str, str]
#: normalized path -> the files the history changed together with it.
CoChangeIndex = Mapping[str, frozenset[str]]


def normalize_path(file: str) -> str:
    """The comparison form of a path: no ``\\``, no leading ``./`` or ``/``, lower case."""
    normalized = file.strip().replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized.lstrip("/").lower()


def display_sort(values: Iterable[str]) -> list[str]:
    """Paths sorted for a reader: without case first, then as written."""
    return sorted(values, key=lambda value: (value.casefold(), value))


def file_weight(normalized_path: str) -> int:
    """3 dependency file, 2 shared configuration, 1 otherwise."""
    base = normalized_path[normalized_path.rfind("/") + 1 :]
    if base in DEPENDENCY_FILES or _REQUIREMENTS.match(base):
        return 3
    if base.endswith(DEPENDENCY_SUFFIXES):
        return 3
    if any(pattern.search(normalized_path) for pattern in CONFIG_PATTERNS):
        return 2
    return 1


def risk_level(score: int) -> str:
    if score <= 0:
        return "none"
    if score < 2:
        return "low"
    if score < 4:
        return "medium"
    if score < 8:
        return "high"
    return "critical"


def build_footprint(*lists: Iterable[object]) -> Footprint:
    footprint: Footprint = {}
    for values in lists:
        for file in values:
            if not isinstance(file, str) or not file.strip():
                continue
            normalized = normalize_path(file)
            if normalized and normalized not in footprint:
                footprint[normalized] = file.strip().replace("\\", "/")
    return footprint


def score_pair(a: Footprint, b: Footprint) -> tuple[int, list[str]]:
    """The summed weight of the shared files, and those files (display paths, sorted)."""
    score = 0
    shared: list[str] = []
    for normalized, display in a.items():
        if normalized in b:
            score += file_weight(normalized)
            shared.append(display)
    return score, display_sort(shared)


def fragile_links(a: Footprint, b: Footprint, index: CoChangeIndex) -> list[str]:
    """``x ↔ y``: coupled files, one in each card and neither shared, sorted."""
    links: set[str] = set()
    for x, shown_x in a.items():
        if x in b:
            continue
        for y in index.get(x, ()):
            if y in a or y not in b:
                continue
            links.add(f"{shown_x} ↔ {b[y]}")
    return display_sort(links)
