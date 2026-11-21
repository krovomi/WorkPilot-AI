"""A Mission Control crew from the signals of the work, on the person's
providers, and a cheaper one when a budget asks for it.
"""

from __future__ import annotations

import pytest
from mission_control.composition import (
    STEPS,
    CompositionError,
    suggest_composition,
)
from mission_control.refine import Hints
from mission_control.signals import CompositionSignals
from mission_control.templates import TEMPLATES, template_for_kind
from models_registry import tier_pick
from tasks.classify import TaskKind


def _signals(**fields) -> CompositionSignals:
    base = {"words": 20, "kind": "feature", "kind_confident": True}
    return CompositionSignals(**{**base, **fields})


def _roles(result, part="full") -> list[str]:
    return [a["role"] for a in result[part]["agents"]]


def _keys(result, part="full") -> list[str]:
    return [a["key"] for a in result[part]["agents"]]


class TestTemplates:
    def test_each_kind_has_a_template(self):
        assert template_for_kind(TaskKind.HOTFIX).key == "incident_response"
        assert template_for_kind(TaskKind.UPGRADE).key == "refactor_module"
        assert template_for_kind(TaskKind.DOCS).key == "generic"
        assert set(TEMPLATES) == {
            "bug_fix",
            "new_feature",
            "refactor_module",
            "incident_response",
            "generic",
        }

    def test_the_chosen_template_wins(self):
        result = suggest_composition(
            _signals(),
            ["anthropic"],
            template_key="bug_fix",
            hints=Hints("new_feature"),
        )
        assert (result["template"], result["template_source"]) == ("bug_fix", "chosen")
        assert _roles(result) == ["debugger", "coder"]

    def test_the_model_names_it_when_the_person_did_not(self):
        result = suggest_composition(
            _signals(), ["anthropic"], hints=Hints("refactor_module")
        )
        assert (result["template"], result["template_source"], result["hinted"]) == (
            "refactor_module",
            "model",
            True,
        )

    def test_a_vague_description_gets_the_generic_crew_and_a_warning(self):
        result = suggest_composition(_signals(words=1), ["anthropic"])
        assert (result["template"], result["template_source"]) == (
            "generic",
            "fallback",
        )
        assert {"code": "vague_input", "params": {}} in result["warnings"]

    def test_otherwise_the_kind_of_the_work_decides(self):
        result = suggest_composition(_signals(kind="hotfix"), ["anthropic"])
        assert (result["template"], result["template_source"]) == (
            "incident_response",
            "kind",
        )
        assert _roles(result) == ["debugger", "coder", "reviewer", "documenter"]


class TestCrew:
    def test_coders_follow_the_size_and_the_tester_the_test_suite(self):
        small = suggest_composition(_signals(), ["anthropic"])
        assert _roles(small) == ["architect", "coder", "reviewer"]
        large = suggest_composition(_signals(spec_tokens=9_000), ["anthropic"])
        assert _keys(large) == [
            "architect-1",
            "coder-1",
            "coder-2",
            "coder-3",
            "reviewer-1",
            "tester-1",
        ]
        tested = suggest_composition(_signals(has_test_suite=True), ["anthropic"])
        assert "tester" in _roles(tested)
        hinted = suggest_composition(
            _signals(),
            ["anthropic"],
            hints=Hints(needs_tests=True, complexity="medium"),
        )
        assert _roles(hinted).count("coder") == 2 and "tester" in _roles(hinted)

    def test_docs_add_a_documenter_and_three_domains_an_architect(self):
        result = suggest_composition(
            _signals(kind="bug_fix", domains=["frontend", "backend"]),
            ["anthropic"],
            hints=Hints(domains=("docs",)),
        )
        assert result["signals"]["domains"] == ["backend", "docs", "frontend"]
        assert _roles(result) == ["architect", "debugger", "coder", "documenter"]
        assert result["full"]["agents"][0]["tier"] == "standard"

    def test_roles_go_to_the_first_provider_that_serves_their_tier(self):
        result = suggest_composition(
            _signals(), ["deepseek", "openai", "Claude", "anthropic"]
        )
        tiers = {
            a["role"]: (a["provider"], a["tier"]) for a in result["full"]["agents"]
        }
        assert tiers["architect"] == ("deepseek", "flagship")
        assert tiers["coder"] == ("deepseek", "standard")

    def test_a_provider_that_cannot_drive_an_agent_is_skipped_with_a_warning(self):
        result = suggest_composition(_signals(), ["meta", "ollama"])
        assert {
            "code": "provider_unsupported",
            "params": {"provider": "meta"},
        } in result["warnings"]
        assert {a["provider"] for a in result["full"]["agents"]} == {"ollama"}
        assert result["full"]["cost_usd"] == 0.0

    def test_no_usable_provider_is_an_error(self):
        with pytest.raises(CompositionError) as raised:
            suggest_composition(_signals(), ["meta", "custom"])
        assert raised.value.code == "no_provider"

    def test_a_model_without_tool_use_never_gets_a_role_that_needs_tools(
        self, model_cache
    ):
        fast = tier_pick("anthropic", "fast").model_id
        model_cache({"anthropic": [{"id": fast, "tool_call": False}]})
        result = suggest_composition(
            _signals(kind="hotfix", has_test_suite=True),
            ["anthropic", "openai"],
            template_key="bug_fix",
        )
        tester = next(a for a in result["full"]["agents"] if a["role"] == "tester")
        assert tester["provider"] == "openai"

    def test_a_role_no_provider_can_serve_is_left_out_and_said(self, model_cache):
        records = [
            {"id": tier_pick("anthropic", t).model_id, "tool_call": False}
            for t in ("fast", "standard", "flagship")
        ]
        model_cache({"anthropic": records})
        result = suggest_composition(
            _signals(), ["anthropic"], template_key="incident_response"
        )
        assert _roles(result) == ["documenter"]
        codes = [w["params"].get("role") for w in result["warnings"]]
        assert codes == ["debugger", "coder", "reviewer"]
        with pytest.raises(CompositionError) as raised:
            suggest_composition(_signals(), ["anthropic"], template_key="bug_fix")
        assert raised.value.code == "no_capable_model"

    def test_unpriced_models_are_said_and_counted(self):
        result = suggest_composition(_signals(), ["pi"])
        assert {"code": "unpriced_models", "params": {}} in result["warnings"]
        assert result["full"]["unpriced"] == len(result["full"]["agents"])

    def test_unusable_hints_are_said(self):
        result = suggest_composition(_signals(), ["anthropic"], hints_unusable=True)
        assert {"code": "hints_unusable", "params": {}} in result["warnings"]

    def test_a_refinement_request_names_the_first_usable_provider(self):
        result = suggest_composition(
            _signals(), ["meta", "google"], refine_text="Add a login page"
        )
        assert result["refinement"]["provider"] == "google"
        assert suggest_composition(_signals(), ["google"])["refinement"] is None


