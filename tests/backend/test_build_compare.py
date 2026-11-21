"""How a project compares (`shared_features.build_compare`) and the desktop's
runner of it (`runners/build_compare_runner.py`).

Every figure is read from the project folders: the ledgers the agents keep
and the spec plans. A spec's figures are the same whatever its stack and its
provider; a group's median is given only from `min_group` projects up; the
desktop's runner reads only folders and leaves out those that are gone.
"""

from __future__ import annotations

import io
import json
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from runners import build_compare_runner as runner
from shared_features import build_compare, usage_ledger
from shared_features.build_compare import ProjectFacts, SpecFacts

NOW = datetime(2026, 11, 16, 12, tzinfo=UTC)


def _write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def _usage(spec: str, at: datetime, cost: float, agent: str = "coder") -> dict:
    return {
        "provider": "ollama",
        "model": "qwen",
        "input_tokens": 1,
        "output_tokens": 1,
        "cost": cost,
        "spec_id": spec,
        "agent_type": agent,
        "phase": "coding",
        "timestamp": at.isoformat(),
    }


def _plan(project: Path, spec: str, sessions: object, *, workspace: bool = False):
    base = project / ".workpilot"
    if workspace:
        base = base / "worktrees" / "tasks" / spec / ".workpilot"
    _write(
        base / "specs" / spec / "implementation_plan.json",
        {"qa_signoff": {"status": "approved", "qa_session": sessions}},
    )


def _spec(spec_id: str, started: datetime, minutes: float, cost: float, **extra):
    return SpecFacts(
        spec_id=spec_id,
        started=started,
        minutes=minutes,
        cost=cost,
        qa_iterations=extra.get("qa"),
        agents=extra.get("agents"),
    )


@pytest.mark.parametrize(
    ("plan", "expected"),
    [
        (None, None),
        ({"qa_signoff": "approved"}, None),
        ({"qa_signoff": {"qa_session": True}}, None),
        ({"qa_signoff": {"qa_session": "3"}}, None),
        ({"qa_signoff": {"qa_session": 0}}, None),
        ({"qa_signoff": {"qa_session": 10**6}}, None),
        ({"qa_signoff": {"qa_session": 3}}, 3),
    ],
)
def test_a_plan_s_qa_sessions_are_a_bounded_count(plan, expected):
    assert build_compare._qa_session(plan) == expected


def test_qa_iterations_take_the_highest_count_of_a_spec_s_plans(tmp_path):
    _plan(tmp_path, "001-login", 1)
    _plan(tmp_path, "001-login", 3, workspace=True)
    _plan(tmp_path, "002-cart", 2)
    _plan(tmp_path, "003-help", "many")
    _plan(tmp_path, "Not-a-card", 9)
    assert build_compare.qa_iterations(tmp_path) == {"001-login": 3, "002-cart": 2}


def test_qa_iterations_without_specs_are_empty(tmp_path):
    assert build_compare.qa_iterations(tmp_path) == {}


def test_qa_iterations_stop_at_the_plan_count_and_the_byte_budget(
    tmp_path, monkeypatch
):
    for spec in ("001-a", "002-b", "003-c"):
        _plan(tmp_path, spec, 2)
    monkeypatch.setattr(build_compare, "MAX_PLANS", 2)
    assert build_compare.qa_iterations(tmp_path) == {"001-a": 2, "002-b": 2}

    monkeypatch.setattr(build_compare, "MAX_PLANS", 500)
    size = len(
        (
            tmp_path / ".workpilot" / "specs" / "001-a" / "implementation_plan.json"
        ).read_bytes()
    )
    monkeypatch.setattr(build_compare, "PLANS_TOTAL", size)
    assert build_compare.qa_iterations(tmp_path) == {"001-a": 2}


