"""Cost budgets read before each session (#355)."""

from __future__ import annotations

import json
import os
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cost_budget import (
    check_before_session,
    degrade_steps,
    evaluate,
    parse,
    step_down,
)
from cost_budget.degrade import newest
from cost_budget.spend import (
    period_start,
    project_root,
    project_spend,
    task_spend,
    usages,
)
from foundation.pause_state import is_paused, read_pause_state

NOW = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)


def _project(tmp_path: Path, budget: dict | None, usages: list[dict]) -> Path:
    root = tmp_path / "proj"
    (root / ".workpilot" / "specs" / "001-task").mkdir(parents=True)
    if budget is not None:
        (root / ".workpilot" / "cost-budget.json").write_text(
            json.dumps(budget), encoding="utf-8"
        )
    (root / ".workpilot" / "cost_data.json").write_text(
        json.dumps({"usages": usages, "budgets": {}}), encoding="utf-8"
    )
    return root


def _usage(
    cost: float, spec: str = "001-task", at: datetime | None = None, tokens: int = 100
) -> dict:
    return {
        "spec_id": spec,
        "cost": cost,
        "input_tokens": tokens,
        "output_tokens": 0,
        "timestamp": (at or datetime.now(UTC)).isoformat(),
    }


def _spec(root: Path) -> Path:
    return root / ".workpilot" / "specs" / "001-task"


def _plan(spec_dir: Path, statuses: list[str]) -> None:
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(
            {
                "phases": [
                    {
                        "subtasks": [
                            {"id": str(i), "status": s} for i, s in enumerate(statuses)
                        ]
                    }
                ]
            }
        ),
        encoding="utf-8",
    )


# -- config -------------------------------------------------------------------


def test_parse_keeps_sane_values_and_drops_the_rest():
    cfg = parse(
        {
            "limit": 20,
            "period": "weekly",
            "task_limit": "5",
            "on_exceed": "explode",
            "warning_threshold": 2,
            "critical_threshold": 0.5,
            "degrade": "yes",
        }
    )
    assert cfg.limit == 20 and cfg.period == "weekly"
    assert cfg.task_limit == 0  # a string is not an amount
    assert cfg.on_exceed == "pause"
    assert cfg.warning_threshold == 0.75
    assert cfg.critical_threshold == 0.75  # never under the warning one
    assert cfg.degrade is False


def test_no_budget_means_no_check(tmp_path):
    root = _project(tmp_path, None, [_usage(100.0)])
    assert evaluate(_spec(root)) is None
    assert check_before_session(_spec(root), "coding") is None
    assert not is_paused(_spec(root))


def test_legacy_budget_in_cost_data_is_read(tmp_path):
    root = _project(tmp_path, None, [_usage(3.0)])
    data = json.loads(
        (root / ".workpilot" / "cost_data.json").read_text(encoding="utf-8")
    )
    data["budgets"] = {str(root): {"limit": 2.0, "period": "total"}}
    (root / ".workpilot" / "cost_data.json").write_text(
        json.dumps(data), encoding="utf-8"
    )
    found = evaluate(_spec(root))
    assert found is not None and found.exceeded() is not None


# -- spend ----------------------------------------------------------------------


def test_project_root_of_a_worktree_spec_is_the_main_project(tmp_path):
    spec = (
        tmp_path
        / "p"
        / ".workpilot"
        / "worktrees"
        / "tasks"
        / "t"
        / ".workpilot"
        / "specs"
        / "t"
    )
    spec.mkdir(parents=True)
    assert project_root(spec) == (tmp_path / "p").resolve()


def test_spend_is_a_floor_when_a_session_has_no_price(tmp_path):
    root = _project(tmp_path, None, [_usage(1.5), _usage(0.0, tokens=500)])
    spent = task_spend(root, "001-task")
    assert spent.usd == 1.5 and spent.complete is False


def test_project_period_counts_this_month_only(tmp_path):
    old = NOW - timedelta(days=60)
    root = _project(
        tmp_path, None, [_usage(4.0, at=old), _usage(1.0, spec="002", at=NOW)]
    )
    assert project_spend(root, "monthly", NOW).usd == 1.0
    assert project_spend(root, "total", NOW).usd == 5.0


def test_week_starts_on_sunday_like_the_costs_page():
    start = period_start("weekly", datetime(2026, 11, 14, 12, tzinfo=UTC))  # a Saturday
    assert start is not None and start.weekday() == 6  # Sunday


# -- guard ------------------------------------------------------------------------


def test_task_limit_pauses_the_build_with_its_reason(tmp_path, capsys):
    root = _project(tmp_path, {"task_limit": 2.0}, [_usage(2.5)])
    spec = _spec(root)
    assert check_before_session(spec, "coding") == "budget"
    state = read_pause_state(spec)
    assert state["enabled"] is True and state["reason"] == "budget"
    assert state["budget"]["scope"] == "task"
    assert state["budget"]["limitUsd"] == 2.0
    assert "BUDGET REACHED" in capsys.readouterr().out


def test_a_raised_task_budget_lets_it_go_on(tmp_path):
    root = _project(tmp_path, {"task_limit": 2.0}, [_usage(2.5)])
    spec = _spec(root)
    (spec / "task_metadata.json").write_text(
        json.dumps({"budgetUsd": 5}), encoding="utf-8"
    )
    assert check_before_session(spec, "coding") is None


def test_warn_mode_never_pauses(tmp_path):
    root = _project(tmp_path, {"limit": 1.0, "on_exceed": "warn"}, [_usage(3.0)])
    assert check_before_session(_spec(root), "coding") is None
    assert not is_paused(_spec(root))


