"""Lot 8: recorded sessions, replayed through the production code on every PR.

Each scenario under ``replay/`` is a session as a model drove it. The replay
runs everything WorkPilot does between two of its answers
(``harness.application.replay``: system prompt, task block, tools, cuts,
no-progress rule, clearing) and measures the requests under each cache shape
of ``replay/profiles.json``. No model, no network, no clock.

Two kinds of checks:

* **invariants**, true of every scenario whatever its baseline: no tool result
  over its cap, no prefix rewrite outside a clearing, no hit ratio where the
  provider reports no cache, the stop at the fifth identical turn;
* **the baseline** (``replay/<id>.baseline.json``): no number may get worse.
  To accept better numbers, or a change of behaviour, refresh the baselines on
  purpose and commit them with the change:

      WORKPILOT_REFRESH_REPLAY_BASELINES=1 pytest tests/harness/test_replay_evals.py

  The refresh is refused in CI: a baseline changes in a commit someone reviews.

The last tests break the production code on purpose, one indicator each, and
check that the evals see it.
"""

from __future__ import annotations

import itertools
import os
from dataclasses import replace
from pathlib import Path

import pytest
from agents.coder import _coding_task_segments
from harness.application.replay import (
    Replay,
    TaskSegments,
    load_profiles,
    load_scenario,
    materialize,
    read_baseline,
    replay,
    write_baseline,
)
from harness.domain.evals import CacheShape, regressions
from harness.domain.progress import REPEATS_BEFORE_NUDGE, REPEATS_BEFORE_STOP

REPLAY = Path(__file__).parent / "replay"
REFRESH_ENV = "WORKPILOT_REFRESH_REPLAY_BASELINES"
PROFILES = load_profiles(REPLAY / "profiles.json")
SCENARIOS = sorted(
    path
    for path in REPLAY.glob("*.json")
    if path.name != "profiles.json" and not path.name.endswith(".baseline.json")
)
IDS = [path.stem for path in SCENARIOS]


def _baseline(scenario_id: str) -> Path:
    return REPLAY / f"{scenario_id}.baseline.json"


def _pin(monkeypatch: pytest.MonkeyPatch) -> None:
    """Leave out of the prompt what differs from one machine to the next.

    rtk and the shared brain add a paragraph and tools where they are
    installed; a user's caps change every size. Through their own switches,
    so the code under test is the code that runs.
    """
    monkeypatch.setenv("RTK_DISABLED", "1")
    monkeypatch.setenv("BRAIN_ENABLED", "0")
    for name in ("LLM_TOOL_RESULT_MAX_CHARS", "LLM_HISTORY_CHAR_BUDGET"):
        monkeypatch.delenv(name, raising=False)


def _replay(
    scenario_id: str, root: Path, task_segments: TaskSegments = _coding_task_segments
) -> Replay:
    scenario = load_scenario(REPLAY / f"{scenario_id}.json")
    project, spec = materialize(scenario, root)
    return replay(
        scenario, project, spec, task_segments=task_segments, profiles=PROFILES
    )


@pytest.fixture(scope="module")
def replays(tmp_path_factory) -> dict[str, Replay]:
    with pytest.MonkeyPatch.context() as monkeypatch:
        _pin(monkeypatch)
        return {
            scenario_id: _replay(scenario_id, tmp_path_factory.mktemp(scenario_id))
            for scenario_id in IDS
        }


# -- the corpus ---------------------------------------------------------------


def test_the_corpus_has_its_scenarios_and_every_cache_shape():
    assert IDS, f"no scenario under {REPLAY}"
    assert {profile.cache.shape for profile in PROFILES.values()} == set(CacheShape)


@pytest.mark.parametrize("path", SCENARIOS, ids=IDS)
def test_every_scenario_parses_says_why_and_has_a_baseline(path):
    scenario = load_scenario(path)
    assert len(scenario.why) > 60, f"{path.name}: say what this scenario guards"
    assert _baseline(scenario.id).is_file(), (
        f"{path.name} has no baseline: {REFRESH_ENV}=1 pytest {Path(__file__).name}"
    )


def test_every_baseline_has_its_scenario():
    stems = {
        path.name.removesuffix(".baseline.json")
        for path in REPLAY.glob("*.baseline.json")
    }
    assert stems <= set(IDS), (
        f"baselines without a scenario: {sorted(stems - set(IDS))}"
    )


# -- the baseline -------------------------------------------------------------


@pytest.mark.parametrize("scenario_id", IDS)
def test_the_replay_holds_its_baseline(replays, scenario_id):
    metrics = replays[scenario_id].metrics
    if os.environ.get(REFRESH_ENV) == "1":
        if os.environ.get("CI"):
            pytest.fail(
                f"{REFRESH_ENV} is refused in CI: a baseline changes in a commit "
                "someone reviews, never by itself"
            )
        write_baseline(_baseline(scenario_id), scenario_id, metrics)
    found = regressions(metrics, read_baseline(_baseline(scenario_id)))
    assert not found, (
        f"{scenario_id} got worse than its baseline:\n  "
        + "\n  ".join(found)
        + f"\nIf the change is intended, refresh on purpose: {REFRESH_ENV}=1 "
        f"pytest {Path(__file__).name}, and commit the baseline with it."
    )


# -- invariants ---------------------------------------------------------------


