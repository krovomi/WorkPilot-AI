"""The allowlist and the access policy of the OS sandbox, without running it."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from os_sandbox.hosts import (
    PACKAGE_REGISTRIES,
    HostAllowlist,
    allowlist_for,
    parse_rule,
)
from os_sandbox.launch import _sb_quote, bwrap_argv, seatbelt_profile
from os_sandbox.policy import build_policy, install_dir


class TestHostRules:
    def test_a_host_allows_https_and_http_only(self):
        allow = HostAllowlist.build(["api.openai.com"])
        assert allow.allows("api.openai.com", 443)
        assert allow.allows("API.OpenAI.com.", 80)
        assert not allow.allows("api.openai.com", 22)
        assert not allow.allows("openai.com", 443)
        assert not allow.allows("evil-api.openai.com", 443)

    def test_a_wildcard_is_a_subdomain_never_the_domain_or_a_suffix(self):
        allow = HostAllowlist.build(["*.githubcopilot.com"])
        assert allow.allows("api.individual.githubcopilot.com", 443)
        assert not allow.allows("githubcopilot.com", 443)
        assert not allow.allows("evilgithubcopilot.com", 443)

    def test_a_loopback_entry_names_one_port(self):
        allow = HostAllowlist.build(["127.0.0.1:11434"])
        assert allow.allows("127.0.0.1", 11434)
        assert not allow.allows("127.0.0.1", 11435)
        assert not allow.allows("127.0.0.1", 443)

    @pytest.mark.parametrize(
        "entry",
        [
            "",
            "*.com",
            "localhost",  # every local service
            "127.0.0.1",
            "api.openai.com:8443",  # a remote port is 443/80
            "*.127.0.0.1:80",
            "bad host",
            "exa_mple.com",
            "-x.com",
            "127.0.0.1:0",
            "127.0.0.1:70000",
        ],
    )
    def test_entries_that_are_not_an_allowlist_are_dropped(self, entry):
        assert parse_rule(entry) is None

    def test_the_registries_are_always_there_and_the_person_adds_more(
        self, monkeypatch
    ):
        monkeypatch.setenv("WORKPILOT_SANDBOX_HOSTS", "nexus.corp.example, ,*.bad")
        allow = allowlist_for(["api.anthropic.com"])
        for host in PACKAGE_REGISTRIES:
            assert allow.allows(host, 443)
        assert allow.allows("api.anthropic.com", 443)
        assert allow.allows("nexus.corp.example", 443)
        assert not allow.allows("example.com", 443)


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".ssh").mkdir(parents=True)
    (home / ".ssh" / "id_ed25519").write_text("not a key", encoding="utf-8")
    netrc = "machine x login y password z"  # pragma: allowlist secret
    (home / ".netrc").write_text(netrc, encoding="utf-8")
    (home / ".npm").mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    return home


def _worktree(tmp_path: Path) -> tuple[Path, Path]:
    """A main checkout and a worktree whose `.git` file points into it."""
    main = tmp_path / "repo"
    common = main / ".git"
    (common / "worktrees" / "001").mkdir(parents=True)
    (common / "hooks").mkdir()
    (common / "config").write_text("[core]\n", encoding="utf-8")
    (common / "worktrees" / "001" / "commondir").write_text("../..\n", encoding="utf-8")
    worktree = main / ".workpilot" / "worktrees" / "tasks" / "001"
    worktree.mkdir(parents=True)
    (worktree / ".git").write_text(
        f"gitdir: {common / 'worktrees' / '001'}\n", encoding="utf-8"
    )
    (worktree / ".workpilot-allowlist").write_text("ls\n", encoding="utf-8")
    return main, worktree


class TestPolicy:
    def test_writes_reach_the_roots_and_the_git_dir_but_not_its_hooks(
        self, tmp_path, home
    ):
        main, worktree = _worktree(tmp_path)
        spec = tmp_path / "spec"
        spec.mkdir()
        policy = build_policy(worktree, spec)
        writable = set(policy.writable)
        assert worktree.resolve() in writable
        assert spec.resolve() in writable
        assert (main / ".git").resolve() in writable
        assert (home / ".npm").resolve() in writable
        read_only = set(policy.read_only)
        assert (main / ".git" / "hooks").resolve() in read_only
        assert (main / ".git" / "config").resolve() in read_only
        assert (worktree / ".workpilot-allowlist").resolve() in read_only

    def test_credentials_are_hidden(self, tmp_path, home):
        _, worktree = _worktree(tmp_path)
        policy = build_policy(worktree)
        assert (home / ".ssh").resolve() in policy.hidden
        assert (home / ".netrc").resolve() in policy.hidden_files

    def test_the_projects_env_file_is_hidden(self, tmp_path, home):
        main, worktree = _worktree(tmp_path)
        for root in (main, worktree):
            (root / ".workpilot").mkdir(exist_ok=True)
            (root / ".workpilot" / ".env").write_text("KEY=enc:x\n", encoding="utf-8")
        hidden = set(build_policy(worktree).hidden_files)
        assert (worktree / ".workpilot" / ".env").resolve() in hidden
        assert (main / ".workpilot" / ".env").resolve() in hidden

    def test_an_agents_own_state_is_created_and_writable(
        self, tmp_path, home, monkeypatch
    ):
        _, worktree = _worktree(tmp_path)
        monkeypatch.delenv("PI_CODING_AGENT_DIR", raising=False)
        policy = build_policy(worktree, state_dirs=["~/.pi", "$PI_CODING_AGENT_DIR"])
        assert (home / ".pi").is_dir()
        assert (home / ".pi").resolve() in policy.writable
        # An unset variable names nothing, never the literal "$PI_…".
        assert not any("$" in str(p) for p in policy.writable)

    @pytest.mark.skipif(
        os.name == "nt", reason="a symlink needs a privilege on Windows"
    )
    def test_a_node_cli_is_read_from_its_package_tree(self, tmp_path):
        bin_dir = tmp_path / "prefix" / "node_modules" / ".bin"
        package = tmp_path / "prefix" / "node_modules" / "opencode-ai" / "bin"
        bin_dir.mkdir(parents=True)
        package.mkdir(parents=True)
        (package / "opencode").write_text("#!/usr/bin/env node\n", encoding="utf-8")
        (bin_dir / "opencode").symlink_to(package / "opencode")
        assert install_dir(bin_dir / "opencode") == (tmp_path / "prefix").resolve()


class TestLaunchers:
    def test_bwrap_hides_and_protects_after_it_binds(self, tmp_path, home):
        _, worktree = _worktree(tmp_path)
        policy = build_policy(worktree)
        socket = tmp_path / "proxy.sock"
        argv = bwrap_argv("bwrap", policy, socket, ["/bin/sh", "-c", "true"])
        joined = " ".join(argv)
        assert "--unshare-net" in argv and "--die-with-parent" in argv
        assert argv.index("--ro-bind") < argv.index("--tmpfs")
        last_writable = max(i for i, a in enumerate(argv) if a == "--bind")
        assert joined.index(f"--tmpfs {(home / '.ssh').resolve()}") > joined.index(
            f"--bind {worktree.resolve()}"
        )
        allowlist = (worktree / ".workpilot-allowlist").resolve()
        assert argv.index(str(allowlist)) > last_writable
        assert argv[-3:] == ["/bin/sh", "-c", "true"]
        assert "bridge.py" in joined

    def test_seatbelt_denies_writes_then_allows_the_roots(self, tmp_path, home):
        _, worktree = _worktree(tmp_path)
        profile = seatbelt_profile(build_policy(worktree))
        # Paths as the profile quotes them (a Windows runner has backslashes).
        assert profile.index("(deny file-write*)") < profile.index(
            f"(subpath {_sb_quote(worktree.resolve())})"
        )
        assert '(allow network-outbound (remote ip "localhost:*"))' in profile
        assert "(deny network-outbound)" in profile
        assert _sb_quote((home / ".ssh").resolve()) in profile
