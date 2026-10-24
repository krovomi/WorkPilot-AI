"""Issue triage runs `gh issue edit` and reports what really happened.

`text=True` made `asyncio.create_subprocess_exec` raise before `gh` ran, the
exception was swallowed and the action was still marked completed.
"""

from __future__ import annotations

import asyncio
import sys

import pytest
from continuous_ai.issue_responder import IssueResponder
from continuous_ai.types import DaemonModule, IssueResponderConfig

_real_exec = asyncio.create_subprocess_exec


def _fake_gh(exit_code: int, stderr: str = ""):
    """Run a Python stand-in for `gh`, with the caller's own keyword args."""
    calls: list[tuple] = []

    async def fake(program, *args, **kwargs):
        calls.append((program, *args))
        code = f"import sys; sys.stderr.write({stderr!r}); sys.exit({exit_code})"
        return await _real_exec(sys.executable, "-c", code, **kwargs)

    return fake, calls


@pytest.fixture
def responder(tmp_path):
    return IssueResponder(
        tmp_path, IssueResponderConfig(), DaemonModule(name="issue_responder")
    )


def test_triage_adds_the_label_through_gh(responder, monkeypatch):
    fake, calls = _fake_gh(0)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake)

    result = asyncio.run(responder._triage_issue(12, "bug"))

    assert calls == [("gh", "issue", "edit", "12", "--add-label", "bug")]
    assert result["success"] is True
    assert "Added label: bug" in result["message"]


def test_triage_reports_a_gh_failure(responder, monkeypatch):
    fake, _ = _fake_gh(1, "no permission")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake)

    result = asyncio.run(responder._triage_issue(12, "feature"))

    assert result["success"] is False
    assert "no permission" in result["error"]


def test_bug_investigation_does_not_claim_work_it_does_not_do(responder):
    result = asyncio.run(responder._investigate_bug(12))

    assert result["success"] is False