class TestBudget:
    SIGNALS = {"spec_tokens": 9_000, "domains": ["backend"]}

    def _suggest(self, providers=("anthropic", "google"), **budget):
        return suggest_composition(_signals(**self.SIGNALS), list(providers), **budget)

    def test_a_crew_within_budget_is_left_alone(self):
        result = self._suggest(budget_usd=1_000)
        assert (result["status"], result["steps"], result["changes"]) == ("ok", [], [])
        assert result["proposed"] == result["full"] and result["delta_usd"] == 0

    def test_non_critical_roles_step_down_first(self):
        full = self._suggest()["full"]["cost_usd"]
        result = self._suggest(budget_usd=full * 0.6)
        assert result["status"] == "degraded"
        assert result["steps"] == ["non_critical_fast"]
        moved = {c["role"] for c in result["changes"]}
        assert "reviewer" not in moved and "coder" in moved
        assert all(c["to"]["tier"] == "fast" for c in result["changes"])
        assert result["delta_usd"] > 0 and result["proposed"]["quality"] < 1

    def test_the_ladder_goes_as_far_as_the_budget_needs(self):
        cheapest = self._suggest(budget_usd=0.0001)["minimum"]["cost_usd"]
        result = self._suggest(budget_usd=cheapest * 1.01)
        assert result["status"] == "degraded" and result["steps"] == list(STEPS)
        kinds = {c["kind"] for c in result["changes"]}
        assert kinds == {"dropped", "model"}
        assert {a["role"] for a in result["proposed"]["agents"]} == {
            "architect",
            "coder",
            "reviewer",
        }

    def test_a_budget_too_low_is_refused_with_the_minimum(self):
        result = self._suggest(budget_usd=0.0001)
        assert result["status"] == "refused" and result["proposed"] is None
        assert result["minimum"]["cost_usd"] > 0.0001
        assert "delta_usd" not in result

    def test_a_token_budget_drops_agents_rather_than_models(self):
        full = self._suggest(providers=("anthropic",))["full"]["tokens"]
        result = self._suggest(providers=("anthropic",), budget_tokens=int(full * 0.8))
        assert result["status"] == "degraded"
        assert result["steps"][-1] in ("single_coder", "drop_optional")
        assert result["delta_tokens"] > 0
        refused = self._suggest(providers=("anthropic",), budget_tokens=10)
        assert refused["status"] == "refused" and refused["minimum"]["tokens"] > 10

    def test_a_crew_with_one_coder_keeps_it(self):
        result = suggest_composition(
            _signals(), ["ollama"], template_key="generic", budget_tokens=10
        )
        assert result["status"] == "refused"
        assert [a["role"] for a in result["minimum"]["agents"]] == ["coder", "reviewer"]
