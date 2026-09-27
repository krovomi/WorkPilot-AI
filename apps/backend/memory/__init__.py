#!/usr/bin/env python3
"""
Session Memory System
=====================

Persists learnings between autonomous coding sessions to avoid rediscovering
codebase patterns, gotchas, and insights.

One store: the shared Obsidian vault
------------------------------------

Everything a build learns is written to the WorkPilot Brain — the Obsidian
vault every agent reads (`brain.project_memory`):

    <brain>/knowledge/projects/<project>/memory/
        ├── codebase/<file>.md          # what a file is for
        ├── patterns/<slug>.md          # code patterns to follow
        ├── gotchas/<slug>.md           # pitfalls to avoid
        ├── outcomes/<slug>.md          # how an approach went, and why
        └── sessions/<spec>/session-NNN.md

It used to be Graphiti when ``GRAPHITI_ENABLED`` was set and JSON/Markdown files
under ``<spec_dir>/memory/`` otherwise; the spec files still found on disk are
imported into the vault on first use and set aside. Memory is per *project*,
not per spec: the next task on the same project starts from what this one
learned.

Public API (unchanged):
    - get_project_memory(spec_dir, project_dir=None) -> ProjectMemory | None
    - is_memory_enabled() / is_graphiti_memory_enabled() -> bool
    - save_session_insights / load_all_insights
    - update_codebase_map / load_codebase_map
    - append_pattern / load_patterns / append_gotcha / load_gotchas
    - get_memory_summary
    - get_memory_dir / get_session_insights_dir / clear_memory (legacy path only)
"""

# Codebase map
from .codebase_map import load_codebase_map, update_codebase_map
from .graphiti_helpers import is_graphiti_memory_enabled

# Directory management
from .paths import clear_memory, get_memory_dir, get_session_insights_dir

# Patterns and gotchas
from .patterns import (
    append_gotcha,
    append_pattern,
    load_gotchas,
    load_patterns,
)

# Session insights
from .sessions import load_all_insights, save_session_insights
from .store import get_project_memory, is_memory_enabled

# Summary utilities
from .summary import get_memory_summary

__all__ = [
    # The store
    "get_project_memory",
    "is_memory_enabled",
    "is_graphiti_memory_enabled",
    # Directory management
    "get_memory_dir",
    "get_session_insights_dir",
    "clear_memory",
    # Session insights
    "save_session_insights",
    "load_all_insights",
    # Codebase map
    "update_codebase_map",
    "load_codebase_map",
    # Patterns and gotchas
    "append_pattern",
    "load_patterns",
    "append_gotcha",
    "load_gotchas",
    # Summary
    "get_memory_summary",
]
