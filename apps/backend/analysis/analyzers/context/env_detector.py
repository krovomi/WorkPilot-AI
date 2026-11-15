"""
Environment Variable Detector Module
=====================================

Detects and analyzes environment variables from multiple sources:
- .env files and variants
- .env.example files
- docker-compose.yml
- Source code (os.getenv, process.env)
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from ..base import BaseAnalyzer


class EnvironmentDetector(BaseAnalyzer):
    """Detects environment variables and their configurations."""

    def __init__(self, path: Path, analysis: dict[str, Any]):
        super().__init__(path)
        self.analysis = analysis

    def detect(self) -> None:
        """
        Discover all environment variables from multiple sources.

        Extracts from: .env files, docker-compose, example files.
        Categorizes as required/optional and detects sensitive data.
        """
        env_vars = {}
        required_vars = set()
        optional_vars = set()

        # Parse various sources
        self._parse_env_files(env_vars)
        self._parse_env_example(env_vars, required_vars)
        self._parse_docker_compose(env_vars)
        self._parse_code_references(env_vars, optional_vars, required_vars)

        # Mark required vs optional
        for key in env_vars:
            if "required" not in env_vars[key]:
                env_vars[key]["required"] = key in required_vars

        if env_vars:
            self.analysis["environment"] = {
                "variables": env_vars,
                "required_count": len(required_vars),
                "optional_count": len(optional_vars),
                "detected_count": len(env_vars),
            }

    def _parse_env_files(self, env_vars: dict[str, Any]) -> None:
        """Parse .env files and variants."""
        env_files = [
            ".env",
            ".env.local",
            ".env.development",
            ".env.production",
            ".env.dev",
            ".env.prod",
            ".env.test",
            ".env.staging",
            "config/.env",
            "../.env",
        ]

        for env_file in env_files:
            content = self._read_file(env_file)
            if not content:
                continue

            for line in content.split("\n"):
                line = line.strip()
                if not line or line.startswith("#"):
                    continue

                # Parse KEY=value or KEY="value" or KEY='value'
                # (`export KEY=value` is the shell form many .env files use)
                match = re.match(r"^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$", line)
                if match:
                    key = match.group(1)
                    value = match.group(2).strip().strip('"').strip("'")

                    # Detect if sensitive: by its name, or a URL that carries
                    # a password (DATABASE_URL=postgres://app:pw@db/app), which
                    # was copied as is into the project index.
                    is_sensitive = self._is_sensitive_key(key) or _has_credentials(
                        value
                    )

                    # Detect type
                    var_type = self._infer_env_var_type(value)

                    env_vars[key] = {
                        "value": "<REDACTED>" if is_sensitive else value,
                        "source": env_file,
                        "type": var_type,
                        "sensitive": is_sensitive,
                    }

    def _parse_env_example(
        self, env_vars: dict[str, Any], required_vars: set[str]
    ) -> None:
        """Parse .env.example to find required variables."""
        example_content = self._read_file(".env.example") or self._read_file(
            ".env.sample"
        )
        if not example_content:
            return

        for line in example_content.split("\n"):
            line = line.strip()
            if not line or line.startswith("#"):
                continue

            match = re.match(r"^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=", line)
            if match:
                key = match.group(1)
                required_vars.add(key)

                if key not in env_vars:
                    env_vars[key] = {
                        "value": None,
                        "source": ".env.example",
                        "type": "string",
                        "sensitive": self._is_sensitive_key(key),
                        "required": True,
                    }

    def _parse_docker_compose(self, env_vars: dict[str, Any]) -> None:
        """Parse docker-compose.yml environment section."""
        for compose_file in ["docker-compose.yml", "../docker-compose.yml"]:
            content = self._read_file(compose_file)
            if not content:
                continue

            # Look for environment variables in docker-compose: the list form
            # (`- KEY=value`) and the mapping form (`KEY: value`), until a line
            # at the "environment:" key's indentation or above.
            env_indent: int | None = None
            for line in content.split("\n"):
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                indent = len(line) - len(line.lstrip())
                if re.match(r"^environment\s*:\s*$", stripped):
                    env_indent = indent
                    continue

                if env_indent is not None:
                    # Check if we left the environment section
                    if indent <= env_indent and not stripped.startswith("-"):
                        env_indent = None
                        continue

                    # Parse - KEY=value, - KEY or KEY: value
                    match = re.match(r"^-\s*([A-Z_][A-Z0-9_]*)", stripped) or re.match(
                        r"^([A-Z_][A-Z0-9_]*)\s*:", stripped
                    )
                    if match:
                        key = match.group(1)
                        if key not in env_vars:
                            env_vars[key] = {
                                "value": None,
                                "source": compose_file,
                                "type": "string",
                                # By name, as in the .env files: a compose
                                # DB_PASSWORD was listed as not sensitive.
                                "sensitive": self._is_sensitive_key(key),
                            }

    def _parse_code_references(
        self,
        env_vars: dict[str, Any],
        optional_vars: set[str],
        required_vars: set[str],
    ) -> None:
        """Scan code for os.getenv() / process.env usage to find optional vars."""
        entry_files = [
            "app.py",
            "main.py",
            "config.py",
            "settings.py",
            "src/config.py",
            "src/settings.py",
            "index.js",
            "index.ts",
            "config.js",
            "config.ts",
        ]

        for entry_file in entry_files:
            content = self._read_file(entry_file)
            if not content:
                continue

            # Python: os.getenv("VAR") or os.environ.get("VAR") may be unset;
            # os.environ["VAR"] raises KeyError without it, so it is required
            # (it was listed as optional), and read first so that a later
            # getenv of the same name does not make it optional. JS: process.env.VAR.
            patterns = [
                (r'os\.environ\[["\']([A-Z_][A-Z0-9_]*)["\']', True),
                (r'os\.getenv\(["\']([A-Z_][A-Z0-9_]*)["\']', False),
                (r'os\.environ\.get\(["\']([A-Z_][A-Z0-9_]*)["\']', False),
                (r"process\.env\.([A-Z_][A-Z0-9_]*)", False),
            ]

            for pattern, required in patterns:
                for var_name in re.findall(pattern, content):
                    if var_name not in env_vars:
                        (required_vars if required else optional_vars).add(var_name)
                        env_vars[var_name] = {
                            "value": None,
                            "source": f"code:{entry_file}",
                            "type": "string",
                            "sensitive": self._is_sensitive_key(var_name),
                            "required": required,
                        }

    @staticmethod
    def _is_sensitive_key(key: str) -> bool:
        """Determine if an environment variable key contains sensitive data."""
        sensitive_keywords = [
            "secret",
            "key",
            "password",
            "token",
            "api_key",
            "private",
            "credential",
            "auth",
        ]
        return any(keyword in key.lower() for keyword in sensitive_keywords)


def _has_credentials(value: str) -> bool:
    """A URL with a user and password in it (``scheme://user:pw@host``)."""
    return bool(re.match(r"^[a-z][a-z0-9+.-]*://[^/@\s]*:[^/@\s]*@", value, re.I))
