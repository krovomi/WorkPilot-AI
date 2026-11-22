"""The figures for which more is better in "How you compare" (mutation score,
first-run CI), each group's trend, and a project that changed segment
(`shared_features.build_compare_quality`, `build_compare`).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from shared_features import build_compare
from shared_features import build_compare_quality as quality
from shared_features.build_compare import ProjectFacts, SpecFacts

NOW = datetime(2026, 11, 16, 12, tzinfo=UTC)
RECENT = NOW - timedelta(days=1)
BEFORE = NOW - timedelta(days=40)


def _write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def _spec(spec_id: str, started: datetime, minutes: float = 10, **extra) -> SpecFacts:
    return SpecFacts(
        spec_id=spec_id,
        started=started,
        minutes=minutes,
        cost=1.0,
        qa_iterations=None,
        agents=None,
        **extra,
    )


@pytest.mark.parametrize(
    ("record", "expected"),
    [
        (None, None),
        ({}, None),
        ({"score": True}, None),
        ({"score": "90"}, None),
        ({"score": 101}, None),
        ({"score": -1}, None),
        ({"status": "pass", "score": None}, None),
        ({"status": "fail", "score": 40}, 40),
        ({"status": "unknown", "score": 0}, 0),
    ],
)
def test_a_mutation_score_is_a_whole_percent(record, expected):
    assert quality.mutation_score(record) == expected


@pytest.mark.parametrize(
    ("record", "expected"),
    [
        ([], None),
        ({}, None),
        ({"first_ci": 1}, None),
        ({"first_ci": "green"}, None),
        ({"first_ci": "passed"}, True),
        ({"first_ci": "failed"}, False),
    ],
)
def test_a_first_ci_result_is_passed_or_failed(record, expected):
    assert quality.first_ci(record) is expected


def test_the_pass_rate_counts_the_recorded_results_only():
    assert quality.pass_rate([]) is None
    assert quality.pass_rate([None, None]) is None
    assert quality.pass_rate([True, False, None, True, True]) == 75.0


def _spec_dir(project: Path, spec: str, *, workspace: bool = False) -> Path:
    base = project / ".workpilot"
    if workspace:
        base = base / "worktrees" / "tasks" / spec / ".workpilot"
    return base / "specs" / spec


def test_the_records_are_read_from_each_spec_and_its_build_workspace(tmp_path):
    _write(_spec_dir(tmp_path, "001-a") / "mutation_gate.json", {"score": 50})
    _write(
        _spec_dir(tmp_path, "001-a", workspace=True) / "mutation_gate.json",
        {"score": 80, "results": [{"outcome": "killed"}] * 4},
    )
    _write(_spec_dir(tmp_path, "002-b") / "mutation_gate.json", {"score": None})
    _write(_spec_dir(tmp_path, "002-b") / "pr_followup.json", {"first_ci": "failed"})
    _write(_spec_dir(tmp_path, "003-c") / "pr_followup.json", {"rounds": 2})
    # Not a card's folder: never read.
    _write(_spec_dir(tmp_path, "notes") / "pr_followup.json", {"first_ci": "passed"})
    assert build_compare.mutation_scores(tmp_path) == {"001-a": 80}
    assert build_compare.first_ci_results(tmp_path) == {"002-b": False}


def test_a_link_out_of_the_project_is_not_followed(tmp_path):
    outside = tmp_path / "outside.json"
    _write(outside, {"score": 99})
    project = tmp_path / "project"
    spec = _spec_dir(project, "001-a")
    spec.mkdir(parents=True)
    (spec / "mutation_gate.json").symlink_to(outside)
    assert build_compare.mutation_scores(project) == {}


def test_project_facts_carry_the_quality_records(tmp_path, monkeypatch):
    monkeypatch.setattr(build_compare, "size_bucket", lambda _d: "small")
    monkeypatch.setattr(build_compare.segments, "team_bucket", lambda _d: "solo")
    monkeypatch.setattr(build_compare, "main_stack", lambda _d: "go")
    _write(
        tmp_path / ".workpilot" / "cost_data.json",
        {
            "usages": [
                {
                    "provider": "openai",
                    "model": "gpt",
                    "input_tokens": 1,
                    "output_tokens": 1,
                    "cost": 0.5,
                    "spec_id": "001-a",
                    "agent_type": "coder",
                    "timestamp": RECENT.isoformat(),
                }
            ]
        },
    )
    _write(_spec_dir(tmp_path, "001-a") / "mutation_gate.json", {"score": 70})
    _write(_spec_dir(tmp_path, "001-a") / "pr_followup.json", {"first_ci": "passed"})
    (spec,) = build_compare.project_facts(tmp_path).specs
    assert spec.mutation_score == 70 and spec.ci_first_pass is True


def test_a_window_gives_the_median_score_and_the_pass_rate():
    facts = ProjectFacts(
        "go",
        "small",
        (
            _spec("001-a", RECENT, mutation_score=60, ci_first_pass=True),
            _spec("002-b", RECENT, mutation_score=90, ci_first_pass=False),
            _spec("003-c", RECENT, ci_first_pass=True),
            _spec("004-d", RECENT),
        ),
    )
    figures = build_compare.window(facts, NOW - timedelta(days=30), NOW)
    assert figures["mutation_score"] == 75.0
    assert figures["ci_first_pass"] == pytest.approx(200 / 3)


def test_the_top_tenth_of_a_higher_is_better_figure_is_the_last_decile():
    values = [float(v) for v in range(1, 11)]
    assert build_compare._top(values, 10, higher=True) == pytest.approx(9.1)
    assert build_compare._top(values, 10) == pytest.approx(1.9)


def _project(*specs: SpecFacts, size="small", team="solo", **extra) -> ProjectFacts:
    return ProjectFacts("go", size, specs, team, **extra)


def test_a_group_gives_its_top_tenth_per_direction_and_its_trend():
    peers = [
        _project(
            _spec("001-x", RECENT, minutes=10 * i, mutation_score=10 * i),
            _spec("002-x", BEFORE, minutes=5 * i),
        )
        for i in range(1, 11)
    ]
    current = _project(_spec("001-a", RECENT))
    group = build_compare.compare(current, peers, NOW, min_group=5, min_top=10)[
        "groups"
    ]["all"]
    assert group["medians"]["minutes"] == 55.0
    assert group["top"]["minutes"] == pytest.approx(19.0)
    assert group["top"]["mutation_score"] == pytest.approx(91.0)
    # The median went from 27.5 to 55 minutes; no score the window before.
    assert group["trend"]["minutes"] == pytest.approx(100.0)
    assert group["trend"]["mutation_score"] is None


def test_a_group_s_trend_needs_min_group_projects_in_both_windows():
    peers = [_project(_spec("001-x", RECENT)) for _ in range(5)]
    peers += [_project(_spec("001-y", RECENT), _spec("002-y", BEFORE))]
    current = _project(_spec("001-a", RECENT))
    answer = build_compare.compare(current, peers, NOW, min_group=5)
    assert answer["groups"]["all"]["projects"] == 6
    assert answer["groups"]["all"]["trend"] is None
    # The kinds' groups have no trend of their own.
    assert all("trend" not in line["group"] for line in answer["kinds"])


def test_a_project_that_grew_is_compared_with_its_old_and_new_peers():
    peers = [
        _project(_spec("001-x", RECENT), size="small", team="small"),
        _project(_spec("001-x", RECENT), size="medium", team="solo"),
        _project(_spec("001-x", RECENT), size="large", team="medium"),
    ]
    moving = _project(
        _spec("001-a", RECENT),
        size="medium",
        team="small",
        size_before="small",
        team_before="solo",
    )
    answer = build_compare.compare(moving, peers, NOW, min_group=1)
    assert answer["segment"]["size_from"] == "small"
    assert answer["segment"]["team_from"] == "solo"
    assert answer["groups"]["segment"]["projects"] == 2
    assert answer["groups"]["team"]["projects"] == 2
    # A young repository had no size a window ago: that is no move.
    settled = _project(
        _spec("001-a", RECENT), size="medium", size_before="unknown", team_before="solo"
    )
    answer = build_compare.compare(settled, peers, NOW, min_group=1)
    assert answer["segment"]["size_from"] is None
    assert answer["segment"]["team_from"] is None
    assert answer["groups"]["segment"]["projects"] == 1


def test_the_history_is_read_one_window_back(tmp_path, monkeypatch):
    asked: list[object] = []

    def files_at(project_dir: Path, moment: datetime) -> int | None:
        asked.append(moment)
        return files

    def team(project_dir: Path, *, days_ago: int = 0) -> str:
        asked.append(days_ago)
        return "small"

    monkeypatch.setattr(build_compare.segments, "tracked_files_at", files_at)
    monkeypatch.setattr(build_compare.segments, "team_bucket", team)
    facts = _project()
    files = 600
    found = build_compare.with_history(facts, tmp_path, NOW)
    assert (found.size_before, found.team_before) == ("medium", "small")
    assert asked == [NOW - timedelta(days=30), 30]
    files = None
    assert build_compare.with_history(facts, tmp_path, NOW).size_before == "unknown"


def test_compare_paths_reads_the_compared_project_s_history(tmp_path, monkeypatch):
    monkeypatch.setattr(build_compare.segments, "tracked_files_at", lambda *_a: 10)
    monkeypatch.setattr(
        build_compare.segments, "team_bucket", lambda *_a, **_k: "medium"
    )

    def reader(_path: Path) -> ProjectFacts:
        return _project(_spec("001-a", RECENT), size="medium", team="solo")

    answer = build_compare.compare_paths(
        tmp_path / "a", [tmp_path / "b"], NOW, min_group=1, read=reader
    )
    assert answer["segment"]["size_from"] == "small"
    assert answer["segment"]["team_from"] == "medium"
