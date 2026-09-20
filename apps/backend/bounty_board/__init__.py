"""
Bounty Board — Competitive multi-agent mode.

Runs N contestants in parallel against the same spec, each with a
(provider, model, prompt) combination. Each works in its own git worktree; the
judge then measures what each one left on disk — the project's own test suite
against the change, and an anonymised read of the diff against the spec — and
picks a winner.

Public surface:
    from bounty_board import (
        BountyBoard,
        Contestant,
        BountyResult,
        ContestantSpec,
        run_bounty,
    )
"""

from .board import BountyBoard, run_bounty
from .judge import Criterion, Verdict, evidence_judge, score_contestant
from .models import BountyResult, Contestant, ContestantSpec
from .signals import Evidence, collect_evidence, discover_test_command

__all__ = [
    "BountyBoard",
    "BountyResult",
    "Contestant",
    "ContestantSpec",
    "Criterion",
    "Evidence",
    "Verdict",
    "collect_evidence",
    "discover_test_command",
    "evidence_judge",
    "run_bounty",
    "score_contestant",
]
