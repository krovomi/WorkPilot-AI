"""The effort selector has to reach every agent, not just the build pipeline.

`create_agent_client` took ``max_thinking_tokens: int | None = None``, and
``None`` means "extended thinking disabled". Fifteen call sites — PR review,
triage, arena, the spec pipeline, the slash commands — simply omitted it, so a
user who set ultrathink got a reviewer with no thinking budget and nothing said
so.

Omitting the argument now resolves the user's setting. Passing ``None``
explicitly still disables thinking, because that is a real instruction and has
to stay expressible.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from core.client import (  # noqa: E402
    _DEFAULT_EFFORT_PHASE,
    _EFFORT_PHASE,
    _NO_EFFORT,
    _UNSET,
    _effort_for,
)


class TestSentinel:
    def test_unset_is_not_none(self):
        """The whole point: "said nothing" and "said None" must differ."""
        assert _UNSET is not None
        assert bool(_UNSET is None) is False

    def test_unset_is_distinguishable_from_every_real_value(self):
        """What the sentinel has to guarantee, stated without class identity.

        `core.client` is importable under two module paths in this repo
        (`core.client` and `apps.backend.core.client`), so an isinstance check
        against a freshly imported `_Unset` compares two different classes and
        fails for reasons that have nothing to do with the sentinel.
        """
        assert _UNSET is not None
        assert not isinstance(_UNSET, int)
        assert type(_UNSET).__name__ == "_Unset"


class TestPhaseRouting:
    @pytest.mark.parametrize(
        ("agent_type", "phase"),
        [
            ("planner", "planning"),
            ("architect", "planning"),
            ("impact_analyzer", "planning"),
            ("qa_reviewer", "qa"),
            ("qa_fixer", "qa"),
            ("spec_writer", "spec"),
            ("spec_gatherer", "spec"),
        ],
    )
    def test_known_agents_map_to_their_phase(self, agent_type: str, phase: str):
        assert _EFFORT_PHASE[agent_type] == phase

    @pytest.mark.parametrize(
        "agent_type", ["coder", "pr_reviewer", "ideation", "insights", "migration"]
    )
    def test_everything_else_uses_the_coding_effort(self, agent_type: str):
        """Four phases exist; substantive work outside them maps onto coding."""
        assert _EFFORT_PHASE.get(agent_type, _DEFAULT_EFFORT_PHASE) == "coding"

    def test_every_mapped_phase_is_one_phase_config_knows(self):
        assert set(_EFFORT_PHASE.values()) <= {"spec", "planning", "coding", "qa"}
        assert _DEFAULT_EFFORT_PHASE in {"spec", "planning", "coding", "qa"}


class TestResolution:
    def test_a_substantive_agent_gets_a_budget(self, tmp_path: Path):
        assert isinstance(_effort_for(tmp_path, "pr_reviewer"), int)

    @pytest.mark.parametrize("agent_type", sorted(_NO_EFFORT))
    def test_single_purpose_agents_stay_on_the_provider_default(
        self, tmp_path: Path, agent_type: str
    ):
        """An ultrathink budget for a one-line commit message is not what the
        user asked for when they raised the effort on their build."""
        assert _effort_for(tmp_path, agent_type) is None

    def test_no_spec_dir_resolves_to_none(self):
        """Some callers genuinely have no spec (arena, slash commands)."""
        assert _effort_for(None, "coder") is None

    def test_resolution_never_raises(self, tmp_path: Path):
        missing = tmp_path / "does" / "not" / "exist"
        assert _effort_for(missing, "coder") in (None, *range(0, 200_000))

    def test_a_broken_phase_config_degrades_to_none(self, tmp_path, monkeypatch):
        import phase_config

        def boom(*_a, **_k):
            raise RuntimeError("settings unreadable")

        monkeypatch.setattr(phase_config, "get_phase_thinking_budget", boom)
        assert _effort_for(tmp_path, "coder") is None


class TestRemovedConventionChain:
    """The superseded convention loop is gone and nothing imports it."""

    @pytest.mark.parametrize(
        "module",
        [
            "core.learning_loop",
            "core.convention_integration",
            "core.convention_engine",
            "cli.conventions_cli",
        ],
    )
    def test_module_is_gone(self, module: str):
        import importlib

        with pytest.raises(ModuleNotFoundError):
            importlib.import_module(module)

    def test_the_replacement_is_present(self):
        from learning_loop.conventions import run_convention_pass

        assert callable(run_convention_pass)
