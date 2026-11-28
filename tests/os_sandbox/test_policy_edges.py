"""The host names and the policy of the sandbox, at their edges.

`test_hosts_and_policy.py` covers the allowlist and the policy of a normal
worktree. This file covers what they do with odd input: a bracketed IPv6
host, a name that is no name, a local endpoint URL, a `.git` file that is not
one, a state folder that cannot be made. Each answer is "leave it out", never
an exception and never a wider sandbox.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from os_sandbox import policy as policy_module
from os_sandbox.hosts import HostAllowlist, loopback_rule, normalize_host
from os_sandbox.policy import build_policy


class TestHostNames:
    def test_a_bracketed_ipv6_host_is_compared_without_its_brackets(self):
        assert normalize_host("[::1]") == "::1"

    @pytest.mark.parametrize("host", ["", " . ", "a" * 254])
    def test_an_empty_or_overlong_name_is_no_host(self, host):
        assert normalize_host(host) is None

    def test_a_name_that_is_no_host_is_never_allowed(self):
        allow = HostAllowlist.build(["api.example.com"])

        assert not allow.allows("bad host", 443)

    @pytest.mark.parametrize(
        ("url", "entry"),
        [
            ("http://127.0.0.1:11434", "127.0.0.1:11434"),
            ("https://localhost", "localhost:443"),
            ("http://localhost/v1", "localhost:80"),
            ("https://api.example.com", None),
            ("not a url", None),
        ],
    )
    def test_only_a_local_endpoint_becomes_a_loopback_entry(self, url, entry):
        assert loopback_rule(url) == entry

    def test_the_described_allowlist_reads_back_as_entries(self):
        allow = HostAllowlist.build(["*.example.com", "127.0.0.1:8080", "a.org"])

        assert allow.describe() == ["*.example.com", "127.0.0.1:8080", "a.org"]


class _Unresolvable:
    """A path whose resolution fails, as a symlink loop does."""

    def expanduser(self):
        return self

    def resolve(self):
        raise RuntimeError("symlink loop")


class TestExistingPaths:
    def test_a_path_that_cannot_be_resolved_or_is_missing_is_left_out(self, tmp_path):
        here = tmp_path / "here"
        here.mkdir()

        found = policy_module._existing(
            [_Unresolvable(), tmp_path / "missing", here, here]  # type: ignore[list-item]
        )

        assert found == [here.resolve()]


class TestGitDir:
    def test_a_folder_without_git_is_no_repository(self, tmp_path):
        assert policy_module._git_common_dir(tmp_path) is None

    def test_a_git_folder_is_its_own_repository(self, tmp_path):
        (tmp_path / ".git").mkdir()

        assert policy_module._git_common_dir(tmp_path) == tmp_path / ".git"

    def test_a_git_file_that_cannot_be_read_is_no_repository(
        self, tmp_path, monkeypatch
    ):
        marker = tmp_path / ".git"
        marker.write_text("gitdir: /x\n", encoding="utf-8")
        real = Path.read_text

        def read_text(self, *args, **kwargs):
            if self == marker:
                raise PermissionError(self)
            return real(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", read_text)

        assert policy_module._git_common_dir(tmp_path) is None

    def test_a_git_file_of_another_shape_is_no_repository(self, tmp_path):
        (tmp_path / ".git").write_text("not a pointer\n", encoding="utf-8")

        assert policy_module._git_common_dir(tmp_path) is None

    def test_a_relative_gitdir_is_read_from_the_worktree(self, tmp_path):
        (tmp_path / "meta").mkdir()
        (tmp_path / ".git").write_text("gitdir: meta\n", encoding="utf-8")

        assert policy_module._git_common_dir(tmp_path) == tmp_path / "meta"

    def test_an_absolute_commondir_is_taken_as_written(self, tmp_path):
        common = tmp_path / "main.git"
        common.mkdir()
        gitdir = tmp_path / "wt-meta"
        gitdir.mkdir()
        (gitdir / "commondir").write_text(f"{common}\n", encoding="utf-8")
        worktree = tmp_path / "wt"
        worktree.mkdir()
        (worktree / ".git").write_text(f"gitdir: {gitdir}\n", encoding="utf-8")

        assert policy_module._git_common_dir(worktree) == common.resolve()

    def test_a_commondir_that_cannot_be_read_falls_back_to_the_gitdir(
        self, tmp_path, monkeypatch
    ):
        gitdir = tmp_path / "wt-meta"
        gitdir.mkdir()
        commondir = gitdir / "commondir"
        commondir.write_text("../..\n", encoding="utf-8")
        worktree = tmp_path / "wt"
        worktree.mkdir()
        (worktree / ".git").write_text(f"gitdir: {gitdir}\n", encoding="utf-8")
        real = Path.read_text

        def read_text(self, *args, **kwargs):
            if self == commondir:
                raise PermissionError(self)
            return real(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", read_text)

        assert policy_module._git_common_dir(worktree) == gitdir


class TestStateDirs:
    def test_a_folder_named_by_an_unset_variable_is_left_out(self, monkeypatch):
        monkeypatch.delenv("WORKPILOT_TEST_UNSET_STATE", raising=False)

        assert policy_module._state_dir("$WORKPILOT_TEST_UNSET_STATE/cli") is None

    def test_a_folder_that_cannot_be_made_is_left_out(self, tmp_path):
        blocker = tmp_path / "a-file"
        blocker.write_text("", encoding="utf-8")

        assert policy_module._state_dir(str(blocker / "state")) is None


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    return home


class TestBuiltPolicy:
    def test_read_only_state_is_kept_when_it_exists_and_its_variables_are_set(
        self, tmp_path, home, monkeypatch
    ):
        project = tmp_path / "project"
        project.mkdir()
        settings = home / "cli-settings.json"
        settings.write_text("{}", encoding="utf-8")
        monkeypatch.delenv("WORKPILOT_TEST_UNSET_STATE", raising=False)

        policy = build_policy(
            project,
            state_read_only=[
                "~/cli-settings.json",
                "$WORKPILOT_TEST_UNSET_STATE/settings.json",
                "~/missing.json",
            ],
        )

        assert settings.resolve() in policy.read_only
        assert all("missing" not in str(p) for p in policy.read_only)

    def test_the_policy_describes_itself_as_plain_lists(self, tmp_path, home):
        project = tmp_path / "project"
        project.mkdir()
        (project / ".workpilot").mkdir()
        (project / ".workpilot" / ".env").write_text("", encoding="utf-8")

        described = build_policy(
            project, allowlist=HostAllowlist.build(["a.org"])
        ).describe()

        assert set(described) == {"writable", "readOnly", "hidden", "network"}
        assert str(project.resolve()) in described["writable"]
        assert str((project / ".workpilot" / ".env").resolve()) in described["hidden"]
        assert described["network"] == ["a.org"]


class TestStateInsideHiddenFolder:
    def test_a_cli_account_under_the_app_settings_keeps_the_rest_hidden(
        self, tmp_path, home, monkeypatch
    ):
        project = tmp_path / "project"
        project.mkdir()
        settings_dir = home / ".config" / "WorkPilot AI"
        account = settings_dir / "config" / "ai-account-homes" / "gemini-cli" / "a1"
        other = settings_dir / "config" / "ai-account-homes" / "codex" / "b2"
        (account / ".gemini").mkdir(parents=True)
        other.mkdir(parents=True)
        (settings_dir / "settings.json").write_text("{}", encoding="utf-8")
        (settings_dir / "config" / "ai-accounts.json").write_text(
            "{}", encoding="utf-8"
        )
        monkeypatch.setenv("GEMINI_CLI_HOME", str(account))

        policy = build_policy(project, state_dirs=["$GEMINI_CLI_HOME/.gemini"])

        state = (account / ".gemini").resolve()
        assert state in policy.writable
        assert settings_dir.resolve() not in policy.hidden
        assert (settings_dir / "settings.json").resolve() in policy.hidden_files
        assert (
            settings_dir / "config" / "ai-accounts.json"
        ).resolve() in policy.hidden_files
        assert (
            settings_dir / "config" / "ai-account-homes" / "codex"
        ).resolve() in policy.hidden
        assert not any(state == h or state.is_relative_to(h) for h in policy.hidden)

    def test_a_writable_folder_that_is_the_hidden_one_is_not_hidden(self, tmp_path):
        hidden = tmp_path / "gh"
        hidden.mkdir()

        assert policy_module._hidden_around(hidden, [hidden]) == []
        assert policy_module._hidden_around(hidden, [tmp_path / "other"]) == [hidden]

    def test_a_hidden_folder_that_cannot_be_listed_hides_nothing_more(
        self, tmp_path, monkeypatch
    ):
        hidden = tmp_path / "secret"
        (hidden / "state").mkdir(parents=True)

        def refuse(self):
            raise OSError("denied")

        monkeypatch.setattr(Path, "iterdir", refuse)

        assert policy_module._hidden_around(hidden, [hidden / "state"]) == []

    def test_a_hidden_file_on_the_way_is_not_walked(self, tmp_path):
        hidden = tmp_path / "file"
        hidden.write_text("", encoding="utf-8")

        assert policy_module._hidden_around(hidden, [hidden / "x"]) == []
