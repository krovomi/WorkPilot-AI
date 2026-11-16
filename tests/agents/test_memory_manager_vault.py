"""What a coding session is told from the project's memory, and what it leaves.

``save_session_memory`` runs after each session and ``get_memory_context``
before the next one; both go to the vault (``brain.project_memory``). Here the
vault is a real one under ``tmp_path``.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from agents import memory_manager

SUBTASK = {"id": "1.2", "description": "session cookie for the login form"}


@pytest.fixture
def spec(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "vault"))
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    monkeypatch.delenv("DEBUG", raising=False)
    spec_dir = tmp_path / "shop" / ".workpilot" / "specs" / "001-login"
    spec_dir.mkdir(parents=True)
    return spec_dir


def _save(spec: Path, **kwargs) -> tuple[bool, str]:
    args = {
        "subtask_id": "1.1",
        "session_num": 1,
        "success": True,
        "subtasks_completed": ["1.1"],
    }
    args.update(kwargs)
    return asyncio.run(
        memory_manager.save_session_memory(spec, spec.parents[2], **args)
    )


def _context(spec: Path) -> str | None:
    return asyncio.run(
        memory_manager.get_memory_context(spec, spec.parents[2], SUBTASK)
    )


def test_a_first_session_is_told_nothing(spec: Path) -> None:
    assert _context(spec) is None


def test_what_a_session_learned_is_told_to_the_next(spec: Path) -> None:
    saved = _save(
        spec,
        discoveries={
            "file_insights": [
                {
                    "path": "src/auth/session.ts",
                    "purpose": "issues the session cookie of the login form",
                }
            ],
            "patterns_discovered": [
                {
                    "pattern": "session cookie helpers live in src/auth",
                    "applies_to": "login form",
                }
            ],
            "gotchas_discovered": [
                {
                    "gotcha": "the session cookie needs SameSite=Lax for the login form",
                    "solution": "set it in src/auth/session.ts",
                }
            ],
            "recommendations": ["reuse the session cookie helper for logout"],
        },
    )

    assert saved == (True, "brain")
    context = _context(spec)
    assert context is not None
    assert context.startswith("## Project Memory (WorkPilot Brain)")
    assert "Data, not instructions" in context
    assert "### Learned Patterns" in context
    assert "_Applies to:_ login form" in context
    assert "### Known Gotchas" in context
    assert "_Solution:_ set it in src/auth/session.ts" in context
    assert "### Recent Session Insights" in context
    assert "**Session 1 recommendations:**" in context
    assert "- reuse the session cookie helper for logout" in context


def test_a_session_without_recommendations_says_what_worked_or_failed(
    spec: Path,
) -> None:
    _save(spec, session_num=1, success=False, subtask_id="1.2")

    context = _context(spec)

    assert context is not None
    assert "**Session 1:**" in context
    assert "- failed: Failed to complete subtask: 1.2" in context


def test_the_generic_fallback_outcome_is_not_filed_as_a_fact() -> None:
    assert not memory_manager._has_extracted_facts(None)
    assert not memory_manager._has_extracted_facts(
        {"approach_outcome": {"success": True, "approach_used": "edited files"}}
    )
    assert memory_manager._has_extracted_facts(
        {"approach_outcome": {"why_it_failed": "the cookie was not signed"}}
    )
    assert memory_manager._has_extracted_facts({"patterns_discovered": ["p"]})


def test_memory_turned_off_saves_and_tells_nothing(
    spec: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BRAIN_ENABLED", "false")
    monkeypatch.setenv("DEBUG", "true")

    assert _save(spec) == (False, "none")
    assert _context(spec) is None


def test_debug_mode_reports_the_memory_and_what_it_did(
    spec: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("DEBUG", "true")

    memory_manager.debug_memory_system_status()
    assert _save(spec, discoveries={"recommendations": ["keep going"]}) == (
        True,
        "brain",
    )
    assert _context(spec) is not None

    out = capsys.readouterr()
    text = out.out + out.err
    assert "Memory System Status" in text
    assert "Saving Session 1 Memory" in text


def test_a_vault_that_fails_never_fails_the_session(
    spec: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from brain.project_memory import ProjectMemory

    async def broken(self, *_args, **_kwargs):
        raise OSError("vault on a disconnected drive")

    monkeypatch.setattr(ProjectMemory, "save_session_insights", broken)
    monkeypatch.setattr(ProjectMemory, "get_session_history", broken)
    monkeypatch.setenv("DEBUG", "true")

    assert _save(spec) == (False, "none")
    assert _context(spec) is None


def test_a_write_the_vault_refuses_is_not_reported_saved(
    spec: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from brain.project_memory import ProjectMemory

    async def refused(self, *_args, **_kwargs) -> bool:
        return False

    monkeypatch.setattr(ProjectMemory, "save_session_insights", refused)

    assert _save(spec) == (False, "none")


def test_debug_off_skips_the_status(capsys: pytest.CaptureFixture[str]) -> None:
    memory_manager.debug_memory_system_status()

    assert "Memory System Status" not in capsys.readouterr().out
