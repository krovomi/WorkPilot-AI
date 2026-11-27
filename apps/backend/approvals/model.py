"""What the approval tiers read and what they decide.

A pull request is described by facts measured without a model (``PRFacts``),
and judged into one of four tiers (``Tier``). The tier says who has to agree
before the merge; the action says what happens now, given the checks and the
policy's mode.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any


class Tier(IntEnum):
    """Who must agree before the merge. A higher tier is stricter."""

    #: Merged alone once the CI is green: dependency bumps, documentation.
    AUTO = 0
    #: Merged alone once the CI is green and a second engine agreed.
    REVIEW = 1
    #: A person approves: a feature, several layers, a schema or contract.
    HUMAN = 2
    #: A person approves, and nothing may lower it: sensitive data, CI,
    #: the policy files themselves.
    LOCKED = 3

    @property
    def label(self) -> str:
        return f"N{int(self)}"

    @classmethod
    def from_name(cls, name: str) -> Tier | None:
        """``auto`` / ``review`` / ``human`` / ``locked`` or ``N0``…``N3``."""
        text = name.strip().lower()
        for tier in cls:
            if text in (tier.name.lower(), tier.label.lower()):
                return tier
        return None


#: What WorkPilot does with the pull request now.
ACTION_MERGE = "merge"  # the tier allows it and every condition holds
ACTION_WAIT = "wait"  # the tier allows it, a check or the review is not done
ACTION_HUMAN = "human"  # a person approves first
ACTION_BLOCKED = "blocked"  # a check failed or the review disagreed

#: Policy modes. ``observe`` decides and reports, never merges.
MODE_OFF = "off"
MODE_OBSERVE = "observe"
MODE_ENFORCE = "enforce"
MODES = (MODE_OFF, MODE_OBSERVE, MODE_ENFORCE)

#: The CI and review states the facts take.
CI_STATES = ("green", "pending", "red", "unknown")
REVIEW_STATES = ("agree", "disagree", "inconclusive", "none")


@dataclass(frozen=True)
class ChangedFile:
    path: str
    added: int = 0
    deleted: int = 0
    #: Binary content: git gives no line count.
    binary: bool = False

    @property
    def lines(self) -> int:
        return self.added + self.deleted


@dataclass(frozen=True)
class PRFacts:
    """Everything the tiers read, measured without a model."""

    files: tuple[ChangedFile, ...]
    #: Conventional type of the title (``feat``, ``fix``…), ``deps`` for a
    #: dependency bump, ``docs`` for documentation, ``other`` when unknown.
    type: str = "other"
    breaking: bool = False
    #: Dependency bump only: ``major``, ``minor``, ``patch`` or ``unknown``.
    bump: str | None = None
    #: Clean Architecture layers touched, or the code areas when the project
    #: has no layers (``layer_source`` says which).
    layers: tuple[str, ...] = ()
    layer_source: str = "areas"
    base: str = ""
    labels: tuple[str, ...] = ()
    ci: str = "unknown"
    review: str = "none"
    #: Trust score of the agent session (agent_safety), when one is known.
    trust: int | None = None

    @property
    def files_changed(self) -> int:
        return len(self.files)

    @property
    def diff_lines(self) -> int:
        return sum(f.lines for f in self.files)

    @property
    def paths(self) -> tuple[str, ...]:
        return tuple(f.path for f in self.files)

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "breaking": self.breaking,
            "bump": self.bump,
            "filesChanged": self.files_changed,
            "diffLines": self.diff_lines,
            "layers": list(self.layers),
            "layerSource": self.layer_source,
            "base": self.base,
            "labels": list(self.labels),
            "ci": self.ci,
            "review": self.review,
            "trust": self.trust,
        }


@dataclass(frozen=True)
class Reason:
    """Why a tier was reached: a stable English code, a detail, the files."""

    code: str
    tier: Tier
    detail: str
    files: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "tier": self.tier.label,
            "detail": self.detail,
            "files": list(self.files[:20]),
        }


@dataclass(frozen=True)
class Decision:
    tier: Tier
    action: str
    mode: str
    reasons: tuple[Reason, ...]
    facts: PRFacts
    #: Errors of the ``approvals`` section; non-empty means the policy is
    #: invalid and the decision is LOCKED.
    errors: tuple[str, ...] = field(default_factory=tuple)

    @property
    def merges(self) -> bool:
        """True only when WorkPilot may merge now: enforce mode and ``merge``."""
        return self.mode == MODE_ENFORCE and self.action == ACTION_MERGE

    def to_dict(self) -> dict[str, Any]:
        return {
            "tier": self.tier.label,
            "tierName": self.tier.name.lower(),
            "action": self.action,
            "mode": self.mode,
            "merges": self.merges,
            "reasons": [r.to_dict() for r in self.reasons],
            "facts": self.facts.to_dict(),
            "errors": list(self.errors),
        }
