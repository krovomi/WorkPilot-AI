"""Time Travel forks hold no provider key (N8 A3, docs/architecture/variants-and-replays.md).

A fork is recorded and never executed, so a key typed for it served nothing
and was written to disk in clear. The field is gone, and a fork file an older
version wrote with one is rewritten without it the first time it is read.
"""

from __future__ import annotations

import json
from pathlib import Path

from replay.models import ForkRequest, ForkSession
from replay.time_travel import TimeTravelEngine

FAKE_KEY = "sk-test-0000"  # pragma: allowlist secret


def test_a_fork_request_has_no_key_field() -> None:
    request = ForkRequest.from_dict({"fork_model": "m", "fork_api_key": FAKE_KEY})
    assert "fork_api_key" not in request.to_dict()
    assert not hasattr(request, "fork_api_key")


def test_a_legacy_fork_file_loses_its_key_when_read(tmp_path: Path) -> None:
    engine = TimeTravelEngine(storage_dir=tmp_path)
    fork = ForkSession(fork_id="f1", original_session_id="s1")
    data = fork.to_dict()
    data["fork_request"]["fork_api_key"] = FAKE_KEY
    path = tmp_path / "forks" / "f1.json"
    path.write_text(json.dumps(data), encoding="utf-8")

    assert [f.fork_id for f in engine.list_forks()] == ["f1"]
    assert FAKE_KEY not in path.read_text(encoding="utf-8")
    assert engine.get_fork("f1") is not None
