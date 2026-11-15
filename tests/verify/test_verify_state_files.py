"""`verify.state`: the shared list of what a verification launched, on real files.

The file can be garbled, its folder can be gone, a recorded process group
can be wrong: none of it may stop a teardown from stopping the app.
"""

from __future__ import annotations

import subprocess
import sys
import threading

import pytest
from foundation.platform import is_windows
from verify.state import (
    STATE_FILE,
    is_alive,
    live_process,
    load_state,
    save_process,
    stop_all,
    stop_process,
)


def test_a_state_file_that_is_not_the_list_reads_as_empty(tmp_path):
    for text in ("[1, 2]", '{"processes": []}', "{oops"):
        (tmp_path / STATE_FILE).write_text(text, encoding="utf-8")
        assert load_state(tmp_path) == {"processes": {}}


def test_a_state_that_cannot_be_written_does_not_raise(tmp_path):
    (tmp_path / "state.json.partial").mkdir()
    save_process(tmp_path, "api", {"pid": 1})
    assert load_state(tmp_path) == {"processes": {}}


def test_an_entry_that_is_not_a_process_is_not_live(tmp_path):
    save_process(tmp_path, "api", {"pid": None})
    assert live_process(tmp_path, "api") is None
    assert stop_process(tmp_path, "nothing") is False
    assert stop_process(tmp_path, "api") is True
    assert load_state(tmp_path)["processes"] == {}


@pytest.mark.skipif(is_windows(), reason="process groups are POSIX")
def test_a_wrong_process_group_still_stops_the_process(tmp_path):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    # Reaped as soon as it dies, as the launching process would.
    threading.Thread(target=child.wait, daemon=True).start()
    try:
        # A group id that names no group: the pid itself is signalled.
        save_process(tmp_path, "api", {"pid": child.pid, "pgid": 2**22 + 12345})
        assert stop_all(tmp_path) == ["api"]
        assert child.wait(timeout=10) is not None
        assert not is_alive(child.pid)
    finally:
        if child.poll() is None:
            child.kill()
