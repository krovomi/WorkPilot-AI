"""Split the suite into shards that CI runs side by side.

The Windows job ran the whole suite in 23 minutes and every pull request
waited for it. ``WORKPILOT_TEST_SHARD=2/4`` keeps the second quarter of the
collected tests and deselects the rest; without the variable nothing changes.

The unit is the test file, not the test: a file's module fixtures and its
tests' order stay what they are on a full run. Files are dealt, heaviest
first, to the lightest shard so far, so the split is deterministic (every
shard computes the same one) and the shards finish together. A file weighs
what it took on the Windows runner (``ci_durations.json``, the slowest OS);
a file missing there weighs its number of tests times the median per-test
time. Collection is not split: each shard imports every file, as a full run
does, so what a file does to ``sys.modules`` at import time is the same
everywhere.

Refresh the weights from the logs of every Windows shard of one run (or of
one unsharded run): ``pytest -v`` prints one line per test, and the runner
timestamps each line::

    gh run view --job <id> --log > win1.log   # one per Windows shard
    python tests/ci_shard.py durations win1.log win2.log win3.log win4.log
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path

ENV = "WORKPILOT_TEST_SHARD"
DURATIONS = Path(__file__).with_name("ci_durations.json")
#: Files under this many seconds are left out of the JSON: they weigh by count.
_LISTED_FROM = 1.0


def parse(spec: str | None) -> tuple[int, int] | None:
    """``"2/4"`` -> ``(2, 4)``; ``None`` or ``""`` -> ``None`` (no sharding)."""
    if not spec:
        return None
    index, _, total = spec.partition("/")
    shard, count = int(index), int(total)
    if count < 1 or not 1 <= shard <= count:
        raise ValueError(f"{ENV}={spec!r}: expected i/n with 1 <= i <= n")
    return shard, count


def load_durations(path: Path = DURATIONS) -> dict[str, float]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: float(v) for k, v in data.get("files", {}).items()}


def assign(
    files: Iterable[str],
    count: int,
    durations: dict[str, float] | None = None,
    per_test: float = 0.01,
) -> dict[str, int]:
    """Map each file to a shard (1..count), balancing the expected time."""
    sizes = Counter(files)
    durations = durations or {}
    weights = {
        name: durations.get(name, size * per_test) for name, size in sizes.items()
    }
    load = [0.0] * count
    shard_of: dict[str, int] = {}
    # Heaviest first, ties by name: the order, hence the split, is stable.
    for name, weight in sorted(weights.items(), key=lambda kv: (-kv[1], kv[0])):
        target = min(range(count), key=lambda s: (load[s], s))
        load[target] += weight
        shard_of[name] = target + 1
    return shard_of


def split(
    items: list, spec: str | None = None, durations: dict[str, float] | None = None
) -> tuple[list, list]:
    """Return ``(kept, deselected)`` for the shard named by ``spec`` or the env."""
    parsed = parse(spec if spec is not None else os.environ.get(ENV))
    if parsed is None:
        return items, []
    shard, count = parsed
    files = [item.nodeid.split("::", 1)[0] for item in items]
    if durations is None:
        durations = load_durations()
    shard_of = assign(files, count, durations)
    kept, dropped = [], []
    for item, name in zip(items, files):
        (kept if shard_of[name] == shard else dropped).append(item)
    return kept, dropped


_LINE = re.compile(
    r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6})\d*Z (\S+?)::\S.* "
    r"(PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)"
)


def durations_from_log(lines: Iterable[str]) -> dict[str, float]:
    """Seconds per test file, from a GitHub Actions log of ``pytest -v``."""
    spent: Counter[str] = Counter()
    previous = None
    for line in lines:
        match = _LINE.search(line)
        if not match:
            continue
        stamp = datetime.fromisoformat(match.group(1))
        if previous is not None:
            spent[match.group(2)] += (stamp - previous).total_seconds()
        previous = stamp
    return dict(spent)


def _write_durations(logs: list[Path]) -> None:
    # One log at a time: the gap between two logs is not a test's time.
    spent: dict[str, float] = {}
    for log in logs:
        text = log.read_text(encoding="utf-8", errors="replace")
        spent.update(durations_from_log(text.splitlines()))
    listed = {k: round(v, 1) for k, v in sorted(spent.items()) if v >= _LISTED_FROM}
    payload = {
        "source": "test-python on windows-latest, every shard of one run (tests/ci_shard.py)",
        "files": listed,
    }
    DURATIONS.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")
    print(f"{len(listed)} files, {round(sum(spent.values()))} s in all")


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] != "durations":
        sys.exit("usage: python tests/ci_shard.py durations <github-actions-log>...")
    _write_durations([Path(arg) for arg in sys.argv[2:]])
