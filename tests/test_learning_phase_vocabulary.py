"""Readers of the learning loop may only ask for phases something writes.

A pattern carries an `agent_phase`, and `get_patterns_for_phase` filters on an
exact match. So a reader keyed on a phase no producer emits does not fail, warn,
or return less — it returns nothing, on every call, for every project, forever.

That is exactly what happened: `context_for_agent` was wired into ideation and
PR review with the phases "research" and "review", which read well and which
`prompts/learning_analyzer.md` never offers the model. The feature shipped
looking connected and could not produce a single lesson.

These tests close the loop between the two halves. `AGENT_PHASES` is the
producible set; everything that reads has to key on a member of it, and the
prompt that drives the model has to offer exactly it.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

from learning_loop.models import AGENT_PHASES  # noqa: E402
from learning_loop.observe import _agents_for  # noqa: E402
from learning_loop.prompt_injection import (  # noqa: E402
    _PHASE_BY_AGENT,
    context_for_agent,
)


class TestTheVocabularyIsOneThing:
    def test_the_analyzer_prompt_offers_exactly_the_producible_phases(self):
        """The prompt is what the model reads; drift here is invisible."""
        prompt = (BACKEND / "prompts" / "learning_analyzer.md").read_text(
            encoding="utf-8"
        )
        listed = {
            m.group(1)
            for m in re.finditer(r"`(planning|coding|qa_review|qa_fixing|\w+)`", prompt)
            if m.group(1) in {*AGENT_PHASES, "review", "research", "spec", "general"}
        }
        assert listed == set(AGENT_PHASES), (
            "prompts/learning_analyzer.md offers a different phase set than "
            f"AGENT_PHASES: prompt={sorted(listed)} constant={sorted(AGENT_PHASES)}"
        )

    def test_the_vocabulary_has_no_duplicates(self):
        assert len(AGENT_PHASES) == len(set(AGENT_PHASES))


class TestEveryReaderAsksForSomethingWritten:
    def test_prompt_injection_maps_only_onto_producible_phases(self):
        """The regression this file exists for."""
        unwritable = {
            agent: phase
            for agent, phase in _PHASE_BY_AGENT.items()
            if phase not in AGENT_PHASES
        }
        assert not unwritable, (
            "these agent_types read a phase nothing writes, so they will "
            f"receive an empty string forever: {unwritable}"
        )

    def test_the_ledger_files_only_producible_phases(self):
        """`_agents_for` rows for unwritten phases can never fire."""
        for phase in AGENT_PHASES:
            assert _agents_for(_pattern(phase)), (
                f"phase {phase!r} is produced but files to no agent ledger, so "
                "its lessons are dropped"
            )

    @pytest.mark.parametrize("phase", ["review", "research", "spec", "general"])
    def test_the_previously_dead_phases_are_gone(self, phase: str):
        assert phase not in AGENT_PHASES
        assert phase not in _PHASE_BY_AGENT.values()
        assert _agents_for(_pattern(phase)) == []


class TestTheFeaturesThatShipped:
    """The agent_types #62 wired must now reach a real phase."""

    @pytest.mark.parametrize(
        ("agent_type", "phase"),
        [
            ("ideation", "planning"),
            ("insights", "planning"),
            ("spec_writer", "planning"),
            ("pr_reviewer", "qa_review"),
            ("architecture_reviewer", "qa_review"),
            ("coder", "coding"),
            ("qa_fixer", "qa_fixing"),
        ],
    )
    def test_agent_reaches_a_written_phase(self, agent_type: str, phase: str):
        assert _PHASE_BY_AGENT[agent_type] == phase
        assert phase in AGENT_PHASES


class TestDegradation:
    def test_an_unmapped_agent_gets_nothing_rather_than_another_role_lessons(
        self, tmp_path: Path
    ):
        assert context_for_agent(tmp_path, "commit_message") == ""

    def test_it_never_raises(self, tmp_path: Path):
        assert context_for_agent(tmp_path / "nope", "ideation") == ""
        assert context_for_agent(tmp_path, "not_an_agent_type") == ""


def _pattern(phase: str):
    """A stand-in carrying just the field `_agents_for` reads."""

    class _P:
        agent_phase = phase

    return _P()