def test_spec_facts_are_the_same_on_every_provider(tmp_path):
    start = NOW - timedelta(days=2)
    usages = [
        usage_ledger.Usage("001-a", "ollama", "qwen", "coding", 1, 1, 0.0, start),
        usage_ledger.Usage(
            "001-a",
            "openai",
            "gpt",
            "qa",
            1,
            1,
            0.25,
            start + timedelta(minutes=30),
            agent_type="qa_reviewer",
        ),
        usage_ledger.Usage(
            "001-a",
            "anthropic",
            "sonnet",
            "coding",
            1,
            1,
            0.75,
            start + timedelta(minutes=10),
            agent_type="coder",
        ),
        usage_ledger.Usage("002-b", "copilot", "x", "coding", 1, 1, 1.0, start),
    ]
    first, second = build_compare.spec_facts(usages, {"001-a": 2})
    assert first == SpecFacts("001-a", start, 30.0, 1.0, 2, 2)
    # No agent named: no agent count rather than zero.
    assert second == SpecFacts("002-b", start, 0.0, 1.0, None, None)


def _git(project: Path, files: int) -> None:
    subprocess.run(["git", "init", "-q", str(project)], check=True)
    for index in range(files):
        (project / f"f{index}.txt").write_text("x", encoding="utf-8")
    subprocess.run(["git", "-C", str(project), "add", "."], check=True)


def test_the_size_bucket_counts_the_tracked_files(tmp_path, monkeypatch):
    assert build_compare.size_bucket(tmp_path / "gone") == "unknown"
    plain = tmp_path / "plain"
    plain.mkdir()
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    assert build_compare.size_bucket(plain) == "unknown"
    repo = tmp_path / "repo"
    _git(repo, 3)
    assert build_compare.size_bucket(repo) == "small"
    monkeypatch.setattr(build_compare, "SIZE_BUCKETS", ((2, "small"), (3, "medium")))
    assert build_compare.size_bucket(repo) == "monorepo"


def test_the_main_stack_is_the_first_language_detected(tmp_path, monkeypatch):
    import project.stack

    monkeypatch.setattr(project.stack, "detect_languages", lambda _d: [])
    assert build_compare.main_stack(tmp_path) == "other"
    monkeypatch.setattr(
        project.stack, "detect_languages", lambda _d: ["csharp", "typescript"]
    )
    assert build_compare.main_stack(tmp_path) == "csharp"


def test_project_facts_read_the_ledgers_and_the_plans(tmp_path, monkeypatch):
    monkeypatch.setattr(build_compare, "main_stack", lambda _d: "go")
    monkeypatch.setattr(build_compare, "size_bucket", lambda _d: "medium")
    start = NOW - timedelta(days=1)
    _write(
        tmp_path / ".workpilot" / "cost_data.json",
        {"usages": [_usage("001-a", start, 0.5, agent="planner")]},
    )
    _write(
        tmp_path
        / ".workpilot"
        / "worktrees"
        / "tasks"
        / "001-a"
        / ".workpilot"
        / "cost_data.json",
        {"usages": [_usage("001-a", start + timedelta(minutes=45), 1.5)]},
    )
    _plan(tmp_path, "001-a", 2, workspace=True)
    facts = build_compare.project_facts(tmp_path)
    assert facts == ProjectFacts(
        "go", "medium", (SpecFacts("001-a", start, 45.0, 2.0, 2, 2),)
    )


def test_a_window_holds_the_medians_of_the_specs_started_in_it():
    facts = ProjectFacts(
        "python",
        "small",
        (
            _spec("001-a", NOW - timedelta(days=1), 10, 1.0, qa=1, agents=3),
            _spec("002-b", NOW - timedelta(days=2), 30, 3.0),
            _spec("003-c", NOW - timedelta(days=40), 99, 99.0),
            _spec("004-d", NOW, 99, 99.0),
        ),
    )
    assert build_compare.window(facts, NOW - timedelta(days=30), NOW) == {
        "specs": 2,
        "minutes": 20.0,
        "cost": 2.0,
        "qa_iterations": 1.0,
        "agents": 3.0,
    }
    empty = build_compare.window(
        facts, NOW - timedelta(days=5), NOW - timedelta(days=4)
    )
    assert empty == {
        "specs": 0,
        "minutes": None,
        "cost": None,
        "qa_iterations": None,
        "agents": None,
    }


