"""
Tests for the `--find-pr` CLI command (visual-proof "sync to PR" support).

`handle_find_pr_command` is a thin, read-only wrapper around
`WorktreeManager.find_existing_pr_url`. It must:
  - print/return `{"success": True, "pr_url": <url|None>}` when detection runs,
    treating "no PR yet" (pr_url is None) as a success, not an error;
  - return `{"success": False, ...}` when detection cannot run (no worktree)
    or the manager raises.

These guarantees are what lets the frontend distinguish "no PR yet" (keep the
captures stored, retry later) from a genuine failure.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "apps" / "backend"))

import cli.workspace_commands as workspace_commands  # noqa: E402
import core.worktree as core_worktree  # noqa: E402

PR_URL = "https://github.com/acme/widgets/pull/42"
AZURE_PR_URL = "https://dev.azure.com/org/proj/_git/repo/pullrequest/123"


class _FakeManager:
    """Stand-in for WorktreeManager whose PR lookup is scripted per-test."""

    result = None
    raises = False

    def __init__(self, project_dir, base_branch=None):
        self.project_dir = project_dir
        self.base_branch = base_branch

    def find_existing_pr_url(self, spec_name, target_branch=None):
        if _FakeManager.raises:
            raise RuntimeError("boom")
        return _FakeManager.result


@pytest.fixture(autouse=True)
def _reset_fake():
    _FakeManager.result = None
    _FakeManager.raises = False
    yield
    _FakeManager.result = None
    _FakeManager.raises = False


@pytest.fixture
def patched(monkeypatch, tmp_path):
    """Patch the worktree lookup + WorktreeManager used by the handler."""
    monkeypatch.setattr(
        workspace_commands,
        "get_existing_build_worktree",
        lambda project_dir, spec_name: tmp_path,
    )
    monkeypatch.setattr(core_worktree, "WorktreeManager", _FakeManager)
    return tmp_path


def test_returns_detected_github_url(patched, capsys):
    _FakeManager.result = PR_URL

    result = workspace_commands.handle_find_pr_command(patched, "001-spec")

    assert result == {"success": True, "pr_url": PR_URL}
    printed = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert printed == {"success": True, "pr_url": PR_URL}


def test_returns_detected_azure_url(patched):
    # Provider-agnostic: an Azure DevOps URL flows through unchanged.
    _FakeManager.result = AZURE_PR_URL

    result = workspace_commands.handle_find_pr_command(patched, "001-spec")

    assert result == {"success": True, "pr_url": AZURE_PR_URL}


def test_no_pr_yet_is_success_with_null_url(patched):
    _FakeManager.result = None

    result = workspace_commands.handle_find_pr_command(patched, "001-spec")

    # "No PR yet" must NOT be an error — the frontend keeps captures and retries.
    assert result == {"success": True, "pr_url": None}


def test_missing_worktree_fails(monkeypatch, tmp_path):
    monkeypatch.setattr(
        workspace_commands,
        "get_existing_build_worktree",
        lambda project_dir, spec_name: None,
    )

    result = workspace_commands.handle_find_pr_command(tmp_path, "001-spec")

    assert result["success"] is False
    assert result["pr_url"] is None


def test_manager_exception_is_reported_as_failure(patched):
    _FakeManager.raises = True

    result = workspace_commands.handle_find_pr_command(patched, "001-spec")

    assert result["success"] is False
    assert result["pr_url"] is None
    assert "boom" in result["error"]
