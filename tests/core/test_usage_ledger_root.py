"""The usage ledgers of a project live at its root, whatever directory a task ran in.

A Kanban build runs in ``<root>/.workpilot/worktrees/tasks/<spec>/`` and hands
that worktree to ``usage_tracker`` as its project. The dashboard read
``<root>/.workpilot/dashboard_snapshot.json`` only, so a project whose tasks
had all finished showed 0 tasks, 0 tokens, 0 € (only the merge, recorded by the
main project, reached it), and deleting the worktree after the merge deleted
the figures. These tests hold every writer to the project root.
"""

from __future__ import annotations

import json
import multiprocessing
import os
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from core import usage_tracker
from core.usage_tracker import (
    catalog_cost,
    ledger_root,
    record_build_end,
    record_merge,
    record_qa_result,
    record_session_usage,
    record_task_status,
    start_build,
)
from foundation import json_ledger
from foundation.json_ledger import update_json
from harness.domain.cost import TokenPrices


def _worktree(root: Path, spec: str = "004-tutu") -> tuple[Path, Path]:
    worktree = root / ".workpilot" / "worktrees" / "tasks" / spec
    spec_dir = worktree / ".workpilot" / "specs" / spec
    spec_dir.mkdir(parents=True)
    return worktree, spec_dir


def _read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(autouse=True)
def _no_analytics_db(monkeypatch):
    # The SQLite destination is not under test and needs a configured database.
    monkeypatch.setattr(
        usage_tracker, "_append_token_usage_to_db", lambda *a, **k: None
    )
    monkeypatch.setattr(usage_tracker, "_write_build_to_analytics_db", lambda *a: None)


@pytest.mark.parametrize(
    ("relative", "expected"),
    [
        (".workpilot/worktrees/tasks/004-x", "."),
        (".workpilot/worktrees/tasks/004-x/src", "."),
        (".worktrees/004-x", "."),
        ("", "."),
        ("apps/api", "apps/api"),
    ],
)
def test_ledger_root_is_the_project_that_owns_the_worktree(
    tmp_path, relative, expected
):
    assert ledger_root(tmp_path / relative) == tmp_path / expected


def test_a_build_in_a_worktree_records_its_spend_at_the_project_root(tmp_path):
    worktree, spec_dir = _worktree(tmp_path)

    record_session_usage(
        spec_dir=spec_dir,
        project_dir=worktree,
        phase="coding",
        agent_type="coder",
        model="claude-haiku-4-5",
        provider="claude",
        input_tokens=82,
        output_tokens=2411,
        cost_usd=0.1092833,
        cache_creation_input_tokens=28204,
        cache_read_input_tokens=384732,
    )

    root_ledgers = tmp_path / ".workpilot"
    usages = _read(root_ledgers / "cost_data.json")["usages"]
    assert [(u["spec_id"], u["output_tokens"]) for u in usages] == [("004-tutu", 2411)]
    assert usages[0]["project_id"] == str(tmp_path)
    snapshot = _read(root_ledgers / "dashboard_snapshot.json")
    assert snapshot["total_tokens"] == 82 + 2411
    assert snapshot["cost_by_model"] == {"claude/claude-haiku-4-5": 0.1092833}
    assert (root_ledgers / "carbon-ledger.json").exists()
    # Nothing is left in the worktree, which the merge deletes.
    assert not (worktree / ".workpilot" / "cost_data.json").exists()
    assert not (worktree / ".workpilot" / "dashboard_snapshot.json").exists()


def test_qa_merge_and_task_outcomes_reach_the_project_root(tmp_path):
    worktree, _spec_dir = _worktree(tmp_path)

    record_qa_result(worktree, "004-tutu", passed=True, score=100.0)
    record_qa_result(worktree, "004-tutu", passed=False, score=0.0)
    record_task_status(worktree, "004-tutu", "completed", "simple", 120.0)
    record_merge(tmp_path, automatic=False)

    snapshot = _read(tmp_path / ".workpilot" / "dashboard_snapshot.json")
    assert snapshot["qa_first_pass_rate"] == 50.0
    assert snapshot["_qa_total"] == 2
    assert snapshot["tasks_by_status"] == {"completed": 1}
    assert snapshot["avg_completion_by_complexity"] == {"simple": [120.0]}
    assert snapshot["merge_manual_count"] == 1
    assert not (worktree / ".workpilot" / "dashboard_snapshot.json").exists()


def test_a_completed_build_reports_its_duration_and_complexity(tmp_path):
    worktree, spec_dir = _worktree(tmp_path)
    (spec_dir / "complexity_assessment.json").write_text(
        json.dumps({"complexity": "Complex"}), encoding="utf-8"
    )
    start_build(spec_dir, worktree, spec_dir.name, None, "m", "claude")
    usage_tracker._active_builds[str(spec_dir)]["started_at"] = (
        "2026-11-01T10:00:00+00:00"
    )

    record_build_end(worktree, spec_dir, "complete", "completed")

    snapshot = _read(tmp_path / ".workpilot" / "dashboard_snapshot.json")
    assert snapshot["tasks_by_status"] == {"completed": 1}
    [seconds] = snapshot["avg_completion_by_complexity"]["complex"]
    assert seconds > 0