@pytest.mark.parametrize(
    ("recent", "previous", "expected"),
    [(None, 1.0, None), (1.0, None, None), (1.0, 0.0, None), (15.0, 10.0, 50.0)],
)
def test_the_trend_is_a_percent_change(recent, previous, expected):
    assert build_compare._trend(recent, previous) == expected


def _project(stack: str, size: str, *specs: SpecFacts) -> ProjectFacts:
    return ProjectFacts(stack, size, specs)


def test_a_group_s_median_is_given_from_min_group_projects():
    recent = NOW - timedelta(days=1)
    current = _project(
        "csharp",
        "medium",
        _spec("001-a", recent, 10, 1.0),
        _spec("002-b", NOW - timedelta(days=40), 20, 2.0),
    )
    peers = [
        _project("csharp", "medium", _spec("001-x", recent, 30, 3.0)),
        _project("csharp", "medium", _spec("001-x", recent, 50, 5.0)),
        _project("csharp", "large", _spec("001-x", recent, 70, 7.0)),
        _project("rust", "medium", _spec("001-x", recent, 90, 9.0)),
        # No spec in the last thirty days: not counted.
        _project("csharp", "medium", _spec("001-x", NOW - timedelta(days=50), 1, 1.0)),
    ]
    answer = build_compare.compare(current, peers, NOW, min_group=3)
    assert answer["window_days"] == 30 and answer["min_group"] == 3
    assert answer["segment"] == {"stack": "csharp", "size": "medium"}
    assert answer["recent"]["minutes"] == 10.0
    assert answer["previous"]["minutes"] == 20.0
    assert answer["trend"]["minutes"] == -50.0
    assert answer["trend"]["qa_iterations"] is None
    assert answer["groups"]["segment"] == {"projects": 2, "medians": None}
    assert answer["groups"]["stack"]["projects"] == 3
    assert answer["groups"]["stack"]["medians"]["minutes"] == 50.0
    assert answer["groups"]["all"]["medians"]["cost"] == 6.0
    assert answer["groups"]["all"]["medians"]["agents"] is None


def test_compare_paths_reads_each_folder(tmp_path):
    read: list[Path] = []

    def reader(path: Path) -> ProjectFacts:
        read.append(path)
        return _project("php", "small", _spec("001-a", NOW - timedelta(days=1), 5, 1))

    answer = build_compare.compare_paths(
        tmp_path / "a", [tmp_path / "b"], NOW, min_group=1, read=reader
    )
    assert read == [tmp_path / "a", tmp_path / "b"]
    assert answer["groups"]["segment"]["medians"]["minutes"] == 5.0


def test_a_peer_line_is_a_project_s_name_segment_and_window():
    facts = _project("dart", "large", _spec("001-a", NOW - timedelta(days=1), 5, 1))
    line = build_compare.peer_line("Mobile app", facts, NOW)
    assert line["name"] == "Mobile app" and line["stack"] == "dart"
    assert line["size"] == "large" and line["specs"] == 1


# --- runners/build_compare_runner.py ---------------------------------------


@pytest.fixture
def stubbed(monkeypatch):
    """Projects read by folder name: "busy…" has a recent spec, others none."""

    def facts(path: Path) -> ProjectFacts:
        if path.name.startswith("busy"):
            return _project(
                "python",
                "small",
                _spec("001-a", datetime.now(UTC) - timedelta(hours=1), 12, 2.0),
            )
        return _project("python", "small")

    monkeypatch.setattr(build_compare, "project_facts", facts)


@pytest.mark.parametrize(
    "raw",
    [
        None,
        {"name": "x"},
        {"path": ""},
        {"path": "a\0b"},
        {"path": "relative/dir"},
    ],
)
def test_the_runner_refuses_a_project_that_is_not_a_folder(raw):
    with pytest.raises(ValueError):
        runner._project(raw)


