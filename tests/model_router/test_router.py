"""Tests for the Adaptive Model Router."""

from __future__ import annotations

import pytest
from model_router import (
    ModelChoice,
    ModelRouter,
    QualityTier,
    RoutingPolicy,
    TaskClass,
    classify_task,
)


class TestClassifier:
    def test_explicit_hint_overrides_prompt(self) -> None:
        assert classify_task("anything", hint="review") == TaskClass.REVIEW

    def test_invalid_hint_falls_through(self) -> None:
        # "garbage" not a TaskClass value — fall back to keyword detection
        assert classify_task("rename foo to bar", hint="garbage") == TaskClass.TRIVIAL

    def test_keyword_trivial(self) -> None:
        assert classify_task("fix typo in README") == TaskClass.TRIVIAL

    def test_keyword_review(self) -> None:
        assert classify_task("Please review this PR") == TaskClass.REVIEW

    def test_keyword_planning(self) -> None:
        assert (
            classify_task("Decompose this feature into subtasks") == TaskClass.PLANNING
        )

    def test_keyword_architecture(self) -> None:
        assert classify_task("Design the new payment service") == TaskClass.ARCHITECTURE

    def test_long_prompt_promotes_to_multi_file(self) -> None:
        long_prompt = "x" * 9_000  # > 8_000 chars threshold
        assert classify_task(long_prompt) == TaskClass.MULTI_FILE

    def test_short_prompt_defaults_to_simple_edit(self) -> None:
        assert classify_task("add a getter for the name field") == TaskClass.SIMPLE_EDIT


class TestRouter:
    def test_trivial_task_picks_budget_tier(self) -> None:
        router = ModelRouter(available=["anthropic"])
        choice = router.route(prompt="fix typo", hint="trivial")
        assert choice.tier == QualityTier.BUDGET
        assert choice.task_class == TaskClass.TRIVIAL
        assert "haiku" in choice.model.lower()

    def test_architecture_task_picks_premium_tier(self) -> None:
        router = ModelRouter(available=["anthropic"])
        choice = router.route(prompt="design new auth system", hint="architecture")
        assert choice.tier == QualityTier.PREMIUM
        assert "opus" in choice.model.lower()

    def test_unavailable_provider_is_skipped(self) -> None:
        # User only has openai configured — should pick gpt-4o-mini, not Haiku.
        router = ModelRouter(available=["openai"])
        choice = router.route(prompt="trivial fix", hint="trivial")
        assert choice.provider == "openai"
        assert "mini" in choice.model.lower()

    def test_explicit_tier_overrides_default(self) -> None:
        router = ModelRouter(available=["anthropic"])
        # Trivial task, but caller forces PREMIUM
        choice = router.route(
            prompt="fix typo",
            hint="trivial",
            tier=QualityTier.PREMIUM,
        )
        assert choice.tier == QualityTier.PREMIUM
        assert "opus" in choice.model.lower()

    def test_estimates_cost_from_prompt_size(self) -> None:
        router = ModelRouter(available=["anthropic"])
        cheap_choice = router.route(prompt="x", hint="simple_edit")
        long_prompt = "y" * 40_000
        expensive_choice = router.route(prompt=long_prompt, hint="simple_edit")
        # Same model bucket but bigger prompt = bigger cost.
        assert expensive_choice.estimated_cost_usd > cheap_choice.estimated_cost_usd

    def test_compare_returns_one_choice_per_tier(self) -> None:
        router = ModelRouter(available=["anthropic"])
        comparison = router.compare(prompt="rename foo", hint="trivial")
        assert set(comparison.keys()) == {"budget", "balanced", "premium"}
        assert all(isinstance(c, ModelChoice) for c in comparison.values())
        # Premium should cost more than budget for the same prompt.
        assert (
            comparison["premium"].estimated_cost_usd
            >= comparison["budget"].estimated_cost_usd
        )

    def test_no_available_provider_falls_back(self) -> None:
        # User has nothing configured — router should still return something.
        router = ModelRouter(available=["nonexistent-provider"])
        choice = router.route(prompt="fix typo", hint="trivial")
        assert choice is not None
        assert "fallback" in choice.reason.lower()

    def test_local_provider_with_no_pricing_is_allowed(self) -> None:
        # Ollama has no pricing data in the catalog (energy cost = 0).
        router = ModelRouter(available=["ollama"])
        choice = router.route(prompt="trivial", hint="trivial")
        assert choice.provider == "ollama"
        assert choice.estimated_cost_usd == 0.0


class TestPolicy:
    def test_default_policy_covers_all_task_classes(self) -> None:
        policy = RoutingPolicy.default()
        for tc in TaskClass:
            for tier in QualityTier:
                assert policy.chain_for(tier, tc), f"{tier.value}/{tc.value} empty"

    def test_custom_policy_is_respected(self) -> None:
        # Force "trivial" → opus at the BUDGET tier (perverse but allowed).
        policy = RoutingPolicy(
            budget={TaskClass.TRIVIAL: [("anthropic", "claude-opus-4-6")]},
            balanced={TaskClass.TRIVIAL: [("anthropic", "claude-sonnet-4-6")]},
            premium={TaskClass.TRIVIAL: [("anthropic", "claude-opus-4-6")]},
        )
        router = ModelRouter(available=["anthropic"], policy=policy)
        choice = router.route(prompt="trivial", hint="trivial")
        assert "opus" in choice.model.lower()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])


