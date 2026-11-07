"""The insight extractor reaches the vault, end to end.

F1 registered ``insight_extractor`` in ``AGENT_CONFIGS``, and
``tests/test_agent_type_registry.py`` holds that. The feature still wrote
nothing, for three reasons the registry test could not see — it replaces the
runtime factory with a stub:

* **the runtime** — ``cli_provider=None`` made the factory resolve
  ``"anthropic"``, which is not a Claude SDK provider. The session went to
  LiteLLM with the Claude Code OAuth token as an API key, was refused, and the
  caller fell back to generic insights;
* **the prompt** — it was looked up beside the module, in ``analysis/prompts/``,
  which does not exist. The model received a one-line fallback without the JSON
  schema, so the keys ``record_structured`` reads were guesses;
* **the write** — ``save_session_memory`` filed the structured insights only
  when ``file_insights`` was non-empty: patterns, gotchas and outcomes found on
  their own were dropped.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

import analysis.insight_extractor as extractor  # noqa: E402

INPUTS = {
    "subtask_id": "subtask-1",
    "subtask_description": "Add the widget",
    "session_num": 1,
    "success": True,
    "changed_files": ["src/widget.py"],
    "commit_messages": "feat: widget",
    "diff": "+ widget",
    "attempt_history": [],
}


@pytest.fixture
def no_saved_providers(tmp_path, monkeypatch):
    """A machine with no ~/.work_pilot_ai_llm_providers.json."""
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    import src.connectors.llm_config as llm_config

    monkeypatch.setattr(llm_config, "CONFIG_FILE", tmp_path / "providers.json")
    return llm_config


class TestRuntime:
    def test_the_extraction_provider_selects_the_claude_sdk(self, no_saved_providers):
        config = no_saved_providers.ProviderConfig.load_provider_config(
            "insight_extraction",
            None,
            extractor.EXTRACTION_PROVIDER,
            extractor.get_extraction_model(),
        )
        assert config.is_claude_sdk
        assert config.model == extractor.get_extraction_model()

    def test_the_factory_builds_a_read_only_sdk_session(
        self, no_saved_providers, monkeypatch, tmp_path
    ):
        import core.runtimes.claude_sdk_runtime as sdk_runtime
        from core.runtimes import create_agent_runtime

        built: dict = {}

        def fake_simple_client(**kwargs):
            built.update(kwargs)
            return object()

        monkeypatch.setattr(sdk_runtime, "create_simple_client", fake_simple_client)
        runtime = create_agent_runtime(
            spec_dir=None,
            phase="insight_extraction",
            project_dir=str(tmp_path),  # a str, as the signature allows
            agent_type="insight_extractor",
            cli_provider=extractor.EXTRACTION_PROVIDER,
            cli_model=extractor.get_extraction_model(),
        )
        assert isinstance(runtime, sdk_runtime.ClaudeSDKRuntime)
        assert runtime.client is not None
        assert built["agent_type"] == "insight_extractor"
        assert built["cwd"] == tmp_path

    def test_run_insight_extraction_asks_for_the_claude_provider(
        self, monkeypatch, tmp_path
    ):
        from core.runtime import SessionResult, SessionStatus

        requested: dict = {}

        class _Runtime:
            async def run_session(self, prompt):
                requested["prompt"] = prompt
                return SessionResult(
                    status=SessionStatus.COMPLETED,
                    output='{"patterns_discovered": []}',
                    error=None,
                )

        def factory(**kwargs):
            requested.update(kwargs)
            return _Runtime()

        class _Port:
            # The agent_runtime port, as core installs it.
            def get_auth_token(self):
                return "token"

            def ensure_claude_code_oauth_token(self):
                return None

            def create_agent_runtime(self, **kwargs):
                return factory(**kwargs)

        import agent_runtime

        monkeypatch.setattr(extractor, "SDK_AVAILABLE", True)
        monkeypatch.setattr(agent_runtime, "_runtime", _Port())
        asyncio.run(
            extractor.run_insight_extraction(dict(INPUTS), project_dir=tmp_path)
        )
        assert requested["cli_provider"] == extractor.EXTRACTION_PROVIDER
        assert requested["agent_type"] == "insight_extractor"


class TestPrompt:
    def test_the_prompt_file_is_the_one_in_backend_prompts(self):
        assert extractor.PROMPT_FILE == BACKEND / "prompts" / "insight_extractor.md"
        assert extractor.PROMPT_FILE.is_file()

    def test_the_built_prompt_carries_the_schema_record_structured_reads(self):
        prompt = extractor._build_extraction_prompt(dict(INPUTS))
        assert prompt.startswith(extractor.PROMPT_FILE.read_text(encoding="utf-8"))
        for key in ('"path"', '"purpose"', '"pattern"', '"applies_to"', '"gotcha"'):
            assert key in prompt, key
        assert "approach_outcome" in prompt


@pytest.fixture
def vault(tmp_path, monkeypatch):
    root = tmp_path / "vault"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    return root


@pytest.fixture
def spec(tmp_path):
    spec_dir = tmp_path / "shop" / ".workpilot" / "specs" / "001-login"
    spec_dir.mkdir(parents=True)
    return spec_dir


def _notes(root: Path, kind: str) -> list[Path]:
    folder = root / "knowledge" / "projects" / "shop" / "memory" / kind
    return sorted(folder.rglob("*.md")) if folder.is_dir() else []


def _save(spec: Path, discoveries: dict) -> tuple[bool, str]:
    from agents.memory_manager import save_session_memory

    return asyncio.run(
        save_session_memory(
            spec_dir=spec,
            project_dir=spec.parents[2],
            subtask_id="subtask-1",
            session_num=1,
            success=True,
            subtasks_completed=["subtask-1"],
            discoveries=discoveries,
        )
    )


class TestVaultWrite:
    def test_patterns_and_outcomes_are_filed_without_file_insights(self, vault, spec):
        ok, _ = _save(
            spec,
            {
                "file_insights": [],
                "patterns_discovered": [
                    {"pattern": "Handlers are thin", "applies_to": "api/"}
                ],
                "gotchas_discovered": [],
                "approach_outcome": {
                    "success": True,
                    "approach_used": "Moved the logic into a service",
                    "why_it_worked": "The handler no longer owns state",
                    "why_it_failed": None,
                    "alternatives_tried": [],
                },
                "recommendations": [],
                "subtask_id": "subtask-1",
                "success": True,
                "changed_files": ["api/widget.py"],
            },
        )
        assert ok
        assert len(_notes(vault, "patterns")) == 1
        assert len(_notes(vault, "outcomes")) == 1

    def test_file_insights_land_in_codebase(self, vault, spec):
        _save(
            spec,
            {
                "file_insights": [
                    {"path": "api/widget.py", "purpose": "The widget endpoint"}
                ],
                "patterns_discovered": [],
                "gotchas_discovered": [],
            },
        )
        assert len(_notes(vault, "codebase")) == 1

    def test_the_generic_fallback_files_no_outcome(self, vault, spec):
        _save(spec, extractor._get_generic_insights("subtask-1", True))
        assert _notes(vault, "outcomes") == []
        assert _notes(vault, "patterns") == []