@pytest.mark.parametrize("scenario_id", IDS)
def test_no_tool_result_is_cut_after_the_fact(replays, scenario_id):
    """Truncation at source: a tool returns a page under the client's cap."""
    result = replays[scenario_id]
    assert result.largest_tool_result <= result.tool_result_cap


@pytest.mark.parametrize("scenario_id", IDS)
def test_no_prefix_is_rewritten_outside_a_clearing(replays, scenario_id):
    """The exit criterion of lot 2, on every shape that reports a cache."""
    metrics = replays[scenario_id].metrics
    assert metrics["prefix_breaks"] == 0
    for name in PROFILES:
        assert metrics["profiles"][name]["prefix_rewrites_outside_clearing"] == 0


@pytest.mark.parametrize("scenario_id", IDS)
def test_a_provider_that_reports_no_cache_has_no_hit_ratio(replays, scenario_id):
    for name, profile in PROFILES.items():
        ratio = replays[scenario_id].metrics["profiles"][name]["cache_hit_ratio"]
        if profile.cache.shape is CacheShape.NONE:
            assert ratio is None, f"{name}: unknown, never {ratio!r}"
        else:
            assert ratio is not None and 0 < ratio <= 1


def test_two_subtasks_send_the_task_block_identically(replays):
    assert replays["coding-subtask-reads"].metrics["task_prefix_share"] == 1.0


def test_a_long_output_spills_and_its_hidden_part_is_read_back(replays):
    result = replays["long-command-spills"]
    assert result.metrics["spilled_outputs"] == 1
    (_, _, excerpt), (tool, arguments, page) = result.tool_calls[:2]
    warning = "tier table 'bulk' is a legacy export"
    assert warning not in excerpt
    assert tool == "read_file" and "/tool-output/" in arguments["path"]
    assert warning in page


def test_the_session_past_the_budget_clears_once(replays):
    """In one batch: one rewrite where a cache is reported, then none."""
    metrics = replays["past-clearing-budget"].metrics
    assert metrics["clearings"] == 1
    for name, profile in PROFILES.items():
        expected = 0 if profile.cache.shape is CacheShape.NONE else 1
        assert metrics["profiles"][name]["prefix_rewrites"] == expected


def test_the_session_plans_for_the_payable_window(replays):
    result = replays["past-clearing-budget"]
    assert result.metrics["payable_window_tokens"] < result.announced_window
    assert result.metrics["peak_window_share"] < 1


def test_the_looping_model_is_stopped_at_the_fifth_identical_turn(replays):
    metrics = replays["looping-model"].metrics
    assert metrics["nudged_at_turn"] == REPEATS_BEFORE_NUDGE
    assert metrics["stopped_at_turn"] == REPEATS_BEFORE_STOP
    assert metrics["calls"] == REPEATS_BEFORE_STOP


# -- the evals see a regression -----------------------------------------------


def _found(scenario_id: str, result: Replay) -> list[str]:
    return regressions(result.metrics, read_baseline(_baseline(scenario_id)))


def test_a_volatile_line_in_the_task_block_is_caught(tmp_path, monkeypatch):
    """A per-subtask value in a segment that claims to be stable: every request
    still succeeds, and the second subtask pays for the task block again."""
    _pin(monkeypatch)
    runs = itertools.count(1)

    def volatile(project_dir, spec_dir, effort):
        first, *rest = _coding_task_segments(project_dir, spec_dir, effort)
        return [replace(first, text=f"Run {next(runs)}\n\n{first.text}"), *rest]

    found = _found(
        "coding-subtask-reads",
        _replay("coding-subtask-reads", tmp_path, task_segments=volatile),
    )
    assert any(line.startswith("task_prefix_share") for line in found), found


def test_clearing_a_little_every_turn_is_caught(tmp_path, monkeypatch):
    """Before lot 4: past the budget, one old result per turn, a rewrite each time."""
    _pin(monkeypatch)
    import core.llm_optimization as llm_optimization
    from harness.domain.policies import ClearingPolicy

    class EveryTurn(ClearingPolicy):
        @classmethod
        def for_budget(cls, budget_chars, *, keep_recent=8):
            return ClearingPolicy(budget_chars, budget_chars, keep_recent)

    monkeypatch.setattr(llm_optimization, "ClearingPolicy", EveryTurn)
    found = _found("past-clearing-budget", _replay("past-clearing-budget", tmp_path))
    assert any(line.startswith("clearings") for line in found), found
    assert any(line.startswith("prefix_rewrites [token_prefix]") for line in found)
    assert any(line.startswith("prefix_rewrites [blocks]") for line in found)


def test_planning_for_the_announced_window_is_caught(tmp_path, monkeypatch):
    _pin(monkeypatch)
    import context_mgmt.windows as windows

    monkeypatch.setattr(windows, "effective_window", lambda _model, window: window)
    found = _found("past-clearing-budget", _replay("past-clearing-budget", tmp_path))
    assert any(line.startswith("payable_window_tokens") for line in found), found


def test_a_tool_that_returns_more_than_the_cap_is_caught(tmp_path, monkeypatch):
    """Pages larger than the cap: the client cuts them after the fact again."""
    _pin(monkeypatch)
    from core.runtimes.tool_executor import ToolExecutor

    monkeypatch.setattr(ToolExecutor, "_page_chars", lambda _self: 20_000)
    result = _replay("coding-subtask-reads", tmp_path)
    assert result.largest_tool_result > result.tool_result_cap
