"""Carbon profiler (#365): estimates, ledger, report advice, budget, degraded mode, ESG export."""

from __future__ import annotations

import csv
import io
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

from carbon_profiler import (  # noqa: E402
    budget,
    config,
    export,
    factors,
    ledger,
    report,
)

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=UTC)


def entry(**overrides):
    base = {
        "source": "llm_cloud",
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        "tokens_in": 10_000,
        "tokens_out": 1_000,
        "cache_read": 0,
        "timestamp": "2026-11-05T10:00:00Z",
        "task": "001-shop",
        "phase": "coding",
        "agent": "coder",
    }
    base.update(overrides)
    return base


def write_ledger(root: Path, entries: list[dict]) -> None:
    (root / ".workpilot").mkdir(exist_ok=True)
    (root / ".workpilot" / "carbon-ledger.json").write_text(
        json.dumps(entries), encoding="utf-8"
    )


def write_config(root: Path, data: dict) -> None:
    (root / ".workpilot").mkdir(exist_ok=True)
    (root / ".workpilot" / "carbon.json").write_text(json.dumps(data), encoding="utf-8")


# ── factors ────────────────────────────────────────────────────────────────


def test_tier_comes_from_the_registry_then_the_name():
    assert factors.model_tier("anthropic", "claude-opus-4-8") == "large"
    assert factors.model_tier("anthropic", "claude-sonnet-4-6") == "medium"
    assert factors.model_tier("google", "gemini-2.0-flash-exp") == "small"
    assert factors.model_tier("ollama", "llama3.1:70b") == "large"
    assert factors.model_tier("ollama", "qwen2.5-coder:7b") == "small"
    # "mini" inside "gemini" is not a small model.
    assert factors.model_tier("google", "gemini-ultra-x") == "large"


def test_a_cloud_call_counts_output_most_and_cache_reads_least():
    plain = factors.estimate(
        "anthropic", "claude-sonnet-4-6", tokens_in=0, tokens_out=1000
    )
    # 1,000 output tokens of a medium model: 0.6 Wh × PUE 1.12, on the US grid.
    assert plain.kwh == pytest.approx(0.6 * 1.12 / 1000)
    assert plain.co2_g == pytest.approx(plain.kwh * factors.GRID_INTENSITY["us"])
    fresh = factors.estimate(
        "anthropic", "claude-sonnet-4-6", tokens_in=10_000, tokens_out=0
    )
    cached = factors.estimate(
        "anthropic",
        "claude-sonnet-4-6",
        tokens_in=10_000,
        tokens_out=0,
        cache_read=10_000,
    )
    assert fresh.kwh == pytest.approx(plain.kwh)  # 10k fresh input ≈ 1k output
    assert cached.kwh == pytest.approx(plain.kwh * 0.2)
    assert plain.method == "tokens" and plain.host_known


def test_overrides_and_unknown_hosts():
    est = factors.estimate(
        "mistral",
        "mistral-large-2512",
        tokens_in=0,
        tokens_out=1000,
        overrides={
            "wh_per_1k_output.large": 2.0,
            "pue.mistral": 1.0,
            "region.mistral": "fr",
            "grid.fr": 32,
        },
    )
    assert est.kwh == pytest.approx(2.0 / 1000)
    assert est.co2_g == pytest.approx(2.0 / 1000 * 32)
    assert not est.host_known
    assert (
        factors.estimate("someone", "x", tokens_in=0, tokens_out=1000).region == "world"
    )


def test_a_local_model_uses_the_machine_power_and_grid():
    est = factors.estimate(
        "ollama",
        "llama3.1:8b",
        tokens_in=0,
        tokens_out=500,
        duration_s=36,
        region="fr",
        local_power_w=100,
    )
    assert est.method == "local-power"
    assert est.kwh == pytest.approx(100 * 36 / 3600 / 1000)
    assert est.co2_g == pytest.approx(est.kwh * factors.GRID_INTENSITY["fr"])
    no_time = factors.estimate(
        "ollama", "llama3.1:8b", tokens_in=0, tokens_out=1000, region="fr"
    )
    assert no_time.method == "local-tokens"
    assert no_time.kwh == pytest.approx(0.15 * 3 / 1000)


# ── config ─────────────────────────────────────────────────────────────────


