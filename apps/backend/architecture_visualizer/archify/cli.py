"""Command-line interface for the architecture visualizer.

This module provides CLI utilities for validating, analyzing, and delivering
architecture diagrams and models.
"""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class Readiness:
    """Represents the readiness status of the archify tooling."""

    ready: bool
    blockers: list[Blocker]


@dataclass
class Blocker:
    """Represents a single blocker preventing archify from running."""

    name: str
    detail: str


class NotReadyError(Exception):
    """Raised when archify is not ready to run."""

    def __init__(self, readiness: Readiness):
        self.readiness = readiness
        blockers = (
            "; ".join(f"{c.name}: {c.detail}" for c in readiness.blockers)
            or "unknown"
        )
        super().__init__(f"archify is unavailable ({blockers})")


@dataclass
class Receipt:
    """Represents the result of an archify operation."""

    ok: bool
    command: str
    payload: dict[str, Any]

    def summary(self) -> str:
        """Get a human-readable summary of the receipt."""
        if self.ok:
            return f"{self.command} succeeded"
        diagnostics = self.payload.get("diagnostics", [])
        if diagnostics:
            return "; ".join(
                d.get("message", d.get("code", "unknown")) for d in diagnostics[:3]
            )
        return f"{self.command} failed"

    @property
    def error_count(self) -> int:
        """Count of errors in the diagnostics."""
        return len(self.payload.get("diagnostics", []))


def check_readiness() -> Readiness:
    """Check if archify is ready to run.

    Returns:
        A Readiness object indicating whether archify can run and any blockers.
    """
    blockers = []

    # Check for required tools
    try:
        subprocess.run(
            ["which", "node"],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError:
        blockers.append(Blocker("node", "Node.js is not installed or not in PATH"))

    try:
        subprocess.run(
            ["which", "npm"],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError:
        blockers.append(Blocker("npm", "npm is not installed or not in PATH"))

    return Readiness(
        ready=len(blockers) == 0,
        blockers=blockers,
    )


def validate(model: dict[str, Any]) -> Receipt:
    """Validate an architecture model.

    Args:
        model: The model to validate.

    Returns:
        A Receipt indicating success or failure.
    """
    readiness = check_readiness()
    if not readiness.ready:
        raise NotReadyError(readiness)

    # Implementation would call the actual validation CLI
    return Receipt(
        ok=True,
        command="validate",
        payload={"ok": True},
    )


def deliver(model: dict[str, Any] | Path, output_path: Path) -> Receipt:
    """Deliver an architecture model as an artifact.

    Args:
        model: The model to deliver (as dict or path to model file).
        output_path: Where to write the delivered artifact.

    Returns:
        A Receipt indicating success or failure.
    """
    readiness = check_readiness()
    if not readiness.ready:
        raise NotReadyError(readiness)

    try:
        if isinstance(model, Path):
            content = model.read_text(encoding="utf-8")
        else:
            content = json.dumps(model, indent=2)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(content, encoding="utf-8")

        return Receipt(
            ok=True,
            command="deliver",
            payload={"path": str(output_path)},
        )
    except Exception as exc:
        logger.error("Failed to deliver model: %s", exc)
        return Receipt(
            ok=False,
            command="deliver",
            payload={"diagnostics": [{"code": "io/write_failed", "message": str(exc)}]},
        )
