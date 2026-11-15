"""A rename that Windows refuses for an instant does not lose the write.

On a Windows runner, four processes appending to one usage ledger under its
lock still failed: ``os.replace`` raised ``PermissionError [WinError 5]`` while
another handle on the target was closing, and the worker lost its record.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import foundation.file_utils as file_utils
import pytest
from foundation.file_utils import write_json_atomic


def _refuse_replace(monkeypatch, refusals: int) -> dict[str, int]:
    real_replace = os.replace
    calls = {"n": 0}

    def flaky_replace(source, target):
        calls["n"] += 1
        if calls["n"] <= refusals:
            raise PermissionError(13, "Access is denied", str(target))
        return real_replace(source, target)

    monkeypatch.setattr(file_utils.os, "replace", flaky_replace)
    monkeypatch.setattr(file_utils, "REPLACE_PAUSE_S", 0.0)
    return calls


def _temp_files(folder: Path) -> list[str]:
    return [p.name for p in folder.iterdir() if ".tmp." in p.name]


def test_windows_waits_out_a_target_held_open(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(file_utils, "is_windows", lambda: True)
    calls = _refuse_replace(monkeypatch, refusals=2)
    target = tmp_path / "cost_data.json"
    target.write_bytes(b'{"usages": []}')

    write_json_atomic(target, {"usages": [1]})

    assert calls["n"] == 3
    assert json.loads(target.read_text(encoding="utf-8")) == {"usages": [1]}
    assert _temp_files(tmp_path) == []


def test_windows_gives_up_after_the_last_attempt(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(file_utils, "is_windows", lambda: True)
    calls = _refuse_replace(monkeypatch, refusals=file_utils.REPLACE_ATTEMPTS)

    with pytest.raises(PermissionError):
        write_json_atomic(tmp_path / "cost_data.json", {"usages": [1]})

    assert calls["n"] == file_utils.REPLACE_ATTEMPTS


def test_elsewhere_a_refusal_is_raised_at_once(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(file_utils, "is_windows", lambda: False)
    calls = _refuse_replace(monkeypatch, refusals=1)

    with pytest.raises(PermissionError):
        write_json_atomic(tmp_path / "cost_data.json", {"usages": [1]})

    assert calls["n"] == 1