def test_config_keeps_only_checked_values(tmp_path):
    cfg = config.from_dict(
        {
            "region": "mars",
            "monthly_budget_kg": -3,
            "alert_percent": 150,
            "degrade": "yes",
            "factors": {
                "grid.fr": 32,
                "pue.x": True,
                "evil": 1,
                "region.openai": "nordics",
                "region.y": "moon",
            },
        }
    )
    assert (cfg.region, cfg.monthly_budget_kg, cfg.alert_percent, cfg.degrade) == (
        "world",
        0.0,
        80,
        False,
    )
    assert cfg.factors == {"grid.fr": 32.0, "region.openai": "nordics"}
    saved = config.save(
        tmp_path,
        {"region": "fr", "monthlyBudgetKg": 5, "alertPercent": 70, "cpuOnly": True},
    )
    assert saved.power_w == factors.CPU_ONLY_POWER_W
    assert config.load(tmp_path).to_dict()["monthlyBudgetKg"] == 5


def test_config_never_follows_a_link(tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "carbon.json").write_text('{"region": "fr"}', encoding="utf-8")
    project = tmp_path / "project"
    (project / ".workpilot").mkdir(parents=True)
    (project / ".workpilot" / "carbon.json").symlink_to(elsewhere / "carbon.json")
    assert config.load(project).region == "world"
    with pytest.raises(ValueError):
        config.save(project, {"region": "fr"})


# ── ledger ─────────────────────────────────────────────────────────────────


def test_ledger_rows_are_checked_and_estimated(tmp_path):
    write_ledger(
        tmp_path,
        [
            entry(),
            entry(provider="ollama", source="llm_cloud", model="llama3.1:8b"),
            entry(
                tokens_in="lots",
                tokens_out=-5,
                cache_read=99_999,
                timestamp=1_762_300_000,
            ),
            {"source": "ci_cd", "duration_s": 300},
            "not a record",
        ],
    )
    rows = ledger.rows(ledger.raw_entries(tmp_path) or [], config.CarbonConfig())
    assert [r.source for r in rows] == ["llm_cloud", "llm_local", "llm_cloud"]
    odd = rows[2]
    assert (odd.tokens_in, odd.tokens_out, odd.cache_read) == (0, 0, 0)
    assert odd.at is not None and odd.at.tzinfo is not None
    assert rows[0].to_dict()["estimated"] is True


def test_ledger_refuses_a_link_and_a_non_array(tmp_path):
    assert ledger.raw_entries(tmp_path) is None
    (tmp_path / ".workpilot").mkdir()
    (tmp_path / ".workpilot" / "carbon-ledger.json").write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError):
        ledger.raw_entries(tmp_path)
    other = tmp_path / "other.json"
    other.write_text("[]", encoding="utf-8")
    (tmp_path / ".workpilot" / "carbon-ledger.json").unlink()
    (tmp_path / ".workpilot" / "carbon-ledger.json").symlink_to(other)
    assert ledger.raw_entries(tmp_path) is None


# ── report ─────────────────────────────────────────────────────────────────


def rows_of(entries, cfg=None):
    return ledger.rows(entries, cfg or config.CarbonConfig())


def test_report_breaks_down_by_phase_and_task_and_month():
    rows = rows_of(
        [
            entry(),
            entry(phase="qa_review", task="002-cart"),
            entry(timestamp="2026-10-02T09:00:00Z"),
        ]
    )
    month = report.build(rows, month="2026-11", now=NOW)
    assert month["recordCount"] == 2
    assert set(month["byPhase"]) == {"coding", "qa_review"}
    assert set(month["byTask"]) == {"001-shop", "002-cart"}
    assert [m["month"] for m in month["months"]] == ["2026-10", "2026-11"]
    assert month["carKm"] == pytest.approx(
        month["totalCo2G"] / report.CAR_G_PER_KM, abs=0.01
    )
    assert report.build(rows, now=NOW)["recordCount"] == 3


def test_advice_is_given_only_when_the_ledger_shows_it():
    assert report.advice(rows_of([entry()])) == []
    heavy_review = rows_of(
        [entry(phase="qa_review", model="claude-opus-4-8", tokens_in=300_000)]
    )
    codes = {a["code"] for a in report.advice(heavy_review)}
    assert codes == {"review_on_fast", "use_cache"}
    cached = rows_of([entry(tokens_in=300_000, cache_read=200_000)])
    assert report.advice(cached) == []
    region = rows_of([entry(provider="openai", model="gpt-5.4")])
    assert report.advice(region) == [
        {
            "code": "cleaner_region",
            "provider": "openai",
            "from": "us",
            "to": "nordics",
            "saving": 89,
        }
    ]
    mixed = rows_of(
        [entry(), entry(provider="ollama", model="llama3.1:8b", duration_s=20)]
    )
    assert [a["code"] for a in report.advice(mixed)] == ["local_vs_cloud"]


# ── budget ─────────────────────────────────────────────────────────────────


