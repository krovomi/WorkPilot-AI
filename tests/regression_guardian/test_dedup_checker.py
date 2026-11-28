"""Whether a project's tests already cover an incident, read from real files."""

from __future__ import annotations

from pathlib import Path

import pytest
from regression_guardian import dedup_checker
from regression_guardian.dedup_checker import DedupChecker
from regression_guardian.incident_parser import Incident, IncidentSource, StackFrame


def _incident(function: str = "apply_discount_code", exc: str = "ValueError"):
    return Incident(
        id="i-1",
        source=IncidentSource.GENERIC,
        title="discount failed",
        exception_type=exc,
        stack_frames=[StackFrame(file="shop/pricing.py", function=function, line=3)],
    )


def _test(root: Path, relative: str, text: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_the_closest_test_above_the_threshold_is_the_duplicate(tmp_path) -> None:
    _test(tmp_path, "tests/test_cart.py", "def test_cart(): ...\n")
    close = _test(
        tmp_path,
        "tests/test_pricing.py",
        "def test_apply_discount_code():\n    with raises(ValueError): pricing\n",
    )
    _test(tmp_path, "README.md", "apply_discount_code ValueError pricing\n")

    result = DedupChecker(test_dirs=[tmp_path]).check(_incident())

    assert result.is_duplicate is True
    assert result.similar_test_path == str(close)
    assert result.similarity_score == 1.0
    assert "consider enriching it" in result.recommendation


def test_a_partial_name_match_counts_less(tmp_path) -> None:
    near = _test(tmp_path, "src/discount.test.ts", "it('gives a discount', ...)\n")

    result = DedupChecker(test_dirs=[tmp_path]).check(_incident(exc=""))

    # One part of three ("discount") is not enough.
    assert result.is_duplicate is False
    assert result.similarity_score == 0.0

    near.write_text("apply the discount code\n", encoding="utf-8")
    result = DedupChecker(test_dirs=[tmp_path]).check(_incident(exc=""))
    assert result.similarity_score == pytest.approx(0.3)
    assert result.similar_test_path == str(near)
    assert result.is_duplicate is False


def test_an_incident_with_nothing_to_compare_is_not_a_duplicate(tmp_path) -> None:
    bare = Incident(id="i", source=IncidentSource.GENERIC, title="t")

    result = DedupChecker(test_dirs=[tmp_path]).check(bare)

    assert result.is_duplicate is False
    assert result.recommendation == "No target to deduplicate against"


def test_missing_folders_and_unreadable_files_are_passed_over(tmp_path) -> None:
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_gone.py").symlink_to(tmp_path / "nowhere.py")

    result = DedupChecker(test_dirs=[tmp_path / "absent", tmp_path]).check(_incident())

    assert result.is_duplicate is False
    assert result.recommendation == "No sufficiently similar test found."


def test_the_walk_is_bounded(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(dedup_checker, "_MAX_TEST_FILES", 2)
    for name in ("test_a.py", "test_b.py", "test_c.py"):
        _test(tmp_path, f"tests/{name}", "x\n")

    assert [p.name for p in dedup_checker._test_files(tmp_path)] == [
        "test_a.py",
        "test_b.py",
    ]
