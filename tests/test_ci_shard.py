"""The CI shards cover every test exactly once (tests/ci_shard.py)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from tests.ci_shard import assign, durations_from_log, parse, split


def _items(spec: dict[str, int]) -> list[SimpleNamespace]:
    return [
        SimpleNamespace(nodeid=f"{name}::test_{i}")
        for name, size in spec.items()
        for i in range(size)
    ]


def test_no_spec_keeps_everything():
    items = _items({"a.py": 3})
    assert split(items, "") == (items, [])


@pytest.mark.parametrize("bad", ["0/2", "3/2", "1/0", "x/2"])
def test_a_bad_spec_is_refused(bad):
    with pytest.raises(ValueError):
        parse(bad)


@pytest.mark.parametrize("count", [1, 2, 3, 4])
def test_shards_partition_the_suite(count):
    items = _items({f"tests/t{n}.py": (n * 7) % 13 + 1 for n in range(40)})
    seen: list = []
    for shard in range(1, count + 1):
        kept, dropped = split(items, f"{shard}/{count}")
        assert len(kept) + len(dropped) == len(items)
        seen.extend(kept)
    assert sorted(i.nodeid for i in seen) == sorted(i.nodeid for i in items)


def test_a_file_stays_in_one_shard():
    items = _items({"a.py": 5, "b.py": 5, "c.py": 1})
    for shard in (1, 2):
        kept, _ = split(items, f"{shard}/2")
        files = {i.nodeid.split("::")[0] for i in kept}
        for name in files:
            assert sum(1 for i in kept if i.nodeid.startswith(name)) == sum(
                1 for i in items if i.nodeid.startswith(name)
            )


def test_shards_are_balanced():
    files = [f"f{n}.py" for n in range(100) for _ in range(n % 10 + 1)]
    shard_of = assign(files, 4)
    load = [0] * 4
    for name in files:
        load[shard_of[name] - 1] += 1
    assert max(load) - min(load) <= 10


def test_a_slow_file_weighs_its_time_not_its_count():
    files = ["slow.py"] * 3 + [f"f{n}.py" for n in range(30)]
    shard_of = assign(files, 2, {"slow.py": 100.0})
    assert {shard_of[f"f{n}.py"] for n in range(30)} == {3 - shard_of["slow.py"]}


def test_durations_come_from_the_runner_timestamps():
    log = [
        "job\tstep\t2026-11-02T13:00:00.0000000Z tests/a.py::test_x PASSED [ 1%]",
        "job\tstep\t2026-11-02T13:00:02.5000000Z tests/a.py::test_y PASSED [ 2%]",
        "job\tstep\t2026-11-02T13:00:03.0000000Z noise",
        "job\tstep\t2026-11-02T13:00:12.5000000Z tests/b.py::T::test_z FAILED [ 3%]",
    ]
    assert durations_from_log(log) == {"tests/a.py": 2.5, "tests/b.py": 10.0}


def test_the_committed_weights_name_real_files():
    from tests.ci_shard import DURATIONS, load_durations

    weights = load_durations()
    assert weights, DURATIONS
    root = DURATIONS.parent.parent
    missing = [name for name in weights if not (root / name).is_file()]
    # A renamed or deleted file only falls back to its count; many mean stale weights.
    assert len(missing) <= len(weights) // 10, missing
