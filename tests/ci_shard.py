"""Split the suite into shards that CI runs side by side.

The Windows job ran the whole suite in 23 minutes and every pull request
waited for it. ``WORKPILOT_TEST_SHARD=2/4`` keeps the second quarter of the
collected tests and deselects the rest; without the variable nothing changes.

The unit is the test file, not the test: a file's module fixtures and its
tests' order stay what they are on a full run. Files are dealt, largest
first, to the shard that holds the fewest tests so far, so the split is
deterministic (every shard computes the same one) and the shards are even.
Collection is not split: each shard imports every file, as a full run does,
so what a file does to ``sys.modules`` at import time is the same everywhere.
"""

from __future__ import annotations

import os
from collections import Counter
from collections.abc import Iterable

ENV = "WORKPILOT_TEST_SHARD"


def parse(spec: str | None) -> tuple[int, int] | None:
    """``"2/4"`` -> ``(2, 4)``; ``None`` or ``""`` -> ``None`` (no sharding)."""
    if not spec:
        return None
    index, _, total = spec.partition("/")
    shard, count = int(index), int(total)
    if count < 1 or not 1 <= shard <= count:
        raise ValueError(f"{ENV}={spec!r}: expected i/n with 1 <= i <= n")
    return shard, count


def assign(files: Iterable[str], count: int) -> dict[str, int]:
    """Map each file to a shard (1..count), balancing the number of tests."""
    sizes = Counter(files)
    load = [0] * count
    shard_of: dict[str, int] = {}
    # Largest first, ties by name: the order, hence the split, is stable.
    for name, size in sorted(sizes.items(), key=lambda kv: (-kv[1], kv[0])):
        target = min(range(count), key=lambda s: (load[s], s))
        load[target] += size
        shard_of[name] = target + 1
    return shard_of


def split(items: list, spec: str | None = None) -> tuple[list, list]:
    """Return ``(kept, deselected)`` for the shard named by ``spec`` or the env."""
    parsed = parse(spec if spec is not None else os.environ.get(ENV))
    if parsed is None:
        return items, []
    shard, count = parsed
    files = [item.nodeid.split("::", 1)[0] for item in items]
    shard_of = assign(files, count)
    kept, dropped = [], []
    for item, name in zip(items, files):
        (kept if shard_of[name] == shard else dropped).append(item)
    return kept, dropped
