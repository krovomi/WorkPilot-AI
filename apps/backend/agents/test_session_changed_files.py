"""Tests for per-subtask changed-file persistence (post-session processing).

Guards the ground-truth file attribution used by the UI's per-subtask
"files modified" view: when a subtask completes we record the real git diff in
``files_changed`` (unioned across sessions), rather than relying on the
planner's pre-coding prediction.
"""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from agents.session import _persist_subtask_changed_files

# `analysis.insight_extractor` is reachable under more than one name once the
# backend and `tests/` are collected in the same run, and a dotted-string
# `monkeypatch.setattr` resolves the attribute on the *package* — bound only if
# that exact name was imported first. Patching the module object is unambiguous.
from analysis import insight_extractor as _insight_extractor


class TestPersistSubtaskChangedFiles:
    def _patch(self, monkeypatch: pytest.MonkeyPatch, changed: list[str]) -> dict:
        """Stub the git diff + plan-save dependencies; capture the saved plan."""
        captured: dict = {"save_calls": 0}

        def fake_get_changed_files(project_dir, commit_before, commit_after):
            return list(changed)

        def fake_save(spec_dir, plan):
            captured["save_calls"] += 1
            captured["plan"] = plan
            return True

        monkeypatch.setattr(
            _insight_extractor, "get_changed_files", fake_get_changed_files
        )
        # Resolve `qa.criteria` here, not at module import: while this file is
        # being collected another test module may still have a MagicMock parked
        # at `sys.modules["qa"]`, and `from qa import criteria` would then bind
        # a mock attribute that patching does nothing to — the real save ran and
        # `fake_save` never did. By the time a test body runs, collection is
        # over and the name resolves to the module the lazy import will find.
        monkeypatch.setattr(
            importlib.import_module("qa.criteria"),
            "save_implementation_plan",
            fake_save,
        )
        return captured

    def _run(self, plan: dict, subtask: dict) -> None:
        _persist_subtask_changed_files(
            spec_dir=Path("/spec"),
            project_dir=Path("/proj"),
            plan=plan,
            subtask=subtask,
            subtask_id="s1",
            commit_before="aaa",
            commit_after="bbb",
        )

    def test_records_changed_files_on_completion(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured = self._patch(monkeypatch, ["src/a.ts", "src/b.ts"])
        subtask = {"id": "s1"}
        plan = {"phases": [{"subtasks": [subtask]}]}

        self._run(plan, subtask)

        assert subtask["files_changed"] == ["src/a.ts", "src/b.ts"]
        assert captured["save_calls"] == 1
        assert captured["plan"] is plan

    def test_unions_across_sessions_without_duplicates(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._patch(monkeypatch, ["src/b.ts", "src/c.ts"])
        subtask = {"id": "s1", "files_changed": ["src/a.ts", "src/b.ts"]}
        plan = {"phases": [{"subtasks": [subtask]}]}

        self._run(plan, subtask)

        assert subtask["files_changed"] == ["src/a.ts", "src/b.ts", "src/c.ts"]

    def test_no_save_when_no_files_changed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured = self._patch(monkeypatch, [])
        subtask = {"id": "s1"}
        plan = {"phases": [{"subtasks": [subtask]}]}

        self._run(plan, subtask)

        assert "files_changed" not in subtask
        assert captured["save_calls"] == 0

    def test_no_save_when_nothing_new(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured = self._patch(monkeypatch, ["src/a.ts"])
        subtask = {"id": "s1", "files_changed": ["src/a.ts"]}
        plan = {"phases": [{"subtasks": [subtask]}]}

        self._run(plan, subtask)

        assert subtask["files_changed"] == ["src/a.ts"]
        assert captured["save_calls"] == 0

    def test_never_raises_when_git_helper_fails(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def boom(*_args, **_kwargs):
            raise RuntimeError("git exploded")

        monkeypatch.setattr(_insight_extractor, "get_changed_files", boom)
        subtask = {"id": "s1"}
        plan = {"phases": [{"subtasks": [subtask]}]}

        # Must be non-fatal: completion should never be blocked by attribution.
        self._run(plan, subtask)

        assert "files_changed" not in subtask
