"""Every agent_type the backend asks for exists, and every factory call names one.

Seven features passed an ``agent_type`` that ``AGENT_CONFIGS`` did not hold.
``get_agent_config`` raised, each caller caught the exception and logged a
warning, and the feature produced nothing — the insight extractor among them,
the one writer of patterns/, codebase/ and outcomes/ in the project memory.
Nothing failed loudly, so nothing was noticed.

The roadmap had the opposite problem: it named no agent_type at all, so the
factory's default — ``coder``, with Edit and the Kanban roster — ran work that
reads a project and writes one JSON file.

Both are properties of the source, so they are checked on the source: a new
call site with an unknown name, or with no name, fails here instead of in a
log line nobody reads.
"""

from __future__ import annotations

import ast
import asyncio
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

from agents.tools_pkg.models import AGENT_CONFIGS, get_agent_config  # noqa: E402

_SKIP_DIRS = {"vendor", "__pycache__", "node_modules", ".venv"}

# Factories whose `agent_type` defaults to `coder` (write tools, Kanban roster).
# A call that omits it gets those permissions without anyone deciding so.
_CODER_DEFAULT_FACTORIES = {"create_client", "create_agent_client"}
# Positional index of `agent_type` in both signatures.
_AGENT_TYPE_POSITION = 3


def _backend_sources():
    for path in sorted(BACKEND.rglob("*.py")):
        if _SKIP_DIRS.intersection(path.relative_to(BACKEND).parts):
            continue
        if path.name.startswith("test_") or path.name == "conftest.py":
            continue
        yield path


