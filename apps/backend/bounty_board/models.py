"""
Bounty Board — the data model the whole package shares.

It lives here rather than in `board.py` because of which way the dependencies
have to point. `judge` and `runner` both speak in `Contestant`s, and while they
were reaching up into the orchestrator for that type, the package's import graph
described a cycle: board → judge → board. Nothing broke at runtime — the reach
was under `if TYPE_CHECKING`, so it never executed — but the *shape* was wrong
in a way CodeQL was right to flag, and the fix for a wrong dependency direction
is to move the shared thing underneath both sides rather than to silence the
report.

Nothing in this module imports anything else from the package, which is the
property worth keeping: it is the bottom of the graph.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

__all__ = [
    "BountyResult",
    "Contestant",
    "ContestantRunner",
    "ContestantSpec",
    "Judge",
]


@dataclass
class ContestantSpec:
    """Inputs describing a single contestant entry."""

    provider: str
    model: str
    profile_id: str | None = None
    prompt_override: str | None = None
    label: str | None = None  # Human-readable label, auto-assigned if None


@dataclass
class Contestant:
    """Live state of a contestant during a bounty run."""

    id: str
    label: str
    provider: str
    model: str
    profile_id: str | None = None
    prompt_override: str | None = None
    status: str = "queued"  # queued | running | completed | error | archived | winner
    worktree_path: str | None = None
    branch: str | None = None
    base_ref: str | None = None
    spec_dir: str | None = None
    output: str = ""
    tokens_used: int = 0
    cost_usd: float = 0.0
    duration_ms: int = 0
    error: str | None = None
    score: float | None = None
    quality_breakdown: dict[str, float | None] = field(default_factory=dict)
    # What the judge measured, so the card can show the evidence rather than
    # only the number derived from it.
    evidence: dict[str, Any] = field(default_factory=dict)
    started_at: int | None = None
    completed_at: int | None = None


@dataclass
class BountyResult:
    """Outcome of a bounty run, returned to callers and persisted to disk."""

    id: str
    spec_id: str
    project_path: str
    contestants: list[Contestant]
    winner_id: str | None = None
    judge_report: str = ""
    judge_rationale: dict[str, str] = field(default_factory=dict)
    scoring: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    created_at: int = field(default_factory=lambda: int(time.time() * 1000))
    completed_at: int | None = None
    status: str = "running"  # running | judging | completed | error

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "specId": self.spec_id,
            "projectPath": self.project_path,
            "contestants": [asdict(c) for c in self.contestants],
            "winnerId": self.winner_id,
            "judgeReport": self.judge_report,
            "judgeRationale": self.judge_rationale,
            "scoring": self.scoring,
            "warnings": self.warnings,
            "createdAt": self.created_at,
            "completedAt": self.completed_at,
            "status": self.status,
        }


ContestantRunner = Callable[[Contestant, str, Path], Awaitable[None]]
Judge = Callable[..., Awaitable[tuple[str, dict[str, str]]]]
