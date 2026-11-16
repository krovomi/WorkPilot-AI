"""Risk trajectories of the proactive mode (#370): history, classes, hot list, clusters."""

from __future__ import annotations

import asyncio
import sqlite3
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import pytest
from self_healing.incident_responder.proactive_mode import ProactiveMode
from self_healing.proactive import history_store
from self_healing.proactive.clusters import build_trend_report, degrading_clusters
from self_healing.proactive.history_store import RiskHistoryStore
from self_healing.proactive.trajectory import Point, Trajectory, classify

START = date(2026, 6, 1)


def weekly(*risks: float, complexity: float = 10.0, start: date = START) -> list[Point]:
    return [
        Point(start + timedelta(weeks=i), r, complexity=complexity)
        for i, r in enumerate(risks)
    ]


@pytest.mark.parametrize(
    ("risks", "expected"),
    [
        # A file at 72 for months is stable, however high.
        ((72, 72, 73, 72, 71, 72, 72, 72), Trajectory.STABLE),
        # Low and flat is stable too.
        ((12, 12, 13, 12, 12), Trajectory.STABLE),
        # A moderate climb: a little over a point a week.
        ((40, 41.5, 43, 44, 45.5, 47, 48, 50), Trajectory.SLOW_RISE),
        # 35 to 68 in three weeks: the hot list.
        ((35, 46, 57, 68), Trajectory.FAST_RISE),
        # Steady for a while, then a sharp climb.
        ((40, 40, 41, 40, 48, 58, 68), Trajectory.FAST_RISE),
        # The refactor pays.
        ((70, 66, 62, 58, 54, 50), Trajectory.IMPROVING),
        # Three snapshots are not a history yet.
        ((10, 40, 80), Trajectory.NEW),
        # Noise around a value is not a rise.
        ((50, 52, 50, 52, 51), Trajectory.STABLE),
    ],
)
def test_trajectory_classes(risks, expected):
    assert classify("a.py", weekly(*risks)).trajectory is expected


def test_a_rewrite_restarts_the_history():
    trend = classify("a.py", weekly(80, 82, 84, 40, 41, 42))
    assert trend.reset
    assert trend.trajectory is Trajectory.NEW
    assert [p.risk for p in trend.points] == [40, 41, 42]


def test_snapshots_older_than_the_window_are_left_out():
    old = [Point(START - timedelta(days=200), 10.0)]
    trend = classify("a.py", old + weekly(60, 60, 61, 60))
    assert trend.trajectory is Trajectory.STABLE
    assert len(trend.points) == 4


def test_entering_the_hot_list_is_flagged_once():
    entering = classify("a.py", weekly(40, 40, 41, 40, 44, 70))
    staying = classify("a.py", weekly(35, 46, 57, 68, 79))
    assert entering.trajectory is Trajectory.FAST_RISE and entering.entered_hot
    assert staying.trajectory is Trajectory.FAST_RISE and not staying.entered_hot


def test_the_why_is_measured_not_guessed():
    points = [
        Point(START + timedelta(weeks=i), r, complexity=c, churn=ch)
        for i, (r, c, ch) in enumerate(
            [(30, 10, 1), (40, 12, 3), (50, 13, 5), (60, 14, 9)]
        )
    ]
    trend = classify("a.py", points)
    assert trend.complexity_change_pct == pytest.approx(40.0)
    assert (trend.churn_start, trend.churn_now) == (1, 9)


def test_a_directory_rising_together_is_a_cluster():
    trends = [
        classify("src/billing/a.ts", weekly(30, 40, 50, 60)),
        classify("src/billing/b.ts", weekly(30, 32, 34, 36, 38)),
        classify("src/billing/c.ts", weekly(50, 50, 50, 50)),
        classify("src/auth/x.go", weekly(30, 40, 50, 60)),
        classify("src/auth/y.go", weekly(50, 50, 50, 50)),
        classify("src/auth/z.go", weekly(50, 50, 50, 50)),
        classify("lib/new.rb", weekly(10, 90)),
    ]
    clusters = degrading_clusters(trends)
    assert [c["directory"] for c in clusters] == ["src/billing"]
    assert clusters[0]["files"] == ["src/billing/a.ts", "src/billing/b.ts"]
    assert (clusters[0]["rising"], clusters[0]["total"], clusters[0]["fast"]) == (
        2,
        3,
        1,
    )


def test_the_report_lists_the_hot_files_fastest_first():
    report = build_trend_report(
        {
            "a.py": weekly(35, 46, 57, 68),
            "b.cs": weekly(20, 40, 60, 80),
            "c.java": weekly(40, 41.5, 43, 44, 45.5, 47, 48, 50),
            "d.php": weekly(10, 10),
        },
        snapshots=8,
    )
    assert [h["file"] for h in report["hot"]] == ["b.cs", "a.py"]
    assert [r["file"] for r in report["rising"]] == ["c.java"]
    assert report["counts"] == {
        "new": 1,
        "stable": 0,
        "slow_rise": 1,
        "fast_rise": 2,
        "improving": 0,
    }
    assert report["hot"][0]["points"][0] == {"day": "2026-06-01", "risk": 20.0}