def test_budget_states():
    rows = rows_of([entry(tokens_out=100_000)])  # ~ 25 g
    used = sum(r.estimate.co2_g for r in rows)

    def state(kg, alert=80):
        cfg = config.CarbonConfig(monthly_budget_kg=kg, alert_percent=alert)
        return budget.status(rows, cfg, NOW)["state"]

    assert state(0) == "none"
    assert state(used / 1000 * 10) == "ok"
    assert state(used / 1000 / 0.9) == "warning"
    assert state(used / 1000 / 2) == "exceeded"
    # Another month's calls do not count.
    assert (
        budget.status(
            rows,
            config.CarbonConfig(monthly_budget_kg=0.001),
            datetime(2026, 12, 1, tzinfo=UTC),
        )["usedG"]
        == 0
    )


def test_each_threshold_is_announced_once_a_month(tmp_path):
    (tmp_path / ".workpilot").mkdir()
    warning = {"month": "2026-11", "state": "warning", "alertPercent": 80}
    exceeded = {**warning, "state": "exceeded"}
    assert budget.due_alerts(tmp_path, warning) == [80]
    assert budget.due_alerts(tmp_path, warning) == []
    assert budget.due_alerts(tmp_path, exceeded) == [100]
    assert budget.due_alerts(tmp_path, {**exceeded, "month": "2026-12"}) == [80, 100]
    assert budget.due_alerts(tmp_path, {**warning, "state": "ok"}) == []


def test_lighter_model_steps_a_flagship_down_within_its_provider():
    assert budget.lighter_model("claude-opus-4-8").startswith("claude-sonnet")
    assert budget.lighter_model("claude-opus-4-1").startswith(
        "claude-sonnet"
    )  # older id, by name
    assert budget.lighter_model("claude-sonnet-4-6") is None
    assert budget.lighter_model("claude-haiku-4-5") is None
    assert budget.lighter_model("llama3.1:8b") is None


def test_degraded_model_follows_the_project_budget(tmp_path):
    spec_dir = tmp_path / ".workpilot" / "specs" / "001-shop"
    spec_dir.mkdir(parents=True)
    write_ledger(
        tmp_path,
        [
            entry(
                model="claude-opus-4-8",
                tokens_out=50_000,
                timestamp=datetime.now(UTC).isoformat(),
            )
        ],
    )
    assert (
        budget.degraded_model(spec_dir, "claude-opus-4-8", "qa") == "claude-opus-4-8"
    )  # no budget
    write_config(tmp_path, {"monthly_budget_kg": 0.0001, "degrade": False})
    assert (
        budget.degraded_model(spec_dir, "claude-opus-4-8", "qa") == "claude-opus-4-8"
    )  # degrade off
    write_config(
        tmp_path, {"monthly_budget_kg": 0.0001, "degrade": True, "region": "fr"}
    )
    assert budget.degraded_model(spec_dir, "claude-opus-4-8", "qa").startswith(
        "claude-sonnet"
    )
    assert (
        budget.degraded_model(spec_dir, "claude-sonnet-4-6", "qa")
        == "claude-sonnet-4-6"
    )
    # A task worktree belongs to the main project.
    worktree_spec = (
        tmp_path
        / ".workpilot"
        / "worktrees"
        / "tasks"
        / "001-shop"
        / ".workpilot"
        / "specs"
        / "001-shop"
    )
    assert budget.project_root(worktree_spec) == tmp_path.resolve()


def test_phase_config_applies_the_degraded_mode(tmp_path, monkeypatch):
    import phase_config

    monkeypatch.setattr(
        phase_config, "_resolve_phase_model", lambda *a, **k: "claude-opus-4-8"
    )
    seen = {}

    def fake(spec_dir, model, phase, default_of):
        seen["args"] = (spec_dir, model, phase)
        seen["default"] = default_of("anthropic")
        return "claude-sonnet-4-6"

    monkeypatch.setattr(budget, "degraded_model", fake)
    assert phase_config.get_phase_model(tmp_path, "qa") == "claude-sonnet-4-6"
    assert seen["args"] == (tmp_path, "claude-opus-4-8", "qa")
    # The provider's own default model, never a flagship.
    assert seen["default"] == phase_config.resolve_model_id("sonnet")
    assert phase_config._provider_standard_model("nobody") is None


# ── export ─────────────────────────────────────────────────────────────────


