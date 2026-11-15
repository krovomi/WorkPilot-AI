"""Spec folders: numbering, orphan cleanup, renaming after the task."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from spec.pipeline import models
from spec.pipeline.models import (
    cleanup_orphaned_pending_folders,
    create_spec_dir,
    rename_spec_dir_from_requirements,
)


def _age(folder: Path, minutes: int) -> None:
    then = time.time() - minutes * 60
    os.utime(folder, (then, then))


def test_only_old_empty_pending_folders_are_removed(tmp_path: Path) -> None:
    old_empty = tmp_path / "001-pending"
    recent_empty = tmp_path / "002-pending"
    old_with_spec = tmp_path / "003-pending"
    named = tmp_path / "004-feature"
    for folder in (old_empty, recent_empty, old_with_spec, named):
        folder.mkdir()
    (old_with_spec / "spec.md").write_text("# spec", encoding="utf-8")
    (tmp_path / "005-pending").write_text("a file, not a folder", encoding="utf-8")
    for folder in (old_empty, old_with_spec, named):
        _age(folder, 30)

    cleanup_orphaned_pending_folders(tmp_path)

    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "002-pending",
        "003-pending",
        "004-feature",
        "005-pending",
    ]


def test_cleanup_of_a_missing_specs_folder_is_a_no_op(tmp_path: Path) -> None:
    cleanup_orphaned_pending_folders(tmp_path / "missing")


def test_a_folder_that_cannot_be_removed_is_left(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    folder = tmp_path / "001-pending"
    folder.mkdir()
    _age(folder, 30)

    def refuse(path):
        raise OSError("in use")

    monkeypatch.setattr(models.shutil, "rmtree", refuse)

    cleanup_orphaned_pending_folders(tmp_path)

    assert folder.is_dir()


def test_without_a_lock_the_next_number_follows_the_highest(tmp_path: Path) -> None:
    assert create_spec_dir(tmp_path) == tmp_path / "001-pending"

    for name in ("001-a", "007-b", "abc-c"):
        (tmp_path / name).mkdir()
    (tmp_path / "12x-not-a-number").mkdir()

    assert create_spec_dir(tmp_path) == tmp_path / "008-pending"


def test_a_lock_decides_the_number(tmp_path: Path) -> None:
    class Lock:
        def get_next_spec_number(self) -> int:
            return 42

    assert create_spec_dir(tmp_path, Lock()) == tmp_path / "042-pending"


def _requirements(folder: Path, content: str) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "requirements.json").write_text(content, encoding="utf-8")


def test_a_pending_folder_is_renamed_after_its_task(tmp_path: Path) -> None:
    pending = tmp_path / "003-pending"
    _requirements(pending, json.dumps({"task_description": "Ajouter l'export CSV"}))

    renamed = rename_spec_dir_from_requirements(pending)

    assert renamed == tmp_path / "003-ajouter-export-csv"
    assert renamed.is_dir() and not pending.exists()


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        (None, None),
        ("{}", None),
        ("{broken", None),
    ],
)
def test_nothing_to_name_the_folder_after(tmp_path: Path, content, expected) -> None:
    pending = tmp_path / "003-pending"
    pending.mkdir()
    if content is not None:
        _requirements(pending, content)

    assert rename_spec_dir_from_requirements(pending) is expected
    assert pending.is_dir()


def test_a_folder_without_a_number_keeps_no_prefix(tmp_path: Path) -> None:
    pending = tmp_path / "pending-spec"
    _requirements(pending, json.dumps({"task_description": "Dark mode toggle"}))

    assert rename_spec_dir_from_requirements(pending) == tmp_path / "dark-mode-toggle"


def test_a_failed_move_keeps_the_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pending = tmp_path / "003-pending"
    _requirements(pending, json.dumps({"task_description": "Dark mode toggle"}))

    def refuse(src, dst):
        raise OSError("locked by the file watcher")

    monkeypatch.setattr(models.shutil, "move", refuse)

    assert rename_spec_dir_from_requirements(pending) is None
    assert pending.is_dir()


def test_the_task_log_follows_a_renamed_folder(tmp_path: Path) -> None:
    import shutil

    from task_logger import LogEntryType, LogPhase, get_task_logger
    from task_logger.utils import update_task_logger_path

    old = tmp_path / "001-pending"
    old.mkdir()
    logger = get_task_logger(old)
    logger.set_llm("ollama", "qwen3")
    logger.log("before the rename", LogEntryType.INFO, LogPhase.PLANNING)
    new = tmp_path / "001-export"
    shutil.move(str(old), str(new))

    update_task_logger_path(new)
    logger.log("after the rename", LogEntryType.INFO, LogPhase.PLANNING)

    # The storages moved too: nothing recreates the old folder, and both the
    # shared log and the per-model one hold the entries from after the rename.
    assert not old.exists()
    logs = sorted(p.name for p in new.glob("task_logs*.json"))
    assert len(logs) == 2
    for name in logs:
        text = (new / name).read_text(encoding="utf-8")
        assert "before the rename" in text and "after the rename" in text
