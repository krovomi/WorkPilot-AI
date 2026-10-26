"""Given what the forge says, what the follow-through does next. Pure.

The order of the rules is the design: an unreadable forge is never green, a
merged PR ends everything, nothing is judged while a check still runs, and a
failure that is red on the base branch too is reported as the base's, not
"fixed" on the PR. Only then does the round budget come in.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from .model import Check, CheckState, PRSnapshot, ReviewThread
from .state import FollowupState

DEFAULT_MAX_ROUNDS = 3
# A push takes a moment to show up as checks. Polls with no check on the head
# before the loop concludes the repository has no CI for this PR.
DEFAULT_NO_CHECKS_GRACE = 5


class DecisionKind(StrEnum):
    UNKNOWN = "unknown"
    """The forge could not be read. Never treated as green."""
    MERGED = "merged"
    CLOSED = "closed"
    PENDING = "pending"
    """A check is still running, or the head was just pushed."""
    NO_CHECKS = "no_checks"
    """No check reported on the head after the grace polls. Not green either:
    nothing said the code works."""
    GREEN = "green"
    """Every check passed and no review thread waits. The merge is a person's."""
    BASE_RED = "base_red"
    """Every failing check fails on the base branch too: not this PR's to fix."""
    STUCK = "stuck"
    """A fix round on this very head produced no commit."""
    EXHAUSTED = "exhausted"
    FIX = "fix"


TERMINAL = frozenset(
    {
        DecisionKind.MERGED,
        DecisionKind.CLOSED,
        DecisionKind.NO_CHECKS,
        DecisionKind.GREEN,
        DecisionKind.BASE_RED,
        DecisionKind.STUCK,
        DecisionKind.EXHAUSTED,
    }
)


@dataclass(frozen=True)
class FollowupConfig:
    max_rounds: int = DEFAULT_MAX_ROUNDS
    fix_review_threads: bool = True
    no_checks_grace: int = DEFAULT_NO_CHECKS_GRACE


@dataclass(frozen=True)
class Decision:
    kind: DecisionKind
    reason: str
    failing: tuple[Check, ...] = field(default_factory=tuple)
    """The failures this PR owns: the ones the fixer gets."""
    base_failing: tuple[Check, ...] = field(default_factory=tuple)
    """Failures that are red on the base branch too, reported, never fixed."""
    threads: tuple[ReviewThread, ...] = field(default_factory=tuple)

    @property
    def terminal(self) -> bool:
        return self.kind in TERMINAL


def new_threads(snapshot: PRSnapshot, state: FollowupState) -> tuple[ReviewThread, ...]:
    """Threads the fixer has not seen in their current form."""
    return tuple(
        t
        for t in snapshot.threads
        if t.comments and state.handled_threads.get(t.id) != t.last_comment_id
    )


def decide(
    snapshot: PRSnapshot,
    state: FollowupState,
    config: FollowupConfig | None = None,
    base_failing_names: frozenset[str] | None = None,
) -> Decision:
    """The next step for this PR.

    `base_failing_names` is the set of check names failing on the base
    branch's head; None when it could not be read, in which case every
    failure is treated as the PR's own (fixing a base failure costs a round,
    calling a real failure "the base's" would hide it).
    """
    cfg = config or FollowupConfig()

    if snapshot.error:
        return Decision(
            DecisionKind.UNKNOWN, f"the forge could not be read: {snapshot.error}"
        )
    state_name = snapshot.state.upper()
    if state_name == "MERGED":
        return Decision(DecisionKind.MERGED, "the pull request is merged")
    if state_name == "CLOSED":
        return Decision(
            DecisionKind.CLOSED, "the pull request was closed without merge"
        )

    if not snapshot.checks:
        if state.no_checks_polls + 1 >= cfg.no_checks_grace:
            return Decision(
                DecisionKind.NO_CHECKS,
                "no CI check reported on the head commit: nothing proves it works",
            )
        return Decision(
            DecisionKind.PENDING, "waiting for the first checks on the head"
        )

    pending = snapshot.checks_in(CheckState.PENDING)
    if pending:
        names = ", ".join(c.name for c in pending[:5])
        return Decision(
            DecisionKind.PENDING, f"{len(pending)} check(s) still running: {names}"
        )

    failing = snapshot.checks_in(CheckState.FAILED)
    base_names = base_failing_names or frozenset()
    ours = tuple(c for c in failing if c.name not in base_names)
    theirs = tuple(c for c in failing if c.name in base_names)
    threads = new_threads(snapshot, state) if cfg.fix_review_threads else ()

    if not failing and not threads:
        return Decision(
            DecisionKind.GREEN, "every check passed and no review thread waits"
        )
    if not ours and not threads:
        names = ", ".join(c.name for c in theirs)
        return Decision(
            DecisionKind.BASE_RED,
            f"failing on the base branch too, not this PR's: {names}",
            base_failing=theirs,
        )
    if snapshot.head_sha and snapshot.head_sha in state.no_progress_heads:
        return Decision(
            DecisionKind.STUCK,
            "a fix round on this head produced no commit; a person has to look",
            failing=ours,
            base_failing=theirs,
            threads=threads,
        )
    if state.rounds >= cfg.max_rounds:
        return Decision(
            DecisionKind.EXHAUSTED,
            f"{state.rounds} fix round(s) spent, the cap is {cfg.max_rounds}",
            failing=ours,
            base_failing=theirs,
            threads=threads,
        )
    parts = []
    if ours:
        parts.append(f"{len(ours)} failing check(s)")
    if threads:
        parts.append(f"{len(threads)} review thread(s)")
    return Decision(
        DecisionKind.FIX,
        "to fix: " + ", ".join(parts),
        failing=ours,
        base_failing=theirs,
        threads=threads,
    )
