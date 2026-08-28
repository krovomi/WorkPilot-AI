"""Every agent_type in the product gets a roster that fits its work.

`PHASE_ALIASES` used to hold five entries, so twenty-one of the twenty-five
agent_types fell through to the Kanban roster: an `ideation` run was offered a
test-runner it had no use for, and a `commit_message` run was offered three
specialists to write one line. A roster is context billed on every turn, so a
mismatched roster is not just unhelpful — it is paid for.

These tests are about coverage and fit, not about the prompts themselves.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from agents.subagents.phases import (  # noqa: E402
    PHASE_ALIASES,
    all_specs,
    phase_specs,
    sdk_available,
)

# The agent_types that appear in `create_client(agent_type=...)` calls across
# the backend. Kept explicit: if a new one is added without deciding which
# roster it wants, that decision should surface here rather than default
# silently to Kanban.
KNOWN_AGENT_TYPES = {
    "coder",
    "planner",
    "architect",
    "impact_analyzer",
    "qa",
    "qa_reviewer",
    "qa_fixer",
    "pr_reviewer",
    "architecture_reviewer",
    "pr_finding_validator",
    "ideation",
    "insights",
    "insight_extractor",
    "analyzer",
    "context_mesh_analyzer",
    "learning_analyzer",
    "live_companion_analyzer",
    "spec_writer",
    "spec_gatherer",
    "commit_message",
    "pr_template_filler",
    "spec_compaction",
    "merge_resolver",
}


class TestRoutingIsDeliberate:
    """Each agent_type lands on a roster someone chose for it."""

    @pytest.mark.parametrize(
        ("agent_type", "phase"),
        [
            ("coder", "kanban"),
            ("planner", "planner"),
            ("impact_analyzer", "planner"),
            ("qa_reviewer", "qa"),
            ("pr_reviewer", "review"),
            ("architecture_reviewer", "review"),
            ("ideation", "research"),
            ("insights", "research"),
            ("spec_writer", "spec"),
            ("commit_message", "solo"),
            ("merge_resolver", "solo"),
        ],
    )
    def test_agent_type_routes_to_its_phase(self, agent_type: str, phase: str):
        assert PHASE_ALIASES.get(agent_type, "kanban") == phase

    def test_only_the_ordinary_card_falls_through_to_kanban(self):
        """Kanban is the roster for a board card, not a dumping ground."""
        fell_through = {t for t in KNOWN_AGENT_TYPES if t not in PHASE_ALIASES}
        # `coder` is the ordinary board card, which is what the Kanban roster
        # was built for. Everything else names its phase.
        assert fell_through == {"coder"}

    def test_every_alias_names_a_real_builder(self):
        assert set(PHASE_ALIASES.values()) <= set(all_specs())


@pytest.mark.skipif(not sdk_available(), reason="claude_agent_sdk not installed")
class TestRostersFitTheirWork:
    def test_a_reviewer_gets_reviewers_not_a_test_runner(self):
        roster = set(phase_specs("pr_reviewer"))
        assert "security-auditor" in roster
        assert "regression-hunter" in roster
        assert "test-runner" not in roster

    def test_research_gets_no_code_reviewer(self):
        """Nothing is under review during ideation."""
        roster = set(phase_specs("ideation"))
        assert roster == {"codebase-surveyor", "evidence-collector"}

    def test_spec_agents_get_prior_art_and_constraints(self):
        assert set(phase_specs("spec_writer")) == {
            "prior-art-finder",
            "constraint-collector",
        }

    @pytest.mark.parametrize(
        "agent_type",
        ["commit_message", "pr_template_filler", "spec_compaction", "merge_resolver"],
    )
    def test_single_purpose_agents_get_no_roster(self, agent_type: str):
        """An empty roster is the honest answer for work with no subtasks."""
        assert phase_specs(agent_type) == {}

    def test_the_build_rosters_are_unchanged(self):
        """The three original rosters must survive the widening untouched."""
        assert set(phase_specs("coder")) == {
            "code-reviewer",
            "test-runner",
            "spec-explorer",
        }
        assert set(phase_specs("planner")) == {
            "architecture-analyst",
            "dependency-tracer",
        }
        assert set(phase_specs("qa_reviewer")) == {
            "qa-acceptance-checker",
            "qa-test-evidence",
        }


@pytest.mark.skipif(not sdk_available(), reason="claude_agent_sdk not installed")
class TestSpecShape:
    def test_every_reviewing_agent_is_read_only(self):
        """A reviewer that can edit what it reviews stops being a reviewer."""
        for phase in ("review", "research", "spec"):
            for name, spec in all_specs()[phase].items():
                assert "Write" not in spec.tools, f"{phase}/{name} can write"
                assert "Edit" not in spec.tools, f"{phase}/{name} can edit"
                assert "Bash" not in spec.tools, f"{phase}/{name} can run commands"

    def test_every_spec_describes_when_to_use_it(self):
        for phase, roster in all_specs().items():
            for name, spec in roster.items():
                assert spec.description.strip(), f"{phase}/{name} has no description"
                assert spec.prompt.strip(), f"{phase}/{name} has no prompt"


class TestProviderPortability:
    """A roster must survive being handed to a provider that is not Anthropic.

    The registry is provider-agnostic, but its specs name a model tier the way
    the Claude SDK does. Handing "sonnet" to Copilot costs a
    `400 model_not_supported` per subagent before the fallback rescues it.
    """

    def test_tier_aliases_become_inherit(self):
        from core.client import _portable_subagent_model

        for alias in ("sonnet", "opus", "haiku", "Sonnet", "OPUS"):
            assert _portable_subagent_model(alias) == "inherit"

    def test_a_real_model_id_is_left_alone(self):
        from core.client import _portable_subagent_model

        assert _portable_subagent_model("gpt-4o") == "gpt-4o"
        assert (
            _portable_subagent_model("claude-sonnet-4-5-20250929")
            == "claude-sonnet-4-5-20250929"
        )

    def test_absent_model_is_inherit_not_none(self):
        from core.client import _portable_subagent_model

        assert _portable_subagent_model(None) == "inherit"
        assert _portable_subagent_model("") == "inherit"

    def test_inherit_stays_inherit(self):
        from core.client import _portable_subagent_model

        assert _portable_subagent_model("inherit") == "inherit"
