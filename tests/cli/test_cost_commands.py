"""`--cost-*`: the report, the comparison, the budget and the prediction."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from cli import cost_commands as cc
from scheduling.cost_estimator import CostEstimator


def _data(project):
    return project / ".workpilot" / "cost_data.json"


def _record(project, *usages, budget=None):
    estimator = CostEstimator()
    estimator.load_from_file(_data(project))
    for usage in usages:
        estimator.record_usage(str(project), **usage)
    if budget:
        estimator.set_budget(str(project), budget[0], period=budget[1])
    estimator.save_to_file(_data(project))


def _age(project, days):
    """Move every recorded usage `days` into the past."""
    path = _data(project)
    data = json.loads(path.read_text(encoding="utf-8"))
    when = (datetime.now(UTC) - timedelta(days=days)).isoformat()
    for usage in data["usages"]:
        usage["timestamp"] = when
    path.write_text(json.dumps(data), encoding="utf-8")


CODER = {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "input_tokens": 120_000,
    "output_tokens": 4_000,
    "agent_type": "coder",
    "phase": "coding",
    "spec_id": "001-login",
}
PLANNER = {
    **CODER,
    "input_tokens": 10_000,
    "agent_type": "planner",
    "phase": "planning",
}


def test_report_without_data(tmp_path, capsys):
    cc.handle_cost_report_command(tmp_path)
    assert capsys.readouterr().out == "No cost data recorded yet.\n"


def test_report_breaks_the_spend_down(tmp_path, capsys):
    _record(tmp_path, CODER, PLANNER, budget=(50.0, "monthly"))

    cc.handle_cost_report_command(tmp_path)

    out = capsys.readouterr().out
    assert "Cost Report (monthly)" in out
    assert "Total tokens: 130,000 in / 8,000 out" in out
    assert "Usage records: 2" in out
    by_agent = out.split("By Agent Type:")[1].split("By Phase:")[0]
    assert by_agent.index("coder") < by_agent.index("planner")
    assert "001-login" in out
    assert "anthropic/claude-sonnet-4-6" in out
    assert "Budget (monthly):" in out and "Limit: $50.00" in out


def test_the_weekly_report_leaves_out_older_usage(tmp_path, capsys):
    _record(tmp_path, CODER)
    _age(tmp_path, 10)

    cc.handle_cost_report_command(tmp_path, period="weekly")
    assert capsys.readouterr().out == "No cost data recorded yet.\n"

    cc.handle_cost_report_command(tmp_path, period="monthly")
    assert "Usage records: 1" in capsys.readouterr().out


def test_compare_prints_the_competitor_table(tmp_path, capsys):
    _record(tmp_path, CODER)
    spent = CostEstimator()
    spent.load_from_file(_data(tmp_path))
    monthly = spent.get_monthly_report(str(tmp_path))["total_cost"]

    cc.handle_cost_compare_command(tmp_path)

    out = capsys.readouterr().out
    assert monthly > 0
    assert f"WorkPilot monthly spend: ${monthly:.2f}" in out
    assert "Cursor Pro" in out


def test_budget_is_set_then_shown(tmp_path, capsys):
    cc.handle_cost_budget_command(tmp_path)
    assert "No budget set" in capsys.readouterr().out

    cc.handle_cost_budget_command(tmp_path, limit=20.0, period="weekly")
    assert capsys.readouterr().out == "Budget set: $20.00 (weekly)\n"
    stored = json.loads(_data(tmp_path).read_text(encoding="utf-8"))
    assert stored["budgets"][str(tmp_path)]["period"] == "weekly"

    _record(tmp_path, CODER)
    cc.handle_cost_budget_command(tmp_path)
    out = capsys.readouterr().out
    assert "Budget: $20.00 (weekly)" in out
    assert "Spent:  $0.0000" not in out


def test_a_monthly_budget_counts_only_this_month(tmp_path, capsys):
    """Spend from before the budget's period is not this period's spend:
    the view used to add up every usage ever recorded."""
    _record(tmp_path, CODER)
    _age(tmp_path, 40)
    _record(tmp_path, budget=(10.0, "monthly"))

    cc.handle_cost_budget_command(tmp_path)

    out = capsys.readouterr().out
    assert "Spent:  $0.0000 (0.0%)" in out
    assert "Remaining: $10.0000" in out


def test_predict_for_a_missing_spec(tmp_path, capsys):
    cc.handle_cost_predict_command(tmp_path, "404-none")
    assert "Spec not found" in capsys.readouterr().out


@pytest.mark.parametrize("compare", [True, False])
def test_predict_prints_the_selected_model_and_the_alternatives(
    tmp_path, capsys, compare
):
    spec = tmp_path / ".workpilot" / "specs" / "001-login"
    spec.mkdir(parents=True)
    (spec / "implementation_plan.json").write_text(
        json.dumps(
            {
                "phases": [
                    {
                        "subtasks": [
                            {"id": "1", "description": "form", "files_to_modify": []},
                            {"id": "2", "description": "api", "files_to_modify": []},
                        ]
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    cc.handle_cost_predict_command(
        tmp_path, "001-login", model="claude-sonnet-4-6", compare=compare
    )

    out = capsys.readouterr().out
    assert "Cost Prediction — 001-login" in out
    assert "Selected model: anthropic/claude-sonnet-4-6" in out
    assert ("Alternatives:" in out) is compare
    if compare:
        assert "ollama/llama-3.3-70b" in out
