"""Where WorkPilot finds the Claude Code OAuth token, and what it hands the SDK.

Each test sets up what a machine would have (environment variables, a
profile's credentials file, a keychain entry, a Git for Windows install) and
asks `core.auth` the question the CLI and `create_client` ask. The OS stores
that cannot run here are stand-ins at their edge: the `security` command on
macOS (`subprocess.run`), the Secret Service on Linux (a `secretstorage` with
the real library's calls, including its refusal of a missing DBus connection),
and `where.exe` on Windows. Every token is a placeholder.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import logging
import os
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from core import auth

TOKEN = "sk-ant-oat01-placeholder-0000"  # pragma: allowlist secret
OTHER = "sk-ant-oat01-placeholder-1111"  # pragma: allowlist secret
ENCRYPTED = "enc:cGxhY2Vob2xkZXItMDAwMA=="  # pragma: allowlist secret


def credentials(token: object = TOKEN, key: str = "claudeAiOauth") -> str:
    return json.dumps({key: {"accessToken": token}})


@pytest.fixture(autouse=True)
def machine(tmp_path, monkeypatch):
    """A machine with no token anywhere, on Linux, without a Secret Service."""
    for var in (*auth.AUTH_TOKEN_ENV_VARS, *auth.SDK_ENV_VARS, "DEBUG"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    home = tmp_path / "home"
    home.mkdir()
    for var in ("HOME", "USERPROFILE"):
        monkeypatch.setenv(var, str(home))
    for var in ("LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"):
        path = tmp_path / var.lower()
        path.mkdir()
        monkeypatch.setenv(var, str(path))
    on(monkeypatch, "Linux")
    monkeypatch.setattr(auth, "secretstorage", None)
    return home


def on(monkeypatch, system: str) -> None:
    monkeypatch.setattr(auth, "is_macos", lambda: system == "Darwin")
    monkeypatch.setattr(auth, "is_windows", lambda: system == "Windows")
    monkeypatch.setattr(auth, "is_linux", lambda: system == "Linux")
    if system == "Windows":
        # `%VAR%\...` paths, as Windows expands them
        def expandvars(path: str) -> str:
            expanded = re.sub(
                r"%([^%]+)%", lambda m: os.environ.get(m.group(1), m.group(0)), path
            )
            return expanded.replace("\\", os.sep)

        monkeypatch.setattr(os.path, "expandvars", expandvars)


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# macOS Keychain: `security find-generic-password -s <service> -w`


@pytest.fixture
def keychain(monkeypatch):
    """The macOS Keychain, by service name."""
    entries: dict[str, str] = {}
    asked: list[list[str]] = []

    def run(cmd, **kwargs):
        asked.append(cmd)
        assert cmd[:2] == ["/usr/bin/security", "find-generic-password"]
        service = cmd[cmd.index("-s") + 1]
        if service not in entries:
            return subprocess.CompletedProcess(cmd, 44, "", "item not found")
        return subprocess.CompletedProcess(cmd, 0, entries[service] + "\n", "")

    monkeypatch.setattr(auth.subprocess, "run", run)
    on(monkeypatch, "Darwin")
    return SimpleNamespace(entries=entries, asked=asked)


# ---------------------------------------------------------------------------
# Linux Secret Service, with the calls of the real `secretstorage`


class SecretStorageException(Exception):
    pass


class SecretServiceNotAvailableException(SecretStorageException):
    pass


class LockedException(SecretStorageException):
    pass


class Item:
    def __init__(self, label: str, secret: bytes | Exception):
        self.label = label
        self.secret = secret

    def get_label(self) -> str:
        return self.label

    def get_secret(self) -> bytes:
        if isinstance(self.secret, Exception):
            raise self.secret
        return self.secret


class Connection:
    closed = False

    def close(self) -> None:
        self.closed = True


class SecretService:
    """`secretstorage` as WorkPilot uses it, over one keyring."""

    exceptions = SimpleNamespace(
        SecretStorageException=SecretStorageException,
        SecretServiceNotAvailableException=SecretServiceNotAvailableException,
    )

    def __init__(self):
        self.items: list[tuple[dict, Item]] = []
        self.available = True
        self.locked = False
        self.unlock_dismissed = False
        self.connections: list[Connection] = []

    def add(self, label: str, secret: bytes | Exception, app="claude-code") -> None:
        self.items.append(({"application": app}, Item(label, secret)))

    def dbus_init(self) -> Connection:
        if not self.available:
            raise SecretServiceNotAvailableException(
                "Environment variable DBUS_SESSION_BUS_ADDRESS is unset"
            )
        connection = Connection()
        self.connections.append(connection)
        return connection

    def get_default_collection(self, connection):
        # The real library sends a DBus message on the connection at once,
        # so a missing connection fails as it does there
        if not isinstance(connection, Connection):
            raise AttributeError(
                "'NoneType' object has no attribute 'send_and_get_reply'"
            )
        return self

    def is_locked(self) -> bool:
        return self.locked

    def unlock(self) -> bool:
        self.locked = self.unlock_dismissed
        return self.unlock_dismissed

    def search_items(self, attributes: dict):
        if self.locked:
            raise LockedException("Collection is locked!")
        return [item for attrs, item in self.items if attrs == attributes]


@pytest.fixture
def secret_service(monkeypatch):
    service = SecretService()
    monkeypatch.setattr(auth, "secretstorage", service)
    yield service
    assert all(c.closed for c in service.connections), "a DBus connection was left open"


# ---------------------------------------------------------------------------


class TestEnvironmentVariables:
    def test_the_claude_code_token_comes_first(self, monkeypatch):
        monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN)
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", OTHER)

        assert auth.get_auth_token() == TOKEN
        assert auth.get_auth_token_source() == "CLAUDE_CODE_OAUTH_TOKEN"

    def test_a_proxy_token_is_used_when_it_is_the_only_one(self, monkeypatch):
        monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "")
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", OTHER)

        assert auth.get_auth_token() == OTHER
        assert auth.get_auth_token_source() == "ANTHROPIC_AUTH_TOKEN"

    def test_an_api_key_is_never_taken_for_a_token(self, monkeypatch):
        monkeypatch.setenv(
            "ANTHROPIC_API_KEY", "sk-ant-api03-0000"
        )  # pragma: allowlist secret

        assert auth.get_auth_token() is None
        assert auth.get_auth_token_source() is None
        with pytest.raises(ValueError, match="ANTHROPIC_API_KEY\\) are not supported"):
            auth.require_auth_token()


class TestAProfile:
    """A profile (CLAUDE_CONFIG_DIR) reads its own credentials, never the default."""

    @pytest.mark.parametrize(
        ("name", "key"),
        [
            (".credentials.json", "claudeAiOauth"),
            ("credentials.json", "claudeAiOauth"),
            (".credentials.json", "oauthAccount"),
        ],
    )
    def test_its_credentials_file_is_read(self, tmp_path, name, key):
        write(tmp_path / "work" / name, credentials(key=key))

        assert auth.get_auth_token(str(tmp_path / "work")) == TOKEN
        assert auth.get_auth_token_source(str(tmp_path / "work")) == "CLAUDE_CONFIG_DIR"

    def test_the_profile_set_in_the_environment_is_the_one_read(
        self, machine, monkeypatch
    ):
        write(machine / "work" / ".credentials.json", credentials())
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", "~/work")

        assert auth.get_auth_token() == TOKEN

    @pytest.mark.parametrize(
        "content",
        [
            "{",
            "[]",
            credentials(token="sk-something-else"),
            credentials(token=42),
            json.dumps({"claudeAiOauth": "not an object"}),
        ],
    )
    def test_a_file_without_a_usable_token_gives_none(self, tmp_path, content):
        write(tmp_path / "work" / ".credentials.json", content)

        assert auth.get_auth_token(str(tmp_path / "work")) is None

    def test_an_unreadable_file_is_skipped_for_the_next(self, tmp_path):
        (tmp_path / "work" / ".credentials.json").mkdir(parents=True)
        write(tmp_path / "work" / "credentials.json", credentials())

        assert auth.get_auth_token(str(tmp_path / "work")) == TOKEN

    def test_its_keychain_entry_is_the_hashed_one(self, tmp_path, keychain):
        profile = str(tmp_path / "work")
        service = auth._get_keychain_service_name(profile)
        keychain.entries[service] = credentials(OTHER)
        keychain.entries["Claude Code-credentials"] = credentials(TOKEN)

        assert auth.get_auth_token(profile) == OTHER
        assert auth.get_auth_token_source(profile) == "macOS Keychain (profile)"

    def test_without_its_own_entry_it_gets_none_not_the_default(
        self, tmp_path, keychain, monkeypatch, caplog
    ):
        keychain.entries["Claude Code-credentials"] = credentials(TOKEN)
        monkeypatch.setenv("DEBUG", "true")
        profile = str(tmp_path / "work")

        with caplog.at_level(logging.INFO, logger=auth.__name__):
            assert auth.get_auth_token(profile) is None
            assert auth.get_auth_token_source(profile) is None

        assert auth._get_keychain_service_name(profile) in caplog.text
        assert TOKEN not in caplog.text


class TestMacOSKeychain:
    def test_the_default_entry(self, keychain):
        keychain.entries["Claude Code-credentials"] = credentials()

        assert auth.get_auth_token() == TOKEN
        assert auth.get_auth_token_source() == "macOS Keychain"
        assert (
            keychain.asked
            == [
                [
                    "/usr/bin/security",
                    "find-generic-password",
                    "-s",
                    "Claude Code-credentials",
                    "-w",
                ]
            ]
            * 2
        )

    @pytest.mark.parametrize("entry", ["", "{", credentials(token="not-oauth")])
    def test_an_entry_without_a_usable_token_gives_none(self, keychain, entry):
        keychain.entries["Claude Code-credentials"] = entry

        assert auth.get_auth_token() is None

    def test_no_entry_gives_none(self, keychain):
        assert auth.get_auth_token() is None
        assert auth.get_auth_token_source() is None

    @pytest.mark.parametrize(
        "error",
        [subprocess.TimeoutExpired(["security"], 5), FileNotFoundError("security")],
    )
    def test_a_keychain_that_hangs_or_is_missing_gives_none(self, monkeypatch, error):
        on(monkeypatch, "Darwin")

        def run(cmd, **kwargs):
            raise error

        monkeypatch.setattr(auth.subprocess, "run", run)

        assert auth.get_auth_token() is None


class TestWindowsCredentialFiles:
    @pytest.mark.parametrize(
        ("var", "relative"),
        [
            ("USERPROFILE", ".claude/.credentials.json"),
            ("USERPROFILE", ".claude/credentials.json"),
            ("LOCALAPPDATA", "Claude/credentials.json"),
            ("APPDATA", "Claude/credentials.json"),
        ],
    )
    def test_each_place_claude_code_writes(self, monkeypatch, var, relative):
        on(monkeypatch, "Windows")
        write(Path(os.environ[var]) / relative, credentials())

        assert auth.get_auth_token() == TOKEN
        assert auth.get_auth_token_source() == "Windows Credential Files"

    def test_a_broken_file_does_not_hide_the_next(self, machine, monkeypatch):
        on(monkeypatch, "Windows")
        write(machine / ".claude" / ".credentials.json", "{")
        write(
            Path(os.environ["APPDATA"]) / "Claude" / "credentials.json", credentials()
        )

        assert auth.get_auth_token() == TOKEN

    def test_nothing_written_gives_none(self, monkeypatch):
        on(monkeypatch, "Windows")

        assert auth.get_auth_token() is None
        assert auth.get_auth_token_source() is None

    def test_a_profile_reads_only_its_folder(self, machine, monkeypatch, tmp_path):
        on(monkeypatch, "Windows")
        write(machine / ".claude" / ".credentials.json", credentials(OTHER))

        assert auth.get_auth_token(str(tmp_path / "work")) is None


class TestLinux:
    def test_the_secret_service_entry(self, secret_service):
        secret_service.add("Claude Code-credentials", credentials().encode())

        assert auth.get_auth_token() == TOKEN
        assert auth.get_auth_token_source() == "Linux Secret Service"

    def test_a_profile_reads_its_labelled_entry_only(self, secret_service, tmp_path):
        profile = str(tmp_path / "work")
        secret_service.add("Claude Code-credentials", credentials(OTHER).encode())
        secret_service.add(
            auth._get_keychain_service_name(profile), credentials().encode()
        )

        assert auth.get_auth_token(profile) == TOKEN
        assert auth.get_auth_token_source(profile) == "Linux Secret Service (profile)"

    def test_other_applications_and_labels_are_ignored(self, secret_service):
        secret_service.add("Claude Code-credentials", credentials().encode(), "other")
        secret_service.add("Claude Code-credentials-old", credentials().encode())

        assert auth.get_auth_token() is None

    @pytest.mark.parametrize(
        "secret", [b"", b"{", credentials(token="nope").encode(), b"\xff\xfe"]
    )
    def test_an_entry_without_a_usable_token_is_passed_over(
        self, secret_service, secret
    ):
        secret_service.add("Claude Code-credentials", secret)
        secret_service.add("Claude Code-credentials", credentials().encode())

        assert auth.get_auth_token() == TOKEN

    def test_a_locked_keyring_is_unlocked(self, secret_service):
        secret_service.locked = True
        secret_service.add("Claude Code-credentials", credentials().encode())

        assert auth.get_auth_token() == TOKEN

    def test_a_dismissed_unlock_prompt_gives_none(self, secret_service):
        secret_service.locked = True
        secret_service.unlock_dismissed = True
        secret_service.add("Claude Code-credentials", credentials().encode())

        assert auth.get_auth_token() is None

    def test_an_entry_that_cannot_be_read_gives_none(self, secret_service):
        secret_service.add("Claude Code-credentials", LockedException("locked item"))

        assert auth.get_auth_token() is None

    def test_without_a_secret_service_claude_codes_file_is_read(
        self, secret_service, machine
    ):
        secret_service.available = False
        write(machine / ".claude" / ".credentials.json", credentials())

        assert auth.get_auth_token() == TOKEN
        assert auth.get_auth_token_source() == "~/.claude/.credentials.json"

    def test_without_secretstorage_claude_codes_file_is_read(self, machine):
        write(machine / ".claude" / ".credentials.json", credentials())

        assert auth.get_auth_token() == TOKEN

    def test_a_profile_never_falls_back_to_the_default_file(self, machine, tmp_path):
        write(machine / ".claude" / ".credentials.json", credentials())

        assert auth.get_auth_token(str(tmp_path / "work")) is None

    def test_nothing_anywhere_says_how_to_log_in(self, secret_service):
        assert auth.get_auth_token() is None
        with pytest.raises(ValueError, match="CLAUDE_CODE_OAUTH_TOKEN in your .env"):
            auth.require_auth_token()


class TestTheLoginAdvice:
    @pytest.mark.parametrize(
        ("system", "where"),
        [
            ("Darwin", "macOS Keychain"),
            ("Windows", "Windows Credential Manager"),
            ("Linux", "CLAUDE_CODE_OAUTH_TOKEN in your .env"),
        ],
    )
    def test_it_names_where_the_token_will_be(self, monkeypatch, system, where):
        on(monkeypatch, system)
        monkeypatch.setattr(auth, "get_token_from_keychain", lambda *a: None)

        with pytest.raises(ValueError, match="No OAuth token found") as raised:
            auth.require_auth_token()

        assert where in str(raised.value)
        assert "/login" in str(raised.value)

    def test_a_token_found_is_returned(self, monkeypatch):
        monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN)

        assert auth.require_auth_token() == TOKEN


class TestWhatTheSdkIsGiven:
    def test_the_profile_token_is_put_where_the_sdk_reads_it(
        self, tmp_path, monkeypatch, caplog
    ):
        write(tmp_path / "work" / ".credentials.json", credentials())

        with caplog.at_level(logging.INFO, logger=auth.__name__):
            auth.configure_sdk_authentication(str(tmp_path / "work"))

        assert os.environ["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN
        assert f"present(len={len(TOKEN)})" in caplog.text
        assert TOKEN not in caplog.text

    def test_an_encrypted_token_is_refused_before_the_sdk(self, monkeypatch):
        monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", ENCRYPTED)

        assert auth.get_auth_token() == ENCRYPTED
        with pytest.raises(ValueError, match="encrypted format") as raised:
            auth.configure_sdk_authentication()
        assert "claude setup-token" in str(raised.value)

    def test_an_encrypted_token_in_a_profile_is_refused_too(self, tmp_path):
        write(tmp_path / "work" / ".credentials.json", credentials(ENCRYPTED))

        with pytest.raises(ValueError, match="encrypted format"):
            auth.configure_sdk_authentication(str(tmp_path / "work"))

    def test_no_token_is_refused(self):
        with pytest.raises(ValueError, match="No OAuth token found"):
            auth.configure_sdk_authentication()

    def test_an_api_profile_uses_its_own_token(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://proxy.example")
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", OTHER)
        monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN)

        auth.configure_sdk_authentication()

        # The SDK prefers the OAuth token when both are set
        assert "CLAUDE_CODE_OAUTH_TOKEN" not in os.environ
        assert os.environ["ANTHROPIC_AUTH_TOKEN"] == OTHER

    def test_an_api_profile_without_its_token_is_refused(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://proxy.example")

        with pytest.raises(ValueError, match="ANTHROPIC_AUTH_TOKEN is not set"):
            auth.configure_sdk_authentication()

    def test_a_leftover_base_url_does_not_send_the_oauth_token_to_it(
        self, monkeypatch, caplog
    ):
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://stale.example")
        monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN)

        with caplog.at_level(logging.WARNING, logger=auth.__name__):
            auth.configure_sdk_authentication()

        assert "ANTHROPIC_BASE_URL" not in os.environ
        assert os.environ["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN
        assert "Removing ANTHROPIC_BASE_URL" in caplog.text

    def test_the_oauth_token_is_copied_for_the_sdk_when_only_a_proxy_token_is_set(
        self, monkeypatch
    ):
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", OTHER)

        auth.ensure_claude_code_oauth_token()

        assert os.environ["CLAUDE_CODE_OAUTH_TOKEN"] == OTHER

    def test_a_set_oauth_token_is_kept(self, monkeypatch):
        monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN)
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", OTHER)

        auth.ensure_claude_code_oauth_token()

        assert os.environ["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN

    def test_no_token_sets_nothing(self):
        auth.ensure_claude_code_oauth_token()

        assert "CLAUDE_CODE_OAUTH_TOKEN" not in os.environ


class TestTheSdkEnvironment:
    def test_only_set_variables_pass_and_pythonpath_is_emptied(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://proxy.example")
        monkeypatch.setenv("ANTHROPIC_MODEL", "")
        monkeypatch.setenv(
            "ANTHROPIC_API_KEY", "sk-ant-api03-0000"
        )  # pragma: allowlist secret
        monkeypatch.setenv("PYTHONPATH", "/somewhere")

        assert auth.get_sdk_env_vars() == {
            "ANTHROPIC_BASE_URL": "https://proxy.example",
            "PYTHONPATH": "",
        }

    def test_git_bash_is_not_looked_for_outside_windows(self, monkeypatch):
        def run(cmd, **kwargs):
            raise AssertionError(f"ran {cmd}")

        monkeypatch.setattr(auth.subprocess, "run", run)

        assert "CLAUDE_CODE_GIT_BASH_PATH" not in auth.get_sdk_env_vars()


class TestGitBashOnWindows:
    """Claude Code on Windows needs bash.exe; it is found next to git.exe."""

    @pytest.fixture
    def where(self, monkeypatch):
        found: dict[str, object] = {"git": None}

        def run(cmd, **kwargs):
            assert cmd == ["where.exe", "git"]
            assert kwargs.get("shell") is False
            answer = found["git"]
            if isinstance(answer, BaseException):
                raise answer
            if answer is None:
                return subprocess.CompletedProcess(cmd, 1, "", "not found")
            return subprocess.CompletedProcess(
                cmd, 0, f"{answer}\nC:\\other\\git.exe\n", ""
            )

        monkeypatch.setattr(auth.subprocess, "run", run)
        on(monkeypatch, "Windows")
        return found

    @staticmethod
    def install(root: Path, git: str, bash: str | None = "bin/bash.exe") -> Path:
        write(root / git, "")
        if bash:
            write(root / bash, "")
        return root / git

    @pytest.mark.parametrize(
        "git", ["cmd/git.exe", "bin/git.exe", "mingw64/bin/git.exe"]
    )
    def test_each_layout_of_git_for_windows(self, where, tmp_path, git):
        where["git"] = self.install(tmp_path / "Git", git)

        env = auth.get_sdk_env_vars()

        assert env["CLAUDE_CODE_GIT_BASH_PATH"] == str(
            tmp_path / "Git" / "bin" / "bash.exe"
        )

    @pytest.mark.parametrize(
        "error", [FileNotFoundError("where.exe"), subprocess.TimeoutExpired("where", 5)]
    )
    def test_without_where_the_usual_install_folders_are_tried(self, where, error):
        where["git"] = error
        root = Path(os.environ["LOCALAPPDATA"]) / "Programs" / "Git"
        self.install(root, "cmd/git.exe")

        env = auth.get_sdk_env_vars()

        assert env["CLAUDE_CODE_GIT_BASH_PATH"] == str(root / "bin" / "bash.exe")

    def test_git_without_bash_gives_nothing(self, where, tmp_path):
        where["git"] = self.install(tmp_path / "Git", "cmd/git.exe", bash=None)

        assert "CLAUDE_CODE_GIT_BASH_PATH" not in auth.get_sdk_env_vars()

    def test_no_git_gives_nothing(self, where):
        assert "CLAUDE_CODE_GIT_BASH_PATH" not in auth.get_sdk_env_vars()

    def test_a_path_set_by_the_app_is_kept(self, where, monkeypatch):
        monkeypatch.setenv("CLAUDE_CODE_GIT_BASH_PATH", r"D:\Git\bin\bash.exe")
        where["git"] = AssertionError("where.exe should not run")

        assert auth.get_sdk_env_vars()["CLAUDE_CODE_GIT_BASH_PATH"] == (
            r"D:\Git\bin\bash.exe"
        )


class TestLogsAndNames:
    @pytest.mark.parametrize(("token", "shown"), [(None, "absent"), ("", "absent")])
    def test_a_missing_token_reads_as_absent(self, token, shown):
        assert auth._token_presence(token) == shown

    def test_a_token_shows_only_its_length(self):
        shown = auth._token_presence(TOKEN)

        assert shown == f"present(len={len(TOKEN)})"
        assert "sk-" not in shown and "0000" not in shown

    def test_the_keychain_name_matches_the_frontend(self):
        """`credential-utils.ts` names a profile's entry the same way."""
        assert auth._get_keychain_service_name(None) == "Claude Code-credentials"
        assert auth._get_keychain_service_name("/Users/dana/.claude-work") == (
            "Claude Code-credentials-"
            + auth._calculate_config_dir_hash("/Users/dana/.claude-work")
        )
        assert (
            auth._calculate_config_dir_hash("/Users/dana/.claude-work")
            == (hashlib.sha256(b"/Users/dana/.claude-work").hexdigest()[:8])
        )

    def test_a_tilde_names_the_same_entry_as_the_home_path(self, machine):
        assert auth._get_keychain_service_name("~/work") == (
            auth._get_keychain_service_name(str(machine / "work"))
        )

    def test_a_plaintext_token_passes_the_encryption_check(self):
        auth.validate_token_not_encrypted(TOKEN)

        assert auth.is_encrypted_token(ENCRYPTED)
        assert not auth.is_encrypted_token(None)
        assert not auth.is_encrypted_token(TOKEN)


class TestLoadingWithoutSecretstorage:
    """Without `secretstorage`, Linux warns once at import; other systems say nothing."""

    @staticmethod
    def load(monkeypatch, linux: bool):
        import foundation.platform

        monkeypatch.setitem(sys.modules, "secretstorage", None)
        monkeypatch.setattr(foundation.platform, "is_linux", lambda: linux)
        spec = importlib.util.spec_from_file_location(
            "core_auth_without_secretstorage", auth.__file__
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_linux_warns(self, monkeypatch, caplog):
        with caplog.at_level(logging.WARNING):
            module = self.load(monkeypatch, linux=True)

        assert module.secretstorage is None
        assert "pip install secretstorage" in caplog.text

    def test_other_systems_do_not(self, monkeypatch, caplog):
        with caplog.at_level(logging.WARNING):
            self.load(monkeypatch, linux=False)

        assert "secretstorage" not in caplog.text
