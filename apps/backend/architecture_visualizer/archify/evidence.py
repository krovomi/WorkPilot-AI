"""Collects evidence about a project's architecture and structure.

This module analyzes a project's dependencies, code structure, and configuration
to build evidence used in architecture model generation.
"""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class EvidenceCollector:
    """Collects architectural evidence from a project."""

    def __init__(self, project_dir: Path):
        """Initialize the collector for a project.

        Args:
            project_dir: The root directory of the project.
        """
        self.project_dir = project_dir

    def collect_dependencies(self) -> dict[str, list[str]]:
        """Collect dependency information from the project.

        Returns:
            A dictionary mapping dependency managers to lists of dependencies.
        """
        deps = {}

        # Python dependencies
        pyproject = self.project_dir / "pyproject.toml"
        if pyproject.exists():
            try:
                import tomllib

                with open(pyproject, "rb") as f:
                    data = tomllib.load(f)
            except Exception as exc:  # noqa: BLE001
                logger.debug("Failed to parse pyproject.toml: %s", exc)
                data = {}
            raw = (data.get("project") or {}).get("dependencies") or []
            names = [
                str(d)
                .split("[")[0]
                .split("=")[0]
                .split(">")[0]
                .split("<")[0]
                .strip()
                for d in raw
                if isinstance(d, str)
            ]
            deps["python"] = names

        # Node.js dependencies
        package_json = self.project_dir / "package.json"
        if package_json.exists():
            try:
                with open(package_json, encoding="utf-8") as f:
                    data = json.load(f)
            except Exception as exc:  # noqa: BLE001
                logger.debug("Failed to parse package.json: %s", exc)
                data = {}
            deps["npm"] = list((data.get("dependencies") or {}).keys())

        return deps

    def collect_code_structure(self) -> dict[str, Any]:
        """Analyze the code structure of the project.

        Returns:
            A dictionary with structure information (modules, classes, functions).
        """
        structure = {"modules": [], "classes": [], "functions": []}

        # Walk through Python files
        for py_file in self.project_dir.glob("**/*.py"):
            if "__pycache__" in py_file.parts:
                continue
            try:
                import ast

                content = py_file.read_text(encoding="utf-8")
                tree = ast.parse(content)

                for node in ast.walk(tree):
                    if isinstance(node, ast.ClassDef):
                        structure["classes"].append(
                            {
                                "name": node.name,
                                "file": str(py_file.relative_to(self.project_dir)),
                            }
                        )
                    elif isinstance(node, ast.FunctionDef):
                        structure["functions"].append(
                            {
                                "name": node.name,
                                "file": str(py_file.relative_to(self.project_dir)),
                            }
                        )
            except Exception as exc:  # noqa: BLE001
                logger.debug("Failed to parse %s: %s", py_file, exc)

        return structure

    def collect_all(self) -> dict[str, Any]:
        """Collect all available evidence.

        Returns:
            A comprehensive dictionary of all collected evidence.
        """
        return {
            "dependencies": self.collect_dependencies(),
            "structure": self.collect_code_structure(),
        }
