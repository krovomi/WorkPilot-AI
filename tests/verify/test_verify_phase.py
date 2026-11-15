"""The `verify` workflow phase, on the real shop of `conftest.py`.

The loop, the launch, the calls and the report are real; the one thing played
by a stand-in is the model session (`create_agent_client` and
`run_agent_session`), so what is checked is what the phase gives a session —
provider, model, roster, a context without the coder's transcript — and how
the loop's verdict becomes a `PhaseOutcome`.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
import verify.loop as loop_module
import workflows.runner as runner_module
from verify.phase import _context, make_agent_runner, run_verify_phase

REPO_ROOT = Path(__file__).resolve().parents[2]


class StandInClient:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.fixture
def sessions(monkeypatch):
    """Every session the phase opens: the client's arguments and the prompt."""
    opened: list[dict] = []

    def create_agent_client(**kwargs):
        opened.append({"client": kwargs, "resume": _resume_marker()})
        return StandInClient(**kwargs)

    async def run_agent_session(client, prompt, spec_dir, verbose=False, phase=None):
        opened[-1]["prompt"] = prompt
        return "complete", "I looked and changed nothing.", None

    # By name: the module the phase imports at call time, even when an earlier
    # test put a fresh `core.client` in `sys.modules`.
    monkeypatch.setattr("core.client.create_agent_client", create_agent_client)
    monkeypatch.setattr("agents.session.run_agent_session", run_agent_session)
    return opened


def _resume_marker():
    import os

    return os.environ.get("AUTO_CLAUDE_RESUME_SESSION_ID")


def _phase(dispatch="inline", roster=None):
    return SimpleNamespace(
        phase=SimpleNamespace(
            id="verify", impl="skill", pack="tooling", skill="verify", roster=roster
        ),
        dispatch=dispatch,
    )


def _ctx(root, spec, effort="low"):
    return runner_module.PhaseContext(
        project_dir=root,
        spec_dir=spec,
        model="",
        repo_root=REPO_ROOT,
        effort=effort,
        changed_files=["main.py"],
    )


def test_a_working_app_passes_the_phase_with_its_score(shop, sessions):
    root, spec = shop

    outcome = asyncio.run(run_verify_phase(_phase(), _ctx(root, spec)))

    assert outcome.succeeded is True, outcome.detail
    assert outcome.phase_id == "verify"
    assert outcome.detail.startswith("score ")
    assert outcome.output_path is not None
    assert (
        outcome.output_path.read_text(encoding="utf-8")
        .rstrip()
        .endswith("Verify: pass")
    )
    assert sessions == []  # low effort, nothing to fix: no session at all


def test_a_bug_the_fixer_cannot_fix_fails_the_phase(shop, sessions, monkeypatch):
    root, spec = shop
    (root / "main.py").write_text(
        "raise RuntimeError('settings: ORDERS_DB is not configured')\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("AUTO_CLAUDE_RESUME_SESSION_ID", "coder-session-42")

    outcome = asyncio.run(run_verify_phase(_phase(), _ctx(root, spec)))

    assert outcome.succeeded is False
    assert sessions, "the fixer was given a session"
    fixer = sessions[0]
    assert fixer["client"]["agent_type"] == "qa_fixer"
    assert fixer["client"]["roster"] is None  # only the verifier gets one
    assert fixer["client"]["use_subagents"] is True
    assert "ORDERS_DB is not configured" in fixer["prompt"]
    # The session starts from nothing, and the marker is put back afterwards.
    assert fixer["resume"] is None
    assert _resume_marker() == "coder-session-42"


def test_nothing_to_launch_is_no_verdict(tmp_path, sessions, monkeypatch):
    monkeypatch.setenv("BRAIN_ENABLED", "false")
    (tmp_path / "lib.py").write_text("x = 1\n", encoding="utf-8")
    spec = tmp_path / ".workpilot" / "specs" / "001"
    spec.mkdir(parents=True)

    outcome = asyncio.run(run_verify_phase(_phase(), _ctx(tmp_path, spec)))

    assert outcome.succeeded is None
    assert outcome.detail.startswith("not-applicable")


def test_a_loop_that_crashes_is_reported_not_raised(tmp_path, monkeypatch):
    async def crash(*args, **kwargs):
        raise RuntimeError("the state file is gone")

    monkeypatch.setattr(loop_module, "run_verify_loop", crash)
    spec = tmp_path / "spec"
    spec.mkdir()

    outcome = asyncio.run(run_verify_phase(_phase(), _ctx(tmp_path, spec)))

    assert (outcome.succeeded, outcome.detail) == (None, "the state file is gone")
    assert outcome.output_path is None


def test_the_verifier_gets_the_roster_and_a_degraded_dispatch_none(tmp_path, sessions):
    runner = make_agent_runner(
        tmp_path,
        tmp_path,
        model="m",
        provider="ollama",
        roster="verify-web",
        use_subagents=False,
    )
    status, response = asyncio.run(runner("verifier", "drive it"))

    assert (status, response) == ("complete", "I looked and changed nothing.")
    client = sessions[0]["client"]
    assert client["roster"] == "verify-web"
    assert client["provider"] == "ollama"
    assert client["use_subagents"] is False
    assert client["agent_type"] == "verifier"


def test_a_session_that_fails_is_a_result(tmp_path, monkeypatch):
    def refuse(**kwargs):
        raise RuntimeError("no credentials for this provider " + "x" * 600)

    monkeypatch.setattr("core.client.create_agent_client", refuse)
    runner = make_agent_runner(tmp_path, tmp_path, model="m", provider=None)

    status, response = asyncio.run(runner("qa_fixer", "fix it"))

    assert status == "error"
    assert response.startswith("no credentials for this provider")
    assert len(response) == 500


def test_the_verifier_reads_the_project_s_binding_rules(tmp_path):
    """A phone project's rules reach the verifier (a renamed helper once left
    it with none, silently)."""
    (tmp_path / "android").mkdir()
    (tmp_path / "pubspec.yaml").write_text(
        "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n", encoding="utf-8"
    )
    from prompts_pkg.prompts import mobile_section

    expected = mobile_section(tmp_path)
    assert expected
    assert expected in _context(tmp_path, tmp_path)
    # A project with no rules gives the verifier nothing to read.
    plain = tmp_path / "plain"
    plain.mkdir()
    assert _context(plain, plain) == ""


def test_the_sections_are_joined_in_order(tmp_path, monkeypatch):
    monkeypatch.setattr(runner_module, "_constitution", lambda project: "Rule one.")
    monkeypatch.setattr(runner_module, "_platform", lambda *args: "")
    monkeypatch.setattr(runner_module, "_docintel", lambda project, spec: "Diagram.")
    assert _context(tmp_path, tmp_path) == "Rule one.\n\n---\n\nDiagram."
