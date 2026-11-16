"""One holder at a time for the GitHub automation's shared state files.

Reviews, triages and the auto-fix queue are JSON files that the runner, the
desktop app's next run and concurrent workflows all rewrite
(runners/github/file_lock.py). A side-car `.lock` file serialises them, with
`fcntl.flock` on POSIX and `msvcrt.locking` on Windows; a write lands whole or
not at all. These tests hold real locks on real files; the Windows leg is
driven with a recording stand-in for `msvcrt`, which only exists there.
"""

from __future__ import annotations

import asyncio
import json
import warnings

import file_lock
import pytest
from file_lock import (
    FileLock,
    FileLockError,
    FileLockTimeout,
    atomic_write,
    locked_json_update,
    locked_read,
    locked_write,
)


def test_a_waiter_never_shares_the_lock_with_a_newcomer(tmp_path):
    """The holder before a waiter must not leave it locking a vanished file."""

    async def scenario():
        state = tmp_path / "index.json"
        first = FileLock(state)
        first.__enter__()
        waiter = FileLock(state, timeout=2.0)
        waiting = asyncio.create_task(waiter.__aenter__())
        await asyncio.sleep(0.05)  # the waiter has opened the lock file
        first.__exit__(None, None, None)
        await waiting
        try:
            with pytest.raises(FileLockTimeout):
                with FileLock(state, timeout=0.1):
                    pass
        finally:
            await waiter.__aexit__(None, None, None)

    asyncio.run(scenario())


def test_a_lock_held_elsewhere_times_out_without_the_event_loop(tmp_path):
    state = tmp_path / "review_7.json"
    with FileLock(state):
        with pytest.raises(FileLockTimeout, match="within 0.05s"):
            with FileLock(state, timeout=0.05):
                pass
    with FileLock(state, timeout=0.05):
        pass  # free again once the first holder left


def test_releasing_a_lock_never_taken_does_nothing(tmp_path):
    lock = FileLock(tmp_path / "never.json")
    assert lock.__exit__(None, None, None) is False
    assert not (tmp_path / "never.json.lock").exists()


def test_reading_a_missing_file_says_so(tmp_path):
    async def read():
        async with locked_read(tmp_path / "missing.json"):
            pass

    with pytest.raises(FileNotFoundError, match="missing.json"):
        asyncio.run(read())


def test_an_atomic_write_is_whole_or_absent(tmp_path):
    target = tmp_path / "deep" / "state.json"
    with atomic_write(target) as f:
        json.dump({"n": 1}, f)
    assert json.loads(target.read_text(encoding="utf-8")) == {"n": 1}
    with atomic_write(tmp_path / "blob.bin", mode="wb") as f:
        f.write(b"\x00\x01")
    assert (tmp_path / "blob.bin").read_bytes() == b"\x00\x01"

    with pytest.raises(RuntimeError):
        with atomic_write(target) as f:
            f.write('{"n": 2, "half')
            raise RuntimeError("crashed mid-write")
    assert json.loads(target.read_text(encoding="utf-8")) == {"n": 1}
    assert sorted(p.name for p in target.parent.iterdir()) == ["state.json"]


def test_a_failed_locked_write_leaves_the_old_content(tmp_path):
    target = tmp_path / "state.json"
    target.write_text('{"n": 1}', encoding="utf-8")

    async def write_and_crash():
        async with locked_write(target) as f:
            f.write("{")
            raise RuntimeError("crashed mid-write")

    with pytest.raises(RuntimeError):
        asyncio.run(write_and_crash())
    assert target.read_text(encoding="utf-8") == '{"n": 1}'
    assert not [p for p in tmp_path.iterdir() if ".tmp." in p.name]


def test_an_update_that_cannot_be_written_leaves_the_old_content(tmp_path):
    target = tmp_path / "state.json"
    target.write_text('{"n": 1}', encoding="utf-8")
    with pytest.raises(TypeError):
        asyncio.run(locked_json_update(target, lambda data: {"n": object()}))
    assert target.read_text(encoding="utf-8") == '{"n": 1}'
    assert not [p for p in tmp_path.iterdir() if ".tmp." in p.name]


class RecordingMsvcrt:
    """Stands in for Windows' `msvcrt`, which this platform does not have."""

    LK_NBLCK = 2
    LK_UNLCK = 0

    def __init__(self):
        self.calls: list[int] = []

    def locking(self, fd, mode, size):
        self.calls.append(mode)


@pytest.fixture
def windows(monkeypatch):
    msvcrt = RecordingMsvcrt()
    monkeypatch.setattr(file_lock, "_IS_WINDOWS", True)
    monkeypatch.setattr(file_lock, "msvcrt", msvcrt)
    return msvcrt


def test_on_windows_the_lock_is_byte_range_locking_and_its_file_goes(tmp_path, windows):
    state = tmp_path / "state.json"
    with FileLock(state):
        assert (tmp_path / "state.json.lock").exists()
    assert windows.calls == [windows.LK_NBLCK, windows.LK_UNLCK]
    assert not (tmp_path / "state.json.lock").exists()


def test_on_windows_a_shared_lock_is_taken_exclusive(tmp_path, windows):
    with pytest.warns(RuntimeWarning, match="Shared file locks are not supported"):
        with FileLock(tmp_path / "state.json", exclusive=False):
            pass


def test_on_windows_without_msvcrt_nothing_is_locked(tmp_path, windows, monkeypatch):
    monkeypatch.setattr(file_lock, "msvcrt", None)
    with pytest.raises(FileLockError, match="msvcrt is required"):
        with FileLock(tmp_path / "state.json"):
            pass
    with pytest.warns(RuntimeWarning, match="msvcrt unavailable"):
        file_lock._unlock(0)


def test_without_fcntl_on_posix_nothing_is_locked(tmp_path, monkeypatch):
    monkeypatch.setattr(file_lock, "_IS_WINDOWS", False)
    monkeypatch.setattr(file_lock, "fcntl", None)
    with pytest.raises(FileLockError, match="fcntl is required"):
        with FileLock(tmp_path / "state.json"):
            pass
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        file_lock._unlock(0)
    assert "fcntl unavailable" in str(caught[0].message)
