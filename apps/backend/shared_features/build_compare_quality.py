"""Two more figures of "How you compare", read from records the QA and the
follow-through of the PR already keep in each spec's folder:

- the **mutation score** (``mutation_gate.json``, ``mutation_gate``): the
  share, in percent, of the mutants of the spec's changed lines its tests
  caught; a gate that ran no mutant has no score;
- the **first-run CI** result (``pr_followup.json``, ``pr_followup``):
  whether the CI passed on the PR as it was opened, before any fix round.

Both are higher-is-better, the opposite of every other figure, and the same
on every stack and every provider: a mutant is a mutant, a check a check.
A project's mutation score for a window is the median over its specs; its
first-run CI figure is the share of its specs with a recorded result that
passed, in percent.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

MUTATION_FILE = "mutation_gate.json"
FOLLOWUP_FILE = "pr_followup.json"
#: The figures for which more is better.
HIGHER_IS_BETTER = frozenset({"mutation_score", "ci_first_pass"})


def mutation_score(record: object) -> int | None:
    """A mutation gate's score, when it ran mutants: a whole percent."""
    if not isinstance(record, dict):
        return None
    score = record.get("score")
    if isinstance(score, bool) or not isinstance(score, int):
        return None
    return score if 0 <= score <= 100 else None


def first_ci(record: object) -> bool | None:
    """Whether the CI passed on the PR as it was opened; None unrecorded."""
    if not isinstance(record, dict):
        return None
    verdict = record.get("first_ci")
    return (
        {"passed": True, "failed": False}.get(verdict)
        if isinstance(verdict, str)
        else None
    )


def by_spec(records: Iterable[tuple[str, Any]], read) -> dict[str, Any]:
    """Each spec's value read by `read`; the build workspace's copy, read
    last, wins over the root's when it has one."""
    found: dict[str, Any] = {}
    for name, record in records:
        value = read(record)
        if value is not None:
            found[name] = value
    return found


def pass_rate(results: Iterable[bool | None]) -> float | None:
    """The share of recorded results that passed, in percent."""
    present = [r for r in results if r is not None]
    return 100 * sum(present) / len(present) if present else None
