"""
Base Analyzer Module
====================

Provides common constants, utilities, and base functionality shared across all analyzers.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# Directories to skip during analysis
SKIP_DIRS = {
    "node_modules",
    ".git",
    "__pycache__",
    ".venv",
    "venv",
    ".env",
    "env",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "target",
    "vendor",
    ".idea",
    ".vscode",
    ".pytest_cache",
    ".mypy_cache",
    "coverage",
    ".coverage",
    "htmlcov",
    "eggs",
    "*.egg-info",
    ".turbo",
    ".cache",
    ".worktrees",  # Skip git worktrees directory
    ".workpilot",  # Skip workpilot metadata directory
}

# Common service directory names
SERVICE_INDICATORS = {
    "backend",
    "frontend",
    "api",
    "web",
    "app",
    "server",
    "client",
    "worker",
    "workers",
    "services",
    "packages",
    "apps",
    "libs",
    "scraper",
    "crawler",
    "proxy",
    "gateway",
    "admin",
    "dashboard",
    "mobile",
    "desktop",
    "cli",
    "sdk",
    "core",
    "shared",
    "common",
}

# Files that indicate a service root
SERVICE_ROOT_FILES = {
    "package.json",
    "requirements.txt",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "Gemfile",
    "composer.json",
    "pom.xml",
    "build.gradle",
    "Makefile",
    "Dockerfile",
}


class BaseAnalyzer:
    """Base class with common utilities for all analyzers."""

    def __init__(self, path: Path):
        self.path = path.resolve()

    def _project_files(self, pattern: str) -> list[Path]:
        """Files of the project matching ``pattern``, outside SKIP_DIRS.

        A bare glob walked into ``.venv`` and ``node_modules``: the installed
        ``prometheus_client`` made every Python project "monitored", and
        Django's own migrations were listed as the project's. Only the parts
        under the project count, so a project kept in a folder named ``build``
        keeps its files.
        """
        files = []
        for file_path in sorted(self.path.glob(pattern)):
            parts = file_path.relative_to(self.path).parts[:-1]
            if any(part in SKIP_DIRS or part.endswith(".egg-info") for part in parts):
                continue
            files.append(file_path)
        return files

    def _python_requirements(self) -> set[str]:
        """Names in requirements.txt, normalised as pip compares them (PEP 503).

        ``PyJWT`` and ``SQLAlchemy`` are the usual spellings, and the
        detectors look for ``pyjwt`` and ``sqlalchemy``.
        """
        content = self._read_file("requirements.txt")
        names = re.findall(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)", content, re.MULTILINE)
        return {re.sub(r"[-_.]+", "-", name).lower() for name in names}

    def _exists(self, path: str) -> bool:
        """Check if a file exists relative to the analyzer's path."""
        return (self.path / path).exists()

    def _read_file(self, path: str) -> str:
        """Read a file relative to the analyzer's path."""
        try:
            return (self.path / path).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return ""

    def _read_json(self, path: str) -> dict | None:
        """Read and parse a JSON file relative to the analyzer's path."""
        content = self._read_file(path)
        if content:
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                return None
        return None

    def _infer_env_var_type(self, value: str) -> str:
        """Infer the type of an environment variable from its value."""
        if not value:
            return "string"

        # Boolean
        if value.lower() in ["true", "false", "1", "0", "yes", "no"]:
            return "boolean"

        # Number
        if value.isdigit():
            return "number"

        # URL
        if value.startswith(
            (
                "http://",
                "https://",
                "postgres://",
                "postgresql://",
                "mysql://",
                "mongodb://",
                "redis://",
            )
        ):
            return "url"

        # Email
        if "@" in value and "." in value:
            return "email"

        # Path
        if "/" in value or "\\" in value:
            return "path"

        return "string"
