"""The GitHub CLI folder of the Copilot token lookups (foundation/copilot_gh_env.py)."""

from __future__ import annotations

from foundation.copilot_gh_env import copilot_gh_env


def test_without_an_account_the_lookup_inherits_the_environment(monkeypatch):
    monkeypatch.delenv("COPILOT_GH_CONFIG_DIR", raising=False)
    assert copilot_gh_env() is None
    monkeypatch.setenv("COPILOT_GH_CONFIG_DIR", "   ")
    assert copilot_gh_env() is None


def test_the_default_account_folder_becomes_gh_config_dir(monkeypatch):
    monkeypatch.setenv("COPILOT_GH_CONFIG_DIR", " /accounts/copilot/a ")
    monkeypatch.setenv("GH_CONFIG_DIR", "/home/me/.config/gh")
    monkeypatch.setenv("PATH", "/usr/bin")

    env = copilot_gh_env()

    assert env is not None
    assert env["GH_CONFIG_DIR"] == "/accounts/copilot/a"
    assert env["PATH"] == "/usr/bin"
