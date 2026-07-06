"""
Tests for WorktreeManager._inject_azure_push_auth — the helper that makes
`git push` authenticate to Azure DevOps with the configured PAT (via
GIT_CONFIG_* env, not argv) instead of relying on the ambient credential
manager (which caused HTTP 403).
"""

import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "apps" / "backend"))

import core.worktree as worktree  # noqa: E402

WorktreeManager = worktree.WorktreeManager


def _make_manager() -> "worktree.WorktreeManager":
    """Build a manager WITHOUT running __init__ (which needs a real git repo)."""
    mgr = WorktreeManager.__new__(WorktreeManager)
    mgr.project_dir = Path("/fake/project")
    return mgr


def _expected_header(pat: str) -> str:
    token = base64.b64encode(f":{pat}".encode()).decode("ascii")
    return f"Authorization: Basic {token}"


def test_injects_pat_header_for_azure(monkeypatch):
    mgr = _make_manager()
    monkeypatch.setattr(worktree, "detect_git_provider", lambda _dir: "azure_devops")
    monkeypatch.setattr(mgr, "_get_azure_devops_credentials", lambda: ("", "MYPAT"))

    env = mgr._inject_azure_push_auth({"PATH": "/usr/bin"})

    assert env["GIT_CONFIG_COUNT"] == "1"
    assert env["GIT_CONFIG_KEY_0"] == "http.extraheader"
    assert env["GIT_CONFIG_VALUE_0"] == _expected_header("MYPAT")
    # Base env preserved; PAT never placed in a plain var.
    assert env["PATH"] == "/usr/bin"


def test_chains_onto_existing_git_config(monkeypatch):
    mgr = _make_manager()
    monkeypatch.setattr(worktree, "detect_git_provider", lambda _dir: "azure_devops")
    monkeypatch.setattr(mgr, "_get_azure_devops_credentials", lambda: ("", "TOK"))

    env = mgr._inject_azure_push_auth(
        {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.x", "GIT_CONFIG_VALUE_0": "y"}
    )

    # Appends at index 1 without clobbering the pre-existing entry 0.
    assert env["GIT_CONFIG_COUNT"] == "2"
    assert env["GIT_CONFIG_KEY_0"] == "core.x"
    assert env["GIT_CONFIG_KEY_1"] == "http.extraheader"
    assert env["GIT_CONFIG_VALUE_1"] == _expected_header("TOK")


def test_noop_for_non_azure_provider(monkeypatch):
    mgr = _make_manager()
    monkeypatch.setattr(worktree, "detect_git_provider", lambda _dir: "github")
    # Should not even ask for credentials.
    monkeypatch.setattr(
        mgr,
        "_get_azure_devops_credentials",
        lambda: (_ for _ in ()).throw(AssertionError("should not be called")),
    )

    base = {"PATH": "/x"}
    assert mgr._inject_azure_push_auth(base) == base


def test_noop_when_no_pat(monkeypatch):
    mgr = _make_manager()
    monkeypatch.setattr(worktree, "detect_git_provider", lambda _dir: "azure_devops")
    monkeypatch.setattr(mgr, "_get_azure_devops_credentials", lambda: None)

    base = {"PATH": "/x"}
    result = mgr._inject_azure_push_auth(base)
    assert "GIT_CONFIG_COUNT" not in result
    assert result == base


def test_noop_when_provider_detection_raises(monkeypatch):
    mgr = _make_manager()

    def _boom(_dir):
        raise RuntimeError("no remote")

    monkeypatch.setattr(worktree, "detect_git_provider", _boom)
    base = {"PATH": "/x"}
    assert mgr._inject_azure_push_auth(base) == base
