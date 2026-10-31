"""Blind excepts, biome-ignore comments and large files can only go down, file by file.

The ceilings are tests/baselines/*.json, written by scripts/quality_baselines.py.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location(
    "quality_baselines", ROOT / "scripts" / "quality_baselines.py"
)
quality_baselines = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(quality_baselines)

UPDATE = "python scripts/quality_baselines.py update"


@pytest.mark.parametrize(
    ("baseline", "counter", "what"),
    quality_baselines.CHECKS,
    ids=["blind-except", "biome-ignore", "file-size"],
)
def test_no_file_goes_above_its_ceiling_and_every_fix_lowers_it(
    baseline, counter, what
):
    above, below = quality_baselines.compare(
        counter(), quality_baselines._load(baseline), what
    )
    assert above == [], "catch the error you expect, or say why not: " + "; ".join(
        above
    )
    assert below == [], f"a count went down, keep it there: {UPDATE}"


@pytest.mark.parametrize(
    ("source", "blind", "silent"),
    [
        ("try:\n    x()\nexcept Exception:\n    pass\n", 1, 1),
        ("try:\n    x()\nexcept:\n    ...\n", 1, 1),
        ("try:\n    x()\nexcept (OSError, BaseException) as e:\n    log(e)\n", 1, 0),
        (
            "for i in y:\n    try:\n        x()\n    except Exception:\n        continue\n",
            1,
            1,
        ),
        ('try:\n    x()\nexcept Exception:\n    """Optional."""\n', 1, 1),
        ("try:\n    x()\nexcept Exception:\n    raise\n", 1, 0),
        ("try:\n    x()\nexcept (OSError, ValueError):\n    pass\n", 0, 0),
    ],
)
def test_blind_and_silent_handlers_are_counted(source, blind, silent):
    assert quality_baselines.count_excepts(source) == {
        "blind": blind,
        "silent": silent,
    }


def test_a_new_blind_except_is_refused():
    ceiling = {"a.py": {"blind": 2, "silent": 1}}
    above, below = quality_baselines.compare(
        {"a.py": {"blind": 3, "silent": 1}, "new.py": {"blind": 1, "silent": 0}},
        ceiling,
        "except",
    )
    assert above == ["a.py: blind except 3 > 2", "new.py: blind except 1 > 0"]
    assert below == []


def test_update_lowers_but_never_raises_nor_adds():
    ceiling = {"a.py": {"blind": 2, "silent": 1}, "gone.py": {"blind": 1, "silent": 0}}
    current = {"a.py": {"blind": 3, "silent": 0}, "new.py": {"blind": 1, "silent": 1}}
    assert quality_baselines.lowered(current, ceiling) == {
        "a.py": {"blind": 2, "silent": 0}
    }
    assert quality_baselines.lowered(
        {"x.ts": 5, "y.ts": 1}, {"x.ts": 3, "z.ts": 2}
    ) == {"x.ts": 3}


def test_a_fixed_file_leaves_the_baseline():
    assert quality_baselines.lowered({}, {"a.py": {"blind": 1, "silent": 1}}) == {}
    assert quality_baselines.lowered({"a.ts": 0}, {"a.ts": 4}) == {}


def test_a_large_file_cannot_grow_and_a_new_one_is_refused(tmp_path, monkeypatch):
    big = "x\n" * (quality_baselines.LARGE_FILE + 1)
    (tmp_path / "apps" / "backend").mkdir(parents=True)
    (tmp_path / "apps" / "backend" / "big.py").write_text(big, encoding="utf-8")
    (tmp_path / "apps" / "backend" / "small.py").write_text("x\n", encoding="utf-8")
    monkeypatch.setattr(quality_baselines, "ROOT", tmp_path)
    monkeypatch.setattr(
        quality_baselines,
        "_tracked",
        lambda *_: ["apps/backend/big.py", "apps/backend/small.py"],
    )
    current = quality_baselines.size_counts()
    assert current == {"apps/backend/big.py": quality_baselines.LARGE_FILE + 1}
    above, _ = quality_baselines.compare(current, {}, "lines")
    assert above == [
        f"apps/backend/big.py: lines {quality_baselines.LARGE_FILE + 1} > 0"
    ]
    above, below = quality_baselines.compare(
        current, {"apps/backend/big.py": quality_baselines.LARGE_FILE + 5}, "lines"
    )
    assert above == [] and below
