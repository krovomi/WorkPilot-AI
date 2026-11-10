"""The release calendar: planned slots and the ones that collide.

Two slots collide when they share an environment and their time windows
overlap: two services that want to ship to the same place at the same time.
A run started in an environment also reports the planned slots of other
services open at that moment.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from .train_file import Slot


def end_of(slot: Slot) -> datetime:
    return slot.at + timedelta(minutes=slot.minutes)


def conflicts(slots: list[Slot]) -> list[tuple[int, int]]:
    """Pairs of indexes (in ``slots``) whose windows overlap in one environment."""
    found: list[tuple[int, int]] = []
    ordered = sorted(range(len(slots)), key=lambda i: slots[i].at)
    for position, first in enumerate(ordered):
        for second in ordered[position + 1 :]:
            if slots[second].at >= end_of(slots[first]):
                break
            if slots[first].environment == slots[second].environment:
                found.append((min(first, second), max(first, second)))
    return sorted(found)


def open_at(slots: list[Slot], environment: str, moment: datetime) -> list[Slot]:
    return [
        s for s in slots if s.environment == environment and s.at <= moment < end_of(s)
    ]


def calendar(slots: list[Slot], now: datetime) -> dict[str, object]:
    """The slots from the start of today on, with their conflicts, for the page."""
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    kept = [s for s in slots if end_of(s) >= day]
    clashes = conflicts(kept)
    clashing = {i for pair in clashes for i in pair}
    return {
        "slots": [
            {
                "service": s.service,
                "environment": s.environment,
                "at": s.at.isoformat(),
                "end": end_of(s).isoformat(),
                "minutes": s.minutes,
                "conflict": index in clashing,
            }
            for index, s in enumerate(kept)
        ],
        "conflicts": [list(pair) for pair in clashes],
    }


__all__ = ["calendar", "conflicts", "end_of", "open_at"]
