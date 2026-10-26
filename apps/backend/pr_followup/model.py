"""What a forge says about a pull request, in a shape the policy can read.

Everything here is plain data: the forge adapter fills it, the policy reads
it, the tests build it by hand. Nothing in this module talks to a network.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class CheckState(StrEnum):
    PASSED = "passed"
    FAILED = "failed"
    PENDING = "pending"


@dataclass(frozen=True)
class Check:
    """One CI check on the PR's head commit."""

    name: str
    state: CheckState
    link: str = ""
    """The check's page: the job log is read from there (`run_id`, `job_id`)."""
    run_id: str = ""
    job_id: str = ""


@dataclass(frozen=True)
class ReviewComment:
    id: str
    author: str
    body: str
    url: str = ""


@dataclass(frozen=True)
class ReviewThread:
    """An unresolved, non-outdated review thread. Resolved ones never get here."""

    id: str
    path: str
    line: int | None
    comments: tuple[ReviewComment, ...]

    @property
    def last_comment_id(self) -> str:
        return self.comments[-1].id if self.comments else ""


@dataclass(frozen=True)
class PRSnapshot:
    """The PR as the forge reported it at one instant.

    `error` is set when the forge could not be read. A snapshot with an error
    carries no verdict: an empty check list next to an error means "unknown",
    never "nothing failed".
    """

    url: str
    number: int = 0
    state: str = "OPEN"
    """OPEN, MERGED or CLOSED."""
    head_sha: str = ""
    head_branch: str = ""
    base_branch: str = ""
    checks: tuple[Check, ...] = field(default_factory=tuple)
    threads: tuple[ReviewThread, ...] = field(default_factory=tuple)
    error: str = ""

    def checks_in(self, state: CheckState) -> tuple[Check, ...]:
        return tuple(c for c in self.checks if c.state == state)