def _report(path: str, risk: float, complexity: float = 5.0):
    return SimpleNamespace(
        file_path=path,
        risk_score=risk,
        cyclomatic_complexity=complexity,
        git_churn_count=2,
        test_coverage_percent=0.0,
    )


def test_one_snapshot_a_day_and_a_bounded_history(tmp_path, monkeypatch):
    monkeypatch.setattr(history_store, "MAX_SNAPSHOTS", 3)
    store = RiskHistoryStore(tmp_path)
    day = datetime(2026, 6, 1, tzinfo=UTC)
    store.record([_report("src\\a.py", 10)], day)
    store.record([_report("src\\a.py", 20)], day + timedelta(hours=3))
    assert store.days() == ["2026-06-01"]
    assert [p.risk for p in store.series()["src/a.py"]] == [20.0]

    for offset in range(1, 6):
        store.record([_report("src/a.py", 20 + offset)], day + timedelta(days=offset))
    assert store.days() == ["2026-06-04", "2026-06-05", "2026-06-06"]


def test_an_unreadable_history_is_empty_not_an_error(tmp_path):
    db = tmp_path / ".workpilot" / "self-healing" / "health_history.sqlite"
    db.parent.mkdir(parents=True)
    db.write_bytes(b"not a database")
    store = RiskHistoryStore(tmp_path)
    assert store.series() == {}
    assert store.record([_report("a.py", 1)]) == ""


def test_the_scan_records_every_measured_file(tmp_path):
    (tmp_path / "svc").mkdir()
    (tmp_path / "svc" / "simple.go").write_text("package svc\n", encoding="utf-8")
    (tmp_path / "svc" / "branchy.kt").write_text(
        "\n".join("if (x) { y() } else { z() }" for _ in range(40)), encoding="utf-8"
    )
    (tmp_path / "svc" / "README.md").write_text("# svc\n", encoding="utf-8")
    (tmp_path / "svc" / "test_simple.py").write_text("x = 1\n", encoding="utf-8")
    (tmp_path / "svc" / "simple.spec.ts").write_text("it()\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "dep.js").write_text("if(a){}", encoding="utf-8")
    mode = ProactiveMode(tmp_path, risk_threshold=90.0)

    reports = asyncio.run(mode.scan_fragility())

    assert reports == []  # nothing above 90…
    series = mode.history.series()
    assert set(series) == {"svc/simple.go", "svc/branchy.kt"}  # …but all measured
    with sqlite3.connect(mode.history.db_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM snapshot").fetchone() == (2,)
    report = mode.trend_report()
    assert report["snapshots"] == 1
    assert report["counts"]["new"] == 2


def test_no_history_or_one_day_of_it_is_not_a_trend():
    assert classify("a.py", []).trajectory is Trajectory.NEW
    same_day = [Point(START, r) for r in (10, 40, 70, 90)]
    trend = classify("a.py", same_day)
    assert trend.trajectory is Trajectory.STABLE
    assert (trend.slope, trend.acceleration) == (0.0, 0.0)


def test_a_directory_where_most_files_hold_is_not_a_cluster():
    trends = [
        classify("src/pay/a.ts", weekly(30, 40, 50, 60)),
        classify("src/pay/b.ts", weekly(30, 40, 50, 60)),
        *(classify(f"src/pay/{n}.ts", weekly(50, 50, 50, 50)) for n in "cde"),
    ]
    assert degrading_clusters(trends) == []


def test_the_store_keeps_named_files_only_and_caps_a_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(history_store, "MAX_FILES_PER_SNAPSHOT", 2)
    store = RiskHistoryStore(tmp_path)
    assert store.record([]) == ""
    assert store.record([_report("", 50)]) == ""
    assert store.days() == []
    store.record([_report(f"f{i}.py", i) for i in range(5)])
    assert set(store.series()) == {"f0.py", "f1.py"}


def test_a_row_with_a_broken_day_is_skipped(tmp_path):
    store = RiskHistoryStore(tmp_path)
    store.record([_report("a.py", 5)], datetime(2026, 6, 1, tzinfo=UTC))
    with sqlite3.connect(store.db_path) as connection:
        connection.execute(
            "INSERT INTO snapshot VALUES ('yesterday', 'a.py', 9, 0, 0, 0)"
        )
    assert [p.day for p in store.series()["a.py"]] == [date(2026, 6, 1)]


def test_unreadable_days_are_none(tmp_path):
    db = tmp_path / ".workpilot" / "self-healing" / "health_history.sqlite"
    db.parent.mkdir(parents=True)
    db.write_bytes(b"not a database")
    assert RiskHistoryStore(tmp_path).days() == []