def test_export_maps_cloud_to_scope3_and_local_to_scope2():
    cfg = config.CarbonConfig(region="fr")
    rows = rows_of(
        [
            entry(),
            entry(),
            entry(provider="ollama", model="llama3.1:8b", duration_s=60),
        ],
        cfg,
    )
    doc = export.document(rows, "2026-11", cfg, "shop")
    lines = {(line["scope"], line["provider"]): line for line in doc["lines"]}
    assert lines[("scope3_cat1", "anthropic")]["calls"] == 2
    assert lines[("scope2", "ollama")]["kwh"] == pytest.approx(150 * 60 / 3600 / 1000)
    assert doc["totals"]["co2Kg"] == pytest.approx(
        doc["frameworks"]["GRI 305-3"] + doc["totals"]["scope2LocationBasedKg"]
    )
    assert doc["frameworks"]["GRI 302-1"] == pytest.approx(
        lines[("scope2", "ollama")]["kwh"]
    )
    assert doc["estimated"] is True and doc["method"]["localRegion"] == "fr"

    table = list(csv.reader(io.StringIO(export.render(doc, "csv"))))
    assert table[0][:3] == ["period", "scope", "provider"] and len(table) == 3
    assert "ESRS E1-6 Scope 2" in export.render(doc, "md")
    assert json.loads(export.render(doc, "json"))["period"] == "2026-11"
    with pytest.raises(ValueError):
        export.render(doc, "xlsx")


# ── runner and ledger producer ─────────────────────────────────────────────


def run(root: Path, *args: str) -> tuple[int, dict | str]:
    proc = subprocess.run(
        [
            sys.executable,
            str(BACKEND / "runners" / "carbon_profiler_runner.py"),
            "--project-path",
            str(root),
            *args,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    for line in proc.stdout.splitlines():
        if line.startswith("CARBON_RESULT:"):
            return proc.returncode, json.loads(line.split(":", 1)[1])
        if line.startswith("CARBON_ERROR:"):
            return proc.returncode, line.split(":", 1)[1]
    return proc.returncode, proc.stderr


def test_runner_modes(tmp_path):
    write_ledger(tmp_path, [entry(timestamp=datetime.now(UTC).isoformat())])
    settings = tmp_path / "settings.json"
    settings.write_text(
        json.dumps({"region": "fr", "monthlyBudgetKg": 0.000001, "alertPercent": 50}),
        encoding="utf-8",
    )
    code, saved = run(tmp_path, "--save-config", str(settings))
    assert code == 0 and saved["region"] == "fr"

    code, result = run(tmp_path)
    assert code == 0 and result["hasLedger"] and result["budget"]["state"] == "exceeded"
    code, check = run(tmp_path, "--budget-check")
    assert check["alerts"] == [50, 100]
    code, check = run(tmp_path, "--budget-check")
    assert check["alerts"] == []

    month = datetime.now(UTC).strftime("%Y-%m")
    code, exported = run(tmp_path, "--export", month, "--format", "csv")
    assert code == 0 and exported["content"].startswith("period,scope")
    code, error = run(tmp_path, "--month", "2026-13")
    assert code == 1 and error == "Not a month (YYYY-MM)"


def test_usage_tracker_records_task_phase_agent_and_cache_reads(tmp_path):
    from core import usage_tracker

    usage_tracker._append_carbon_ledger(
        tmp_path,
        "anthropic",
        "claude-sonnet-4-6",
        100,
        50,
        10,
        400,
        "001-shop",
        "qa",
        "qa_reviewer",
    )
    record = json.loads(
        (tmp_path / ".workpilot" / "carbon-ledger.json").read_text(encoding="utf-8")
    )[0]
    assert record["tokens_in"] == 510 and record["cache_read"] == 400
    assert (record["task"], record["phase"], record["agent"]) == (
        "001-shop",
        "qa",
        "qa_reviewer",
    )


def test_degraded_model_sees_a_config_rewritten_in_the_same_clock_tick(tmp_path):
    """Windows can give two quick writes one mtime: the cache must still see the change."""
    spec_dir = tmp_path / ".workpilot" / "specs" / "001-shop"
    spec_dir.mkdir(parents=True)
    write_ledger(
        tmp_path,
        [
            entry(
                model="claude-opus-4-8",
                tokens_out=50_000,
                timestamp=datetime.now(UTC).isoformat(),
            )
        ],
    )
    write_config(tmp_path, {"monthly_budget_kg": 0.0001, "degrade": False})
    config = tmp_path / ".workpilot" / "carbon.json"
    stamp = config.stat().st_mtime_ns
    assert budget.degraded_model(spec_dir, "claude-opus-4-8", "qa") == "claude-opus-4-8"
    write_config(
        tmp_path, {"monthly_budget_kg": 0.0001, "degrade": True, "region": "fr"}
    )
    os.utime(config, ns=(stamp, stamp))
    assert budget.degraded_model(spec_dir, "claude-opus-4-8", "qa").startswith(
        "claude-sonnet"
    )
