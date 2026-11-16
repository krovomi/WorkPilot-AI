"""How the swarm splits a plan into waves of subtasks that can run side by side."""

from __future__ import annotations

from agents.swarm.dependency_analyzer import DependencyAnalyzer


def _plan(*phases: list[dict]) -> dict:
    return {
        "phases": [
            {"name": f"phase {i}", "subtasks": subtasks}
            for i, subtasks in enumerate(phases, start=1)
        ]
    }


def _waves(plan: dict, max_parallel: int = 4) -> list[list[str]]:
    waves, _nodes = DependencyAnalyzer(max_parallel=max_parallel).analyze(plan)
    return [sorted(w.subtask_ids) for w in waves]


def test_independent_subtasks_share_a_wave_up_to_the_parallel_cap() -> None:
    plan = _plan([{"id": str(i)} for i in range(1, 6)])

    assert _waves(plan, max_parallel=2) == [["1", "2"], ["3", "4"], ["5"]]


def test_a_subtask_without_an_id_or_already_done_is_left_out() -> None:
    plan = _plan(
        [
            {"description": "no id"},
            {"id": "1.1", "status": "completed"},
            {"id": "1.2"},
        ]
    )

    waves, nodes = DependencyAnalyzer().analyze(plan)

    assert list(nodes) == ["1.2"]
    assert [w.subtask_ids for w in waves] == [["1.2"]]


def test_subtasks_that_modify_the_same_file_run_one_after_the_other() -> None:
    plan = _plan(
        [
            {"id": "a", "files_to_modify": ["src/cart.py"]},
            {"id": "b", "files_to_modify": ["src/cart.py"]},
            {"id": "c", "files_to_modify": ["src/cart.py", "src/other.py"]},
        ]
    )

    assert _waves(plan) == [["a"], ["b"], ["c"]]


def test_a_file_is_created_before_it_is_modified() -> None:
    plan = _plan(
        [
            {"id": "edit", "files_to_modify": ["src/new.py"]},
            {"id": "create", "files_to_create": ["src/new.py"]},
        ]
    )

    assert _waves(plan) == [["create"], ["edit"]]


def test_a_subtask_that_names_itself_does_not_wait_for_itself() -> None:
    plan = _plan([{"id": "solo", "depends_on": ["solo", "missing"]}])

    assert _waves(plan) == [["solo"]]


def test_a_later_phase_already_after_the_earlier_one_gets_no_extra_edge() -> None:
    # D waits for B and C, which both wait for A: D already follows phase 1.
    plan = _plan(
        [
            {"id": "A"},
            {"id": "B", "depends_on": ["A"]},
            {"id": "C", "depends_on": ["A"]},
            {"id": "E"},
        ],
        [{"id": "D", "depends_on": ["B", "C"]}, {"id": "F"}],
    )

    analyzer = DependencyAnalyzer()
    waves, _ = analyzer.analyze(plan)

    assert [sorted(w.subtask_ids) for w in waves] == [
        ["A", "E"],
        ["B", "C", "F"],
        ["D"],
    ]
    # F had no path to phase 1: it waits for its first subtask only.
    assert analyzer._adjacency["F"] == {"A"}
    assert analyzer._adjacency["D"] == {"B", "C"}


def test_a_dependency_cycle_falls_back_to_one_subtask_per_wave() -> None:
    plan = _plan(
        [
            {"id": "free"},
            {"id": "x", "depends_on": ["y"]},
            {"id": "y", "depends_on": ["x"]},
        ]
    )

    waves, nodes = DependencyAnalyzer().analyze(plan)

    assert [w.subtask_ids for w in waves] == [["free"], ["x"], ["y"]]
    assert [w.index for w in waves] == [0, 1, 2]
    assert (nodes["x"].wave_index, nodes["y"].wave_index) == (1, 2)


def test_parallelism_stats_describe_the_waves() -> None:
    analyzer = DependencyAnalyzer(max_parallel=2)
    waves, _ = analyzer.analyze(_plan([{"id": "1"}, {"id": "2"}, {"id": "3"}]))

    assert analyzer.get_parallelism_stats(waves) == {
        "total_waves": 2,
        "max_parallelism": 2,
        "avg_parallelism": 1.5,
        "wave_sizes": [2, 1],
        "total_subtasks": 3,
        "speedup_estimate": 1.5,
    }


def test_a_swarm_that_has_not_started_reports_no_progress_or_durations() -> None:
    from agents.swarm.types import SwarmStatus

    analyzer = DependencyAnalyzer()
    waves, nodes = analyzer.analyze(_plan([{"id": "1"}]))
    status = SwarmStatus(waves=waves, nodes=nodes)

    data = status.to_dict()

    assert data["progress_percent"] == 0
    assert data["waves"][0]["duration_seconds"] is None
    assert data["nodes"]["1"]["duration_seconds"] is None

    waves[0].started_at, waves[0].completed_at = 100.0, 112.5
    nodes["1"].started_at, nodes["1"].completed_at = 100.0, 110.0
    data = status.to_dict()

    assert data["waves"][0]["duration_seconds"] == 12.5
    assert data["nodes"]["1"]["duration_seconds"] == 10.0
