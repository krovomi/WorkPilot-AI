"""The category a spec is calibrated in, decided from its words.

The same closed list on both sides of the IPC boundary
(``shared/types/smart-estimation.ts``). Keywords name concepts every stack
shares (a page, an endpoint, a pipeline), not one language's file types.
"""

from __future__ import annotations

import re

CATEGORIES: tuple[str, ...] = ("bug_fix", "infra", "frontend", "backend", "feature")
"""Closed list. The first rule that matches wins; ``feature`` is the default."""

_RULES: tuple[tuple[str, frozenset[str]], ...] = (
    (
        "bug_fix",
        frozenset(
            {"bug", "bugfix", "fix", "fixes", "crash", "regression", "broken", "hotfix"}
        ),
    ),
    (
        "infra",
        frozenset(
            {
                "ci",
                "cd",
                "pipeline",
                "docker",
                "dockerfile",
                "deploy",
                "deployment",
                "kubernetes",
                "helm",
                "terraform",
                "infrastructure",
                "infra",
                "workflow",
            }
        ),
    ),
    (
        "frontend",
        frozenset(
            {
                "ui",
                "ux",
                "page",
                "screen",
                "component",
                "button",
                "form",
                "css",
                "style",
                "layout",
                "frontend",
                "view",
                "modal",
                "dialog",
            }
        ),
    ),
    (
        "backend",
        frozenset(
            {
                "api",
                "endpoint",
                "route",
                "database",
                "migration",
                "schema",
                "server",
                "backend",
                "service",
                "query",
                "queue",
            }
        ),
    ),
)


def words(text: str) -> set[str]:
    """The lower-case words of *text*."""
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def categorize(description: str) -> str:
    """The category of a task described by *description*."""
    found = words(description)
    for category, keywords in _RULES:
        if found & keywords:
            return category
    return "feature"


def valid_category(value: object) -> str | None:
    """*value* when it names a category of the closed list, else None."""
    return value if isinstance(value, str) and value in CATEGORIES else None
