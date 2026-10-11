"""
The ``merge`` event: a person accepted a build, published once.

A merge used to be written into four stores, one call each, in the CLI that
performs it: the usage counters (``core.usage_tracker``, which the dashboard's
snapshot reads), the learning loop's ledger, the shared brain's build note and
the design system the build settled on (``uiux.knowledge``). Each new reader
meant one more call in ``cli/workspace_commands.py``, and a second producer of
merges would have had to repeat all four.

Now the producer publishes a `MergeEvent` and each feature subscribes with its
own ``on_merge``. Subscribers are named by import path and resolved when a
merge happens, so publishing imports nothing a merge does not need. Each one is
isolated: a subscriber that fails is logged and the others still run — a merge
that worked is never reported as failed because the bookkeeping afterwards did
not.
"""

from __future__ import annotations

import importlib
import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = ["MergeEvent", "SUBSCRIBERS", "publish", "subscribe"]


@dataclass(frozen=True)
class MergeEvent:
    """A build of *spec_name* was merged into *project_dir*."""

    project_dir: Path
    spec_name: str
    automatic: bool = False


Subscriber = Callable[[MergeEvent], None]

SUBSCRIBERS: list[str | Subscriber] = [
    "core.usage_tracker:on_merge",
    "learning_loop.observe:on_merge",
    "brain.learn:on_merge",
    "uiux.knowledge:on_merge",
]
"""Who hears about a merge, in the order they are told. ``module:function``."""


def subscribe(subscriber: str | Subscriber) -> None:
    """Add a subscriber (idempotent)."""
    if subscriber not in SUBSCRIBERS:
        SUBSCRIBERS.append(subscriber)


def _resolve(subscriber: str | Subscriber) -> Subscriber:
    if callable(subscriber):
        return subscriber
    module, _, name = subscriber.partition(":")
    return getattr(importlib.import_module(module), name)


def _name(subscriber: str | Subscriber) -> str:
    if isinstance(subscriber, str):
        return subscriber
    return getattr(subscriber, "__qualname__", repr(subscriber))


def publish(event: MergeEvent) -> list[str]:
    """Tell every subscriber; returns the names of those that failed."""
    failed = []
    for subscriber in list(SUBSCRIBERS):
        try:
            _resolve(subscriber)(event)
        except Exception as exc:  # noqa: BLE001 - never fail a merge over bookkeeping
            failed.append(_name(subscriber))
            logger.warning("merge event: %s failed: %s", _name(subscriber), exc)
    return failed