def test_a_build_end_never_raises(tmp_path, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("disk gone")

    monkeypatch.setattr(usage_tracker, "finish_build", boom)
    record_build_end(tmp_path, tmp_path / "spec", "complete", "completed")


def test_a_provider_that_reports_no_price_is_priced_from_the_catalog(
    tmp_path, monkeypatch
):
    import harness.application.budget as budget

    monkeypatch.setattr(
        budget,
        "prices_for",
        lambda provider, model: (
            TokenPrices(input=1.0, output=10.0)
            if (provider, model) == ("mistral", "devstral")
            else None
        ),
    )
    spec_dir = tmp_path / ".workpilot" / "specs" / "001-x"
    spec_dir.mkdir(parents=True)

    for provider, model in (("mistral", "devstral"), ("ollama", "qwen")):
        record_session_usage(
            spec_dir=spec_dir,
            project_dir=tmp_path,
            phase="coding",
            agent_type="coder",
            model=model,
            provider=provider,
            input_tokens=1_000_000,
            output_tokens=100_000,
            cost_usd=0.0,
        )

    costs = {
        u["provider"]: u["cost"]
        for u in _read(tmp_path / ".workpilot" / "cost_data.json")["usages"]
    }
    assert costs == {"mistral": pytest.approx(2.0), "ollama": 0.0}


def test_an_unknown_model_costs_nothing_rather_than_a_guess():
    assert catalog_cost("nobody", "nothing", 10, 10) == 0.0


def test_an_older_snapshot_missing_fields_is_completed_not_replaced(tmp_path):
    ledgers = tmp_path / ".workpilot"
    ledgers.mkdir()
    (ledgers / "dashboard_snapshot.json").write_text(
        json.dumps({"merge_manual_count": 1, "cost_by_model": None}), encoding="utf-8"
    )

    record_qa_result(tmp_path, "001", passed=True, score=90.0)

    snapshot = _read(ledgers / "dashboard_snapshot.json")
    assert snapshot["merge_manual_count"] == 1
    assert snapshot["cost_by_model"] == {}
    assert snapshot["qa_avg_score"] == 90.0


def _append_many(path: str, start: int, count: int) -> None:
    for index in range(start, start + count):

        def change(data, index=index):
            data["usages"].append(index)
            return data

        update_json(Path(path), lambda: {"usages": []}, change)


def test_concurrent_processes_lose_no_record(tmp_path):
    """Several tasks run at once, each in its own process, on one ledger."""
    ledger = tmp_path / "cost_data.json"
    context = multiprocessing.get_context("spawn")
    workers = [
        context.Process(target=_append_many, args=(str(ledger), n * 100, 25))
        for n in range(4)
    ]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(60)
        assert worker.exitcode == 0

    assert sorted(_read(ledger)["usages"]) == sorted(
        n * 100 + i for n in range(4) for i in range(25)
    )
    assert not ledger.with_name("cost_data.json.lock").exists()


def test_a_lock_left_by_a_dead_process_is_taken_over(tmp_path, monkeypatch):
    ledger = tmp_path / "dashboard_snapshot.json"
    lock = tmp_path / "dashboard_snapshot.json.lock"
    lock.write_text("", encoding="utf-8")
    old = time.time() - json_ledger.STALE_AFTER_S - 5
    os.utime(lock, (old, old))

    update_json(ledger, dict, lambda d: {**d, "merge_auto_count": 1})

    assert _read(ledger) == {"merge_auto_count": 1}
    assert not lock.exists()


def test_a_held_lock_never_blocks_telemetry_forever(tmp_path, monkeypatch):
    monkeypatch.setattr(json_ledger, "WAIT_S", 0.05)
    ledger = tmp_path / "cost_data.json"
    (tmp_path / "cost_data.json.lock").write_text("", encoding="utf-8")

    update_json(ledger, lambda: {"usages": []}, lambda d: d)

    assert _read(ledger) == {"usages": []}
    # Someone else's lock is left alone.
    assert (tmp_path / "cost_data.json.lock").exists()


def test_the_spec_probe_keeps_what_the_usage_tracker_reads():
    from context_mgmt.sdk_usage import SdkUsageProbe

    probe = SdkUsageProbe(model="claude-sonnet-4-6")
    result = type("ResultMessage", (), {})()
    result.usage = {"input_tokens": 12, "output_tokens": 340}
    result.total_cost_usd = 0.05
    probe.update(result)

    assert probe.provider_name() == "claude"
    assert probe.model == "claude-sonnet-4-6"
    assert probe.last_usage["output_tokens"] == 340
    assert probe.last_usage["cost_usd"] == 0.05


def test_a_spec_session_counts_in_the_project_ledger(tmp_path):
    from context_mgmt.sdk_usage import SdkUsageProbe
    from spec.pipeline.agent_runner import AgentRunner

    spec_dir = tmp_path / ".workpilot" / "specs" / "001-x"
    spec_dir.mkdir(parents=True)
    probe = SdkUsageProbe(model="claude-sonnet-4-6")
    result = type("ResultMessage", (), {})()
    result.usage = {"input_tokens": 12, "output_tokens": 340}
    result.total_cost_usd = 0.05
    probe.update(result)
    runner = SimpleNamespace(spec_dir=spec_dir)

    AgentRunner._record_usage(runner, probe, "spec_writer")

    [usage] = _read(tmp_path / ".workpilot" / "cost_data.json")["usages"]
    assert (usage["phase"], usage["agent_type"], usage["cost"]) == (
        "spec",
        "spec_writer",
        0.05,
    )
