"""Naming rules the project's own lint configuration already states.

A person with no history of their own starts from the project: what its
linters enforce weighs more than what its other authors happen to write.
Read at the root of the project and one folder below (a monorepo's apps):
ESLint (``camelcase``, ``@typescript-eslint/naming-convention``), Ruff,
Flake8 or Pylint with pep8-naming, ``.editorconfig`` .NET naming styles,
Dart's ``analysis_options.yaml``. Text search only, no config is executed.
"""

from __future__ import annotations

import re
from pathlib import Path

__all__ = ["lint_rules"]

MAX_BYTES = 256 * 1024
_ESLINT = (
    ".eslintrc",
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.yml",
    ".eslintrc.yaml",
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
)
_PYTHON = (
    "pyproject.toml",
    "ruff.toml",
    ".ruff.toml",
    "setup.cfg",
    ".flake8",
    ".pylintrc",
    "tox.ini",
)
_CAMEL_RULE = re.compile(
    r"""["']?camelcase["']?\s*:\s*\[?\s*["']?(?:error|warn|2|1)\b"""
)
_NAMING_CONVENTION = re.compile(r"naming-convention[\s\S]{0,400}?camelCase")
_PEP8_NAMING = re.compile(
    r"""(?:select|extend-select)\s*=\s*\[[^\]]*["']N\d*["']|naming-style\s*=\s*snake_case|pep8-naming"""
)
_DOTNET_STYLE = re.compile(
    r"dotnet_naming_style\.\w+\.capitalization\s*=\s*(camel_case|pascal_case)"
)


def _read(path: Path) -> str:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        return ""
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _folders(root: Path) -> list[Path]:
    folders = [root]
    try:
        children = sorted(
            p for p in root.iterdir() if p.is_dir() and not p.is_symlink()
        )
    except OSError:
        return folders
    skip = {
        ".git",
        ".workpilot",
        "node_modules",
        ".venv",
        "venv",
        "dist",
        "build",
        "bin",
        "obj",
    }
    folders.extend(p for p in children[:60] if p.name not in skip)
    return folders


def lint_rules(root: Path) -> list[tuple[str, str, str, str]]:
    """``(language, dimension, value, file)`` for each naming rule a config states."""
    rules: set[tuple[str, str, str, str]] = set()
    for folder in _folders(root):
        for name in _ESLINT:
            text = _read(folder / name)
            if text and (_CAMEL_RULE.search(text) or _NAMING_CONVENTION.search(text)):
                label = (folder / name).relative_to(root).as_posix()
                for language in ("javascript", "typescript"):
                    rules.add((language, "naming_variables", "camelCase", label))
                    rules.add((language, "naming_functions", "camelCase", label))
        for name in _PYTHON:
            text = _read(folder / name)
            if text and _PEP8_NAMING.search(text):
                label = (folder / name).relative_to(root).as_posix()
                rules.add(("python", "naming_variables", "snake_case", label))
                rules.add(("python", "naming_functions", "snake_case", label))
        text = _read(folder / ".editorconfig")
        if text:
            label = (folder / ".editorconfig").relative_to(root).as_posix()
            styles = set(_DOTNET_STYLE.findall(text))
            if "pascal_case" in styles:
                rules.add(("csharp", "naming_functions", "PascalCase", label))
            if "camel_case" in styles:
                rules.add(("csharp", "naming_variables", "camelCase", label))
        text = _read(folder / "analysis_options.yaml")
        if text and "non_constant_identifier_names" in text:
            label = (folder / "analysis_options.yaml").relative_to(root).as_posix()
            rules.add(("dart", "naming_variables", "camelCase", label))
            rules.add(("dart", "naming_functions", "camelCase", label))
    return sorted(rules)
