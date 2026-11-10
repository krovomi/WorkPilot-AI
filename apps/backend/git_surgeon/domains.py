"""The part of a project a path belongs to, the same for every stack.

A commit is split, and fix-ups grouped, along these parts: ``tests``, ``docs``,
``ci``, ``db`` (migrations and schema), ``build`` (manifests and lock files,
any ecosystem), otherwise the first folder that names something (``frontend``
for ``apps/frontend/src/x.ts``, ``Orders`` for ``src/Orders/Api.cs``).
"""

from __future__ import annotations

import re
from pathlib import PurePosixPath

_TEST_DIRS = {
    "test",
    "tests",
    "__tests__",
    "spec",
    "specs",
    "e2e",
    "testing",
    "integrationtests",
    "unittests",
}
_TEST_FILE = re.compile(
    r"(^test_.*\.py$|_test\.(py|go|exs?|dart)$|\.(test|spec)\.[cm]?[jt]sx?$|_spec\.rb$"
    r"|tests?\.(cs|fs|vb)$|tests?\.(java|kt|scala|swift|php)$|_test\.rs$|\.test\.php$)",
    re.IGNORECASE,
)
_DOC_EXT = {".md", ".mdx", ".rst", ".adoc", ".txt"}
_CI = re.compile(
    r"^(\.github/(workflows|actions)/|\.gitlab-ci\.yml$|\.circleci/|azure-pipelines|"
    r"jenkinsfile$|\.buildkite/|bitbucket-pipelines\.yml$|\.drone\.yml$|\.travis\.yml$)",
    re.IGNORECASE,
)
_DB_DIRS = {
    "migrations",
    "migration",
    "alembic",
    "prisma",
    "db",
    "database",
    "flyway",
    "liquibase",
    "schema",
}
_BUILD_FILES = {
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "pnpm-workspace.yaml",
    "pyproject.toml",
    "poetry.lock",
    "uv.lock",
    "pipfile",
    "pipfile.lock",
    "setup.py",
    "setup.cfg",
    "cargo.toml",
    "cargo.lock",
    "go.mod",
    "go.sum",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "gradle.properties",
    "composer.json",
    "composer.lock",
    "gemfile",
    "gemfile.lock",
    "pubspec.yaml",
    "pubspec.lock",
    "package.swift",
    "package.resolved",
    "podfile",
    "podfile.lock",
    "directory.build.props",
    "directory.packages.props",
    "global.json",
    "nuget.config",
    "mix.exs",
    "mix.lock",
    "dockerfile",
    "makefile",
    "cmakelists.txt",
}
_BUILD_EXT = {".csproj", ".fsproj", ".vbproj", ".sln", ".slnx"}
_GENERIC = {
    "src",
    "source",
    "sources",
    "app",
    "apps",
    "lib",
    "libs",
    "packages",
    "package",
    "modules",
    "main",
    "java",
    "kotlin",
    "scala",
    "com",
    "org",
    "net",
    "io",
    "internal",
    "pkg",
    "cmd",
    "code",
    "projects",
    "services",
    "renderer",
}
ORDER = ("db", "build", "tests", "docs", "ci")


def domain_of(path: str) -> str:
    p = PurePosixPath(path.replace("\\", "/"))
    parts = [x.lower() for x in p.parts]
    name = parts[-1] if parts else ""
    if _CI.match(path):
        return "ci"
    if (
        name in _BUILD_FILES
        or p.suffix.lower() in _BUILD_EXT
        or name.startswith("requirements")
    ):
        return "build"
    if any(x in _TEST_DIRS for x in parts[:-1]) or _TEST_FILE.search(name):
        return "tests"
    if any(x in _DB_DIRS for x in parts[:-1]) or p.suffix.lower() == ".sql":
        return "db"
    if p.suffix.lower() in _DOC_EXT and (
        len(parts) == 1 or "docs" in parts or "doc" in parts
    ):
        return "docs"
    if "docs" in parts[:-1] or "doc" in parts[:-1]:
        return "docs"
    for original, lower in zip(p.parts[:-1], parts[:-1], strict=False):
        if lower not in _GENERIC and not lower.startswith("."):
            return original
    return "root"


def domains_of(paths: list[str]) -> list[str]:
    """The parts touched, in the order a split commits them."""
    found = {domain_of(p) for p in paths}
    rank = {d: i for i, d in enumerate(ORDER)}
    return sorted(found, key=lambda d: (rank.get(d, 1.5), d))