def test_the_runner_refuses_a_file_and_names_a_project_after_its_folder(tmp_path):
    file = tmp_path / "file.txt"
    file.write_text("x", encoding="utf-8")
    with pytest.raises(ValueError):
        runner._project({"path": str(file)})
    assert runner._project({"path": str(tmp_path), "name": "  "}) == (
        tmp_path.resolve(),
        tmp_path.name,
    )
    long = runner._project({"path": str(tmp_path), "name": "n" * 500})[1]
    assert len(long) == runner.NAME_MAX


def test_the_runner_compares_with_the_person_s_other_projects(tmp_path, stubbed):
    folders = {}
    for name in ("busy-current", "busy-peer", "idle-peer"):
        folders[name] = tmp_path / name
        folders[name].mkdir()
    request = {
        "current": {"path": str(folders["busy-current"]), "name": "Current"},
        "others": [
            {"path": str(folders["busy-peer"]), "name": "Peer"},
            {"path": str(folders["busy-peer"]), "name": "Twice"},
            {"path": str(folders["busy-current"]), "name": "Itself"},
            {"path": str(folders["idle-peer"]), "name": "Idle"},
            {"path": str(tmp_path / "removed"), "name": "Gone"},
        ],
    }
    answer = runner.handle(request, datetime.now(UTC))
    assert answer["min_group"] == runner.LOCAL_MIN_GROUP
    assert [(p["name"], p["current"]) for p in answer["projects"]] == [
        ("Current", True),
        ("Peer", False),
    ]
    assert answer["groups"]["all"]["projects"] == 1


def test_the_runner_needs_a_list_of_other_projects(tmp_path):
    with pytest.raises(ValueError):
        runner.handle({"current": {"path": str(tmp_path)}, "others": {}}, NOW)


def _main(monkeypatch, capsys, stdin: str) -> str:
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    runner.main()
    return capsys.readouterr().out


def test_the_runner_prints_its_result(tmp_path, stubbed, monkeypatch, capsys):
    request = {"current": {"path": str(tmp_path), "name": "Here"}, "others": []}
    out = _main(monkeypatch, capsys, json.dumps(request))
    assert out.startswith("BUILD_COMPARE_RESULT:")
    answer = json.loads(out.removeprefix("BUILD_COMPARE_RESULT:"))
    assert answer["projects"][0]["name"] == "Here"


@pytest.mark.parametrize("stdin", ["[]", "", "{not json"])
def test_the_runner_prints_an_error_and_exits(stdin, monkeypatch, capsys):
    with pytest.raises(SystemExit) as stopped:
        _main(monkeypatch, capsys, stdin)
    assert stopped.value.code == 1
    assert capsys.readouterr().out.startswith("BUILD_COMPARE_ERROR:")


def test_the_runner_runs_as_the_desktop_starts_it(tmp_path):
    """`python runners/build_compare_runner.py`, the request on stdin."""
    import os
    import sys

    project = tmp_path / "project"
    _write(
        project / ".workpilot" / "cost_data.json",
        {"usages": [_usage("001-a", datetime.now(UTC) - timedelta(hours=2), 0.4)]},
    )
    request = {"current": {"path": str(project), "name": "Mine"}, "others": []}
    done = subprocess.run(
        [sys.executable, str(Path(runner.__file__))],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        env={**os.environ, "GIT_CEILING_DIRECTORIES": str(tmp_path)},
        check=False,
    )
    assert done.returncode == 0, done.stderr
    line = next(
        row for row in done.stdout.splitlines() if row.startswith("BUILD_COMPARE_")
    )
    answer = json.loads(line.removeprefix("BUILD_COMPARE_RESULT:"))
    assert answer["recent"]["cost"] == pytest.approx(0.4)
    assert answer["segment"] == {"stack": "other", "size": "unknown"}
    assert str(project) not in json.dumps(answer["groups"])