def _calls():
    for path in _backend_sources():
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (SyntaxError, UnicodeDecodeError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                yield path.relative_to(BACKEND), node


def _callee(node: ast.Call) -> str | None:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def test_every_literal_agent_type_is_registered():
    unknown = [
        f"{path}:{node.lineno} agent_type={kw.value.value!r}"
        for path, node in _calls()
        for kw in node.keywords
        if kw.arg == "agent_type"
        and isinstance(kw.value, ast.Constant)
        and isinstance(kw.value.value, str)
        and kw.value.value not in AGENT_CONFIGS
    ]
    assert unknown == [], (
        "agent_type values with no AGENT_CONFIGS entry — the factory raises and "
        "the caller swallows it:\n" + "\n".join(unknown)
    )


def test_every_coder_default_factory_call_names_its_agent_type():
    unnamed = []
    for path, node in _calls():
        if _callee(node) not in _CODER_DEFAULT_FACTORIES:
            continue
        named = any(kw.arg == "agent_type" for kw in node.keywords)
        splatted = any(kw.arg is None for kw in node.keywords)
        positional = len(node.args) > _AGENT_TYPE_POSITION
        if not (named or splatted or positional):
            unnamed.append(f"{path}:{node.lineno}")
    assert unnamed == [], (
        "factory calls that silently fall back to agent_type='coder':\n"
        + "\n".join(unnamed)
    )


@pytest.mark.parametrize(
    "agent_type",
    [
        "impact_analyzer",
        "architecture_reviewer",
        "migration",
        "insight_extractor",
        "learning_analyzer",
        "context_mesh_analyzer",
        "live_companion_analyzer",
    ],
)
def test_the_seven_silent_features_are_registered_read_only(agent_type: str):
    config = get_agent_config(agent_type)
    assert "Edit" not in config["tools"], f"{agent_type} must not edit code"


def test_architecture_reviewer_can_write_its_report():
    """The caller reads `<spec_dir>/architecture_report.json` back."""
    tools = get_agent_config("architecture_reviewer")["tools"]
    assert {"Read", "Write", "Bash"} <= set(tools)


class TestRoadmap:
    def test_each_prompt_runs_under_a_registered_config_that_can_write(self):
        from runners.roadmap.executor import DEFAULT_AGENT_TYPE, PROMPT_AGENT_TYPES

        prompts_dir = BACKEND / "prompts"
        for prompt, agent_type in PROMPT_AGENT_TYPES.items():
            assert (prompts_dir / prompt).is_file(), prompt
            tools = get_agent_config(agent_type)["tools"]
            # Every roadmap prompt ends with "create <file>.json in the Output
            # Directory", and the phase checks the file exists afterwards.
            assert "Write" in tools, f"{agent_type} cannot create its output file"
            assert "Edit" not in tools
        assert DEFAULT_AGENT_TYPE in AGENT_CONFIGS

    def test_the_executor_passes_the_prompt_agent_type(self, tmp_path):
        from runners.roadmap.executor import AgentExecutor

        seen: list[str] = []

        class _Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def query(self, prompt):
                return None

            async def receive_response(self):
                return
                yield  # pragma: no cover - makes this an async generator

        def factory(project_dir, output_dir, model, **kwargs):
            seen.append(kwargs.get("agent_type"))
            return _Client()

        executor = AgentExecutor(tmp_path, tmp_path, "model", factory, None)
        for prompt in (
            "roadmap_discovery.md",
            "roadmap_features.md",
            "competitor_analysis.md",
        ):
            ok, _ = asyncio.run(executor.run_agent(prompt))
            assert ok, prompt

        assert seen == ["roadmap_discovery", "roadmap_discovery", "competitor_analysis"]


class TestInsightExtraction:
    """The session's answer reaches the caller instead of being dropped."""

    INPUTS = {
        "subtask_id": "1.1",
        "subtask_description": "Add a widget",
        "session_num": 1,
        "success": True,
        "changed_files": ["src/widget.py"],
        "commit_messages": "feat: widget",
        "diff": "+ def widget(): ...",
        "attempt_history": [],
    }

    def _run(self, monkeypatch, tmp_path, output, error=None):
        import analysis.insight_extractor as extractor
        from core.runtime import SessionResult, SessionStatus

        requested: dict = {}

        class _Runtime:
            async def run_session(self, prompt):
                status = SessionStatus.ERROR if error else SessionStatus.COMPLETED
                return SessionResult(status=status, output=output, error=error)

        def factory(**kwargs):
            requested.update(kwargs)
            return _Runtime()

        monkeypatch.setattr(extractor, "SDK_AVAILABLE", True)
        monkeypatch.setattr(extractor, "get_auth_token", lambda: "token")
        monkeypatch.setattr(extractor, "ensure_claude_code_oauth_token", lambda: None)
        monkeypatch.setattr(extractor, "create_agent_runtime", factory)
        result = asyncio.run(
            extractor.run_insight_extraction(dict(self.INPUTS), project_dir=tmp_path)
        )
        return result, requested

    def test_returns_the_json_object_even_when_fenced(self, monkeypatch, tmp_path):
        output = (
            "Here are the insights:\n```json\n"
            '{"file_insights": [{"file": "src/widget.py"}], '
            '"patterns_discovered": [], "gotchas_discovered": []}\n```'
        )
        result, requested = self._run(monkeypatch, tmp_path, output)
        assert result == {
            "file_insights": [{"file": "src/widget.py"}],
            "patterns_discovered": [],
            "gotchas_discovered": [],
        }
        assert requested["agent_type"] == "insight_extractor"
        get_agent_config(requested["agent_type"])  # must not raise

    def test_no_output_is_none(self, monkeypatch, tmp_path):
        result, _ = self._run(monkeypatch, tmp_path, None, error="boom")
        assert result is None

    def test_a_non_object_answer_is_none(self, monkeypatch, tmp_path):
        result, _ = self._run(monkeypatch, tmp_path, "[1, 2, 3]")
        assert result is None

    def test_an_unparseable_answer_is_none_not_an_exception(
        self, monkeypatch, tmp_path
    ):
        """json.loads raises RecursionError on deep nesting; the contract is None."""
        nested = "[" * 200_000 + "]" * 200_000
        result, _ = self._run(monkeypatch, tmp_path, nested)
        assert result is None