class TestBenchEvidence:
    """A model the repo bench saw fail is passed over (bench/results.py)."""

    def test_a_model_failing_three_cards_is_passed_over(self) -> None:
        router = ModelRouter(
            available=["anthropic", "openai"],
            bench_scores={
                ("anthropic", "claude-haiku-4-5"): {
                    "resolved": 1,
                    "judged": 4,
                    "cases": 3,
                }
            },
        )
        choice = router.route(prompt="fix typo", hint="trivial")
        assert choice.model != "claude-haiku-4-5"
        assert (
            "passed over on bench evidence: anthropic/claude-haiku-4-5 (1/4 on 3 cards)"
            in (choice.reason)
        )

    def test_too_little_evidence_changes_nothing(self) -> None:
        router = ModelRouter(
            available=["anthropic"],
            bench_scores={
                ("anthropic", "claude-haiku-4-5"): {
                    "resolved": 0,
                    "judged": 5,
                    "cases": 2,
                }
            },
        )
        choice = router.route(prompt="fix typo", hint="trivial")
        assert choice.model == "claude-haiku-4-5"
        assert choice.reason.endswith("bench 0/5 resolved")

    def test_a_good_score_is_cited(self) -> None:
        router = ModelRouter(
            available=["anthropic"],
            bench_scores={
                ("anthropic", "claude-haiku-4-5"): {
                    "resolved": 4,
                    "judged": 5,
                    "cases": 5,
                }
            },
        )
        choice = router.route(prompt="fix typo", hint="trivial")
        assert choice.model == "claude-haiku-4-5"
        assert "bench 4/5 resolved" in choice.reason
        assert "passed over" not in choice.reason

    def test_suggestion_reads_the_projects_bench(self, tmp_path, monkeypatch) -> None:
        import json

        from agents.feature_wiring import suggest_routed_model

        bench = tmp_path / ".workpilot" / "bench"
        bench.mkdir(parents=True)
        records = [
            {
                "runId": "r",
                "buildId": f"b{i}",
                "caseId": f"c{i}",
                "provider": "anthropic",
                "model": "claude-haiku-4-5",
                "resolved": False,
            }
            for i in range(3)
        ]
        (bench / "results.json").write_text(
            json.dumps({"records": records}), encoding="utf-8"
        )
        with_bench = suggest_routed_model(
            prompt="fix typo",
            task_hint="trivial",
            available_providers=["anthropic", "openai"],
            project_dir=tmp_path / ".workpilot" / "worktrees" / "tasks" / "001-x",
        )
        without = suggest_routed_model(
            prompt="fix typo",
            task_hint="trivial",
            available_providers=["anthropic", "openai"],
        )
        assert without["model"] == "claude-haiku-4-5"
        assert with_bench["model"] != "claude-haiku-4-5"
        assert "bench" in with_bench["reason"]


class TestBenchEvidencePerKind:
    """With enough cards of the task's kind, those cards are the evidence."""

    @staticmethod
    def _project(tmp_path):
        import json

        def record(i: int, kind: str, resolved: bool) -> dict:
            return {
                "runId": "r",
                "buildId": f"{kind}{i}",
                "caseId": f"{kind}-{i}",
                "kind": kind,
                "provider": "anthropic",
                "model": "claude-haiku-4-5",
                "resolved": resolved,
            }

        bench = tmp_path / ".workpilot" / "bench"
        bench.mkdir(parents=True)
        # Fine on features, failing on bug fixes: 3/6 overall is not a verdict.
        records = [record(i, "feature", True) for i in range(3)]
        records += [record(i, "bug_fix", False) for i in range(3)]
        (bench / "results.json").write_text(
            json.dumps({"records": records}), encoding="utf-8"
        )
        return tmp_path

    def test_scores_per_kind(self, tmp_path) -> None:
        from bench import scores

        project = self._project(tmp_path)
        key = ("anthropic", "claude-haiku-4-5")
        assert scores(project)[key] == {"resolved": 3, "judged": 6, "cases": 6}
        assert scores(project, "bug_fix")[key] == {
            "resolved": 0,
            "judged": 3,
            "cases": 3,
            "kind": "bug_fix",
        }
        # A kind the bench saw too little of keeps the overall score.
        assert scores(project, "docs")[key] == scores(project)[key]

    def test_the_card_kind_decides(self, tmp_path) -> None:
        import json

        from agents.feature_wiring import card_kind, suggest_routed_model

        project = self._project(tmp_path)
        spec = project / ".workpilot" / "specs" / "007-x"
        spec.mkdir(parents=True)
        (spec / "task_metadata.json").write_text(
            json.dumps({"kind": "bug_fix"}), encoding="utf-8"
        )
        assert card_kind(spec) == "bug_fix"
        assert card_kind(project / "nowhere") is None

        bug = suggest_routed_model(
            prompt="fix typo",
            task_hint="trivial",
            available_providers=["anthropic", "openai"],
            project_dir=project,
            kind="bug_fix",
        )
        feature = suggest_routed_model(
            prompt="fix typo",
            task_hint="trivial",
            available_providers=["anthropic", "openai"],
            project_dir=project,
            kind="feature",
        )
        assert bug["model"] != "claude-haiku-4-5"
        assert "(0/3 on 3 bug_fix cards)" in bug["reason"]
        assert feature["model"] == "claude-haiku-4-5"
        assert "bench 3/3 resolved on feature cards" in feature["reason"]
