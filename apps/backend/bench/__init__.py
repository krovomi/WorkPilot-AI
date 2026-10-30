"""Repo bench: replay finished cards and judge them with their own tests.

Ten to twenty finished cards are rebuilt from the commit before them, once
per engine (provider × model × effort), each in an isolated copy that does
not hold the answer. The judge is the tests the card added or changed, taken
from the commit it landed as and never shown to the replaying agent. The
table it fills feeds Formula Lab and the model router.

A leaf above ``foundation``: git, files and test runners, no LLM.
See ``docs/architecture/repo-bench.md``.
"""

from .layout import BenchError, data_root, main_project
from .lifecycle import (
    MAX_CANDIDATES,
    MAX_CASES,
    MAX_VARIANTS,
    Engine,
    discard,
    discover,
    judge_build,
    parse_commits,
    parse_engines,
    parse_specs,
    prepare,
    read_manifest,
)
from .results import (
    history_samples,
    recommendations,
    router_verdict,
    scores,
    table,
)

__all__ = [
    "MAX_CANDIDATES",
    "MAX_CASES",
    "MAX_VARIANTS",
    "BenchError",
    "Engine",
    "data_root",
    "discard",
    "discover",
    "history_samples",
    "recommendations",
    "judge_build",
    "main_project",
    "parse_commits",
    "parse_engines",
    "parse_specs",
    "prepare",
    "read_manifest",
    "router_verdict",
    "scores",
    "table",
]