def test_each_threshold_is_announced_once(tmp_path, capsys):
    root = _project(tmp_path, {"task_limit": 10.0, "on_exceed": "warn"}, [_usage(8.0)])
    spec = _spec(root)
    check_before_session(spec, "coding")
    check_before_session(spec, "coding")
    out = capsys.readouterr().out
    assert out.count("Budget warning") == 1


def test_worktree_build_pauses_the_main_copy_too(tmp_path):
    root = _project(tmp_path, {"task_limit": 1.0}, [_usage(2.0)])
    wt_spec = (
        root
        / ".workpilot"
        / "worktrees"
        / "tasks"
        / "001-task"
        / ".workpilot"
        / "specs"
        / "001-task"
    )
    wt_spec.mkdir(parents=True)
    assert check_before_session(wt_spec, "qa_review") == "budget"
    assert is_paused(wt_spec) and is_paused(_spec(root))
    assert read_pause_state(_spec(root))["paused_phase"] == "qa_review"


def test_stall_breaker_pauses_a_task_that_stops_completing_subtasks(tmp_path):
    root = _project(tmp_path, {"limit": 1000.0}, [_usage(1.0)])
    spec = _spec(root)
    _plan(spec, ["completed", "pending", "pending"])
    assert check_before_session(spec, "coding") is None  # first mark
    ledger = root / ".workpilot" / "cost_data.json"
    data = json.loads(ledger.read_text(encoding="utf-8"))
    data["usages"] += [_usage(1.0), _usage(1.0), _usage(1.5)]
    ledger.write_text(json.dumps(data), encoding="utf-8")
    assert check_before_session(spec, "coding") == "budget_stall"
    assert read_pause_state(spec)["budget"]["completedSubtasks"] == 1
    # The resume starts a fresh allowance.
    assert check_before_session(spec, "coding") is None


def test_progress_resets_the_stall_mark(tmp_path):
    root = _project(tmp_path, {"limit": 1000.0}, [_usage(1.0)])
    spec = _spec(root)
    _plan(spec, ["completed", "pending", "pending"])
    check_before_session(spec, "coding")
    ledger = root / ".workpilot" / "cost_data.json"
    data = json.loads(ledger.read_text(encoding="utf-8"))
    data["usages"] += [_usage(5.0)]
    ledger.write_text(json.dumps(data), encoding="utf-8")
    _plan(spec, ["completed", "completed", "pending"])
    assert check_before_session(spec, "coding") is None


# -- degradation ----------------------------------------------------------------------


@pytest.mark.parametrize(("spent", "steps"), [(1.0, 0), (7.6, 1), (9.5, 2)])
def test_degrade_steps_follow_the_thresholds(tmp_path, spent, steps):
    root = _project(tmp_path, {"task_limit": 10.0, "degrade": True}, [_usage(spent)])
    assert degrade_steps(_spec(root)) == steps


def test_degrade_off_never_steps(tmp_path):
    root = _project(tmp_path, {"task_limit": 10.0}, [_usage(9.5)])
    assert degrade_steps(_spec(root)) == 0


def test_step_down_stays_with_the_provider_and_takes_the_newest():
    assert step_down("claude-opus-5-5", 1) == newest("anthropic", "standard")
    assert step_down("claude-opus-5-5", 2) == newest("anthropic", "fast")
    assert step_down("claude-sonnet-5-5", 1) == newest("anthropic", "fast")
    assert step_down("gpt-5.5", 1) == newest("openai", "standard")
    assert step_down("not-a-known-model", 2) is None
    assert step_down("qwen3-coder:30b", 2) is None  # local: nothing to save


def test_step_down_never_goes_up():
    fast = newest("anthropic", "fast")
    assert fast and step_down(fast, 1) is None


def test_phase_model_steps_down_when_the_budget_says_so(tmp_path, monkeypatch):
    import phase_config

    root = _project(tmp_path, {"task_limit": 10.0, "degrade": True}, [_usage(9.5)])
    monkeypatch.setattr(
        phase_config, "_resolve_phase_model", lambda *a, **k: "claude-opus-5-5"
    )
    assert phase_config.get_phase_model(_spec(root), "coding") == newest(
        "anthropic", "fast"
    )


def _rewrite(root: Path, tokens: int, mtime_ns: int) -> None:
    ledger = root / ".workpilot" / "cost_data.json"
    ledger.write_text(
        json.dumps({"usages": [_usage(1.0, tokens=tokens)], "budgets": {}}),
        encoding="utf-8",
    )
    os.utime(ledger, ns=(mtime_ns, mtime_ns))


def test_a_same_size_rewrite_in_one_clock_tick_is_read_again(tmp_path):
    root = _project(tmp_path, None, [])
    now = time.time_ns()
    _rewrite(root, 300, now)
    assert [u.tokens for u in usages(root)] == [300]
    # Same size, same modification time: what a coarse clock gives.
    _rewrite(root, 500, now)
    assert [u.tokens for u in usages(root)] == [500]


def test_a_ledger_written_long_ago_is_read_once(tmp_path):
    root = _project(tmp_path, None, [])
    long_ago = time.time_ns() - 3600 * 1_000_000_000
    _rewrite(root, 300, long_ago)
    assert [u.tokens for u in usages(root)] == [300]
    _rewrite(root, 500, long_ago)  # unchanged to the cache: the stamp is the same
    assert [u.tokens for u in usages(root)] == [300]
