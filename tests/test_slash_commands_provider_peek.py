"""Running a palette command reads the provider; it never consumes it (audit F13).

`RESUME_WITH_PROVIDER` is single-shot: `_get_active_provider` deletes it on the
first read, so whoever reads it first decides which session honours the user's
"resume with X". The Kanban command bar ran its tool-enabled path through that
read, and a command fired from the palette ate the choice before the build it
was made for started. The override resolution in the same module already peeked.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

import core.client  # noqa: E402
from core.client import RESUME_WITH_PROVIDER_FILE  # noqa: E402
from slash_commands.api import _agent_workflow_call  # noqa: E402


class _FakeClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        self.prompt = prompt

    async def receive_response(self):
        return
        yield  # pragma: no cover - makes this an async generator


def test_running_a_command_leaves_the_resume_marker_in_place(tmp_path, monkeypatch):
    marker = tmp_path / RESUME_WITH_PROVIDER_FILE
    marker.write_text("ollama", encoding="utf-8")
    seen: dict[str, object] = {}

    def fake_create_agent_client(**kwargs):
        seen.update(kwargs)
        return _FakeClient()

    monkeypatch.setattr(core.client, "create_agent_client", fake_create_agent_client)

    ok, _ = asyncio.run(_agent_workflow_call(tmp_path, "/bmad-help"))

    assert ok
    # The command still runs on the provider the marker names...
    assert seen["provider"] == "ollama"
    # ...and the marker is still there for the session it was written for.
    assert marker.read_text(encoding="utf-8") == "ollama"


def test_the_execution_path_no_longer_imports_the_consuming_resolver():
    source = (REPO_ROOT / "apps" / "backend" / "slash_commands" / "api.py").read_text(
        encoding="utf-8"
    )
    assert "_get_active_provider" not in source
