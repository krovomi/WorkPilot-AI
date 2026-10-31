"""The agent_runtime port: core installs it, the units below core go through it.

``merge``, ``integrations``, ``analysis`` and ``architecture`` used to import
``core`` (or ``agents``) to start one utility session, which put them in the
agents' import cycle. They now ask ``agent_runtime.current()``; these tests
hold that ``core`` installs the runtime, that it reaches the same factories a
test can patch, and that a unit with no runtime takes its "no SDK, no token"
path instead of failing (docs/architecture/agent-runtime.md). That the port
itself imports nothing of the backend is ``tests/test_import_contracts.py``.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

import agent_runtime  # noqa: E402

# Importing core (any of its modules) installs the runtime.
from core.agent_runtime import CoreAgentRuntime  # noqa: E402


@pytest.fixture
def no_runtime(monkeypatch):
    monkeypatch.setattr(agent_runtime, "_runtime", None)


class TestCoreInstallsTheRuntime:
    def test_importing_core_installs_it(self):
        assert isinstance(agent_runtime.current(), CoreAgentRuntime)

    def test_it_reads_core_auth_when_called(self, monkeypatch):
        import core.auth

        monkeypatch.setattr(core.auth, "get_auth_token", lambda: "sk-test-0000")
        assert agent_runtime.current().get_auth_token() == "sk-test-0000"

    def test_it_builds_clients_with_core_s_factory(self, monkeypatch):
        import core.simple_client

        built = {}

        def factory(**kwargs):
            built.update(kwargs)
            return "client"

        monkeypatch.setattr(core.simple_client, "create_simple_client", factory)
        client = agent_runtime.current().create_simple_client(
            agent_type="merge_resolver"
        )
        assert client == "client"
        assert built == {"agent_type": "merge_resolver"}


class TestWithoutARuntime:
    def test_the_merge_resolver_has_no_ai(self, no_runtime):
        from merge.ai_resolver.claude_client import create_claude_resolver

        assert create_claude_resolver().ai_call_fn is None

    def test_the_linear_client_is_refused(self, no_runtime, monkeypatch):
        from integrations.linear import updater

        monkeypatch.setattr(updater, "SDK_AVAILABLE", True)
        with pytest.raises(ImportError, match="no agent runtime"):
            updater._create_linear_client()

    def test_insight_extraction_is_off(self, no_runtime, monkeypatch):
        from analysis import insight_extractor

        monkeypatch.setattr(insight_extractor, "SDK_AVAILABLE", True)
        assert insight_extractor.is_extraction_enabled() is False

    def test_the_architecture_review_finds_nothing(self, no_runtime, tmp_path):
        from architecture.ai_reviewer import run_architecture_ai_review
        from architecture.models import ArchitectureConfig, ArchitectureReport

        violations = asyncio.run(
            run_architecture_ai_review(
                project_dir=tmp_path,
                spec_dir=tmp_path,
                model="model-a",
                deterministic_report=ArchitectureReport(),
                config=ArchitectureConfig(),
            )
        )
        assert violations == []


class TestWithoutAToken:
    def test_the_merge_resolver_has_no_ai(self, monkeypatch):
        class _Port:
            def get_auth_token(self):
                return None

        monkeypatch.setattr(agent_runtime, "_runtime", _Port())
        from merge.ai_resolver.claude_client import create_claude_resolver

        assert create_claude_resolver().ai_call_fn is None


def test_the_architecture_reviewer_prompt_is_filled(tmp_path, monkeypatch):
    from architecture import ai_reviewer

    monkeypatch.setattr(ai_reviewer, "detect_base_branch", lambda *_: "develop")
    prompt = ai_reviewer.architecture_reviewer_prompt(
        spec_dir=tmp_path / "spec",
        project_dir=tmp_path,
        architecture_rules="RULES-X",
        deterministic_report="REPORT-Y",
    )
    assert "RULES-X" in prompt and "REPORT-Y" in prompt
    assert "develop" in prompt
    assert "{{" not in prompt
