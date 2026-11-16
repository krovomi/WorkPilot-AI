"""The estimate broken down by dimension, so a person sees where it is unsure.

Four dimensions: algorithmic complexity, integration complexity, conflict
risk and test effort. Each is read from the words of the task and the number
of files the estimator expects to touch; a dimension with no signal at all is
marked ``uncertain`` rather than reported as low.
"""

from __future__ import annotations

from typing import Any

from .categories import words

DIMENSIONS: tuple[tuple[str, frozenset[str]], ...] = (
    (
        "algorithmic",
        frozenset(
            {
                "algorithm",
                "optimize",
                "optimise",
                "performance",
                "distributed",
                "concurrency",
                "async",
                "parallel",
                "cache",
                "realtime",
                "recursive",
                "graph",
                "parser",
            }
        ),
    ),
    (
        "integration",
        frozenset(
            {
                "integration",
                "integrate",
                "api",
                "endpoint",
                "webhook",
                "oauth",
                "sdk",
                "database",
                "queue",
                "service",
                "external",
                "multiple",
                "sync",
            }
        ),
    ),
    (
        "conflict_risk",
        frozenset(
            {
                "refactor",
                "rename",
                "migration",
                "breaking",
                "shared",
                "core",
                "global",
                "rewrite",
                "dependency",
                "upgrade",
            }
        ),
    ),
    (
        "test_effort",
        frozenset(
            {
                "test",
                "tests",
                "security",
                "authentication",
                "auth",
                "payment",
                "migration",
                "realtime",
                "async",
                "e2e",
                "regression",
            }
        ),
    ),
)

#: Files the estimator expects to touch past which a dimension gets a signal.
_FILE_SIGNALS = {"conflict_risk": 7, "test_effort": 3}


def breakdown(description: str, files: int) -> list[dict[str, Any]]:
    """One entry per dimension: ``key``, ``level``, ``signals``, ``uncertain``."""
    found = words(description)
    result = []
    for key, keywords in DIMENSIONS:
        signals = sorted(found & keywords)
        threshold = _FILE_SIGNALS.get(key)
        if threshold is not None and files > threshold:
            signals.append("files")
        level = ("low", "medium", "high")[min(2, len(signals))]
        result.append(
            {
                "key": key,
                "level": level,
                "signals": signals,
                "uncertain": not signals,
            }
        )
    return result
