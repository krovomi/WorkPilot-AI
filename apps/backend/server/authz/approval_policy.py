"""How many people approve a card, and which content their approval covers.

A card is ``low``, ``medium`` or ``high`` critical. The deployment sets how
many approvals each level needs (``WORKPILOT_APPROVAL_QUORUM``, one unless
set) and the roles one of the approvers must hold
(``WORKPILOT_APPROVAL_ROLES``, none unless set).

Its criticality is the one an approver chose for it (``spec_criticality``).
Otherwise the spec's own assessment (``complexity_assessment.json``, written
by the spec agent) may raise it to ``high``, never lower it: a file an agent
wrote, from text that may come from outside, does not decide that a card needs
fewer approvals. Without either, a card is ``medium``.

An approval covers the card's ``spec.md`` and plan as they were: the SHA-256 of
both is kept with it, and an edit afterwards voids it.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from server.config import CRITICALITIES, get_settings

DEFAULT_CRITICALITY = "medium"
#: The spec agent's complexity tiers, as criticality.
_ASSESSED = {"simple": "low", "standard": "medium", "complex": "high"}
_ASSESSMENT = "complexity_assessment.json"
_ASSESSMENT_LIMIT = 200_000
#: What an approval covers, in this order.
COVERED_FILES = ("spec.md", "implementation_plan.json")


@dataclass(frozen=True)
class Requirement:
    """What a card of one criticality needs before its build may start."""

    needed: int
    roles: tuple[str, ...]


def rank(criticality: str) -> int:
    return CRITICALITIES.index(criticality)


def requirement_for(criticality: str) -> Requirement:
    settings = get_settings()
    return Requirement(
        needed=dict(settings.approval_quorum)[criticality],
        roles=dict(settings.approval_roles)[criticality],
    )


def _regular_file(path: Path) -> bool:
    return path.is_file() and not path.is_symlink()


def assessed_criticality(card_dir: Path | None) -> str | None:
    """The criticality the spec's assessment gives, if it gives one."""
    if card_dir is None:
        return None
    path = card_dir / _ASSESSMENT
    try:
        if not _regular_file(path) or path.stat().st_size > _ASSESSMENT_LIMIT:
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    tier = data.get("complexity") if isinstance(data, dict) else None
    return _ASSESSED.get(tier) if isinstance(tier, str) else None


def effective_criticality(chosen: str | None, card_dir: Path | None) -> tuple[str, str]:
    """``(criticality, source)``: ``set`` by a person, ``assessed``, or ``default``."""
    if chosen in CRITICALITIES:
        return chosen, "set"
    assessed = assessed_criticality(card_dir)
    if assessed is not None and rank(assessed) > rank(DEFAULT_CRITICALITY):
        return assessed, "assessed"
    return DEFAULT_CRITICALITY, "default"


def content_hash(card_dir: Path) -> str:
    """SHA-256 of the files an approval covers (an absent one counts as empty)."""
    digest = hashlib.sha256()
    for name in COVERED_FILES:
        path = card_dir / name
        try:
            data = path.read_bytes() if _regular_file(path) else b""
        except OSError:
            data = b""
        digest.update(name.encode("utf-8") + b"\0")
        digest.update(str(len(data)).encode("ascii") + b"\0")
        digest.update(data)
    return digest.hexdigest()
