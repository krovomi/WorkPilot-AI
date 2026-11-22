"""One step of "Execute in optimal order" on a server project: which cards of
the current wave to start now, and whether the wave has settled. Pure; the
route (``shared_features.execution_waves``) starts the cards through the
server's run manager, as the person, and saves the run.

The same rules as the desktop (``renderer/lib/wave-execution.ts``): never
more than the run's parallelism running (cards with a queued or running run
count), never a card whose blocker has not finished, never one twice. The
next wave starts once every card of the wave is merged (``done``) or, as an
option, in review. A card started by the run that is back in the backlog
with no run going (put back, or its start refused) no longer holds the wave.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

SETTLED = {
    "merged": frozenset({"done"}),
    "review": frozenset(
        {"human_review", "pr_created", "done", "error", "build_failed"}
    ),
}
NOT_STARTED = frozenset({"backlog", "queue"})
RUNNING = frozenset({"in_progress", "ai_review"})
#: A blocker in one of these columns no longer holds its card.
SATISFIED = frozenset({"done", "pr_created"})


@dataclass(frozen=True)
class CardState:
    column: str
    archived: bool = False
    abandoned: bool = False
    blocked_by: tuple[str, ...] = ()
    #: A run of the card is queued or running on the server.
    running: bool = False


@dataclass
class Step:
    promote: list[str] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)
    wave_settled: bool = False
    finished: bool = False


def _settled(card_id: str, card: CardState, run: dict[str, Any]) -> bool:
    if card.archived or card.abandoned:
        return True
    if card.column in SETTLED[run["advanceWhen"]]:
        return True
    return card.column in NOT_STARTED and card_id in run["started"] and not card.running


def _blocked(card_id: str, card: CardState, cards: dict[str, CardState]) -> bool:
    for blocker_id in card.blocked_by:
        blocker = cards.get(blocker_id)
        if blocker_id == card_id or blocker is None:
            continue
        if blocker.column in SATISFIED or blocker.archived or blocker.abandoned:
            continue
        return True
    return False


def step(run: dict[str, Any], cards: dict[str, CardState]) -> Step:
    """What to do now for ``run`` over the project's ``cards``."""
    if run["current"] >= len(run["waves"]):
        return Step(wave_settled=True, finished=True)
    wave = run["waves"][run["current"]]
    members = [(card_id, cards[card_id]) for card_id in wave if card_id in cards]
    if all(_settled(card_id, card, run) for card_id, card in members):
        return Step(wave_settled=True, finished=run["current"] >= len(run["waves"]) - 1)
    busy = sum(
        1
        for card in cards.values()
        if not card.archived and (card.running or card.column in RUNNING)
    )
    room = max(0, run["maxParallel"] - busy)
    result = Step()
    for card_id, card in members:
        if card.column not in NOT_STARTED or card_id in run["started"]:
            continue
        if _blocked(card_id, card, cards):
            result.blocked.append(card_id)
        elif room > 0:
            result.promote.append(card_id)
            room -= 1
    return result
