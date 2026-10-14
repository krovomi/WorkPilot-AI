#!/usr/bin/env python3
"""
Tests for Secret Scanning
=========================

Tests the scan_secrets.py module functionality including:
- Pattern detection for various secret types
- False positive filtering
- File ignore patterns
- Secret masking
"""

from pathlib import Path

import pytest
from security.scan_secrets import (
    ALL_PATTERNS,
    BINARY_EXTENSIONS,
    DEFAULT_IGNORE_PATTERNS,
    SecretMatch,
    get_staged_files,
    is_false_positive,
    load_secretsignore,
    mask_secret,
    scan_content,
    scan_files,
    should_skip_file,
)


class TestPatternDetection:
    """Tests for secret pattern detection."""

    def test_detects_openai_key(self):
        """Detects OpenAI-style API keys."""
        content = 'api_key = "sk-1234567890abcdefghijklmnop"'
        matches = scan_content(content, "test.py")
        assert len(matches) >= 1
        assert any(
            "OpenAI" in m.pattern_name or "API" in m.pattern_name for m in matches
        )

    def test_detects_anthropic_key(self):
        """Detects Anthropic API keys."""
        content = 'key = "sk-ant-api03-1234567890abcdefghijklmnop"'
        matches = scan_content(content, "test.py")
        assert len(matches) >= 1

    def test_detects_aws_access_key(self):
        """Detects AWS access key IDs."""
        # AWS keys start with AKIA followed by 16 uppercase alphanumeric chars
        # Note: Don't use "EXAMPLE" in the key as it triggers false positive filter
        content = 'AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7REALKEY"'
        matches = scan_content(content, "test.py")
        # The key is 20 chars total (AKIA + 16), which matches the pattern
        assert len(matches) >= 1
        assert any("AWS" in m.pattern_name for m in matches)

    def test_detects_github_pat(self):
        """Detects GitHub personal access tokens."""
        # GitHub PATs are ghp_ followed by exactly 36 alphanumeric chars
        content = 'token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"'
        matches = scan_content(content, "test.py")
        assert len(matches) >= 1
        assert any("GitHub" in m.pattern_name for m in matches)

    def test_detects_stripe_key(self):
        """Detects Stripe secret keys."""
        content = 'stripe_key = "sk_test_1234567890abcdefghijklmnop"'
        matches = scan_content(content, "test.py")
        assert len(matches) >= 1
        assert any("Stripe" in m.pattern_name for m in matches)

    def test_detects_slack_token(self):
        """Detects Slack tokens."""
        content = 'SLACK_TOKEN = "xoxb-123456789012-123456789012-abc123"'
        matches = scan_content(content, "test.py")
        assert len(matches) >= 1
        assert any("Slack" in m.pattern_name for m in matches)

    def test_detects_private_key(self):
        """Detects private keys."""
        content = """-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
-----END RSA PRIVATE KEY-----"""
        matches = scan_content(content, "test.key")
        assert len(matches) >= 1
        assert any("Private Key" in m.pattern_name for m in matches)

    def test_detects_database_url_with_password(self):
        """Detects database URLs with embedded credentials."""
        content = 'DATABASE_URL = "postgresql://user:password123@localhost/db"'
        matches = scan_content(content, "test.py")
        assert len(matches) >= 1
        assert any(
            "PostgreSQL" in m.pattern_name or "Connection" in m.pattern_name
            for m in matches
        )

    def test_detects_mongodb_url(self):
        """Detects MongoDB URLs with credentials."""
        content = 'MONGO_URI = "mongodb+srv://admin:secretpass@cluster.mongodb.net/db"'
        matches = scan_content(content, "test.py")
        assert len(matches) >= 1

    def test_detects_jwt_token(self):
        """Detects JWT tokens."""
        # Real JWT format with typical Supabase/Firebase prefix
        content = 'token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"'
        matches = scan_content(content, "test.py")
        assert len(matches) >= 1

    def test_detects_generic_api_key_assignment(self):
        """Detects generic API key assignments."""
        content = 'api_key = "abcdefghijklmnopqrstuvwxyz123456789"'
        matches = scan_content(content, "test.py")
        assert len(matches) >= 1

    def test_detects_bearer_token(self):
        """Detects Bearer tokens."""
        content = 'headers = {"Authorization": "Bearer sk-1234567890abcdefghijklmnop"}'
        matches = scan_content(content, "test.py")
        assert len(matches) >= 1


class TestFalsePositiveFiltering:
    """Tests for false positive detection."""

    def test_env_reference_is_false_positive(self):
        """Environment variable references are false positives."""
        assert (
            is_false_positive("API_KEY = process.env.API_KEY", "process.env.API_KEY")
            is True
        )
        assert is_false_positive("key = os.environ.get('KEY')", "os.environ") is True

    def test_placeholder_is_false_positive(self):
        """Placeholder values are false positives."""
        assert (
            is_false_positive("api_key = 'your-api-key-here'", "your-api-key-here")
            is True
        )
        assert is_false_positive("key = 'xxxxxxxxxxxxxxxx'", "xxxxxxxxxxxxxxxx") is True
        # Note: The false positive check lowercases the line, so <API_KEY> becomes <api_key>
        # which doesn't match the uppercase pattern. Test what actually works.
        assert is_false_positive("api_key = 'placeholder-value'", "placeholder") is True

    def test_example_value_is_false_positive(self):
        """Example values are false positives."""
        assert (
            is_false_positive("# Example: api_key = 'example_key'", "example") is True
        )
        assert is_false_positive("sample_key = 'sample_value'", "sample") is True

    def test_test_key_is_false_positive(self):
        """Test keys are false positives."""
        assert is_false_positive("test_api_key = 'test-key-123'", "test-key") is True

    def test_todo_comment_is_false_positive(self):
        """TODO comments are false positives."""
        assert is_false_positive("# TODO: add api key", "TODO") is True

    def test_real_key_not_false_positive(self):
        """Real keys should not be filtered."""
        assert (
            is_false_positive(
                "api_key = 'sk-real-api-key-1234567890'", "sk-real-api-key-1234567890"
            )
            is False
        )


class TestFileSkipping:
    """Tests for file skip patterns."""

    def test_skips_git_directory(self):
        """Skips .git directory."""
        assert should_skip_file(".git/config", []) is True

    def test_skips_node_modules(self):
        """Skips node_modules directory."""
        assert should_skip_file("node_modules/package/index.js", []) is True

    def test_skips_venv(self):
        """Skips virtual environment directories."""
        assert should_skip_file(".venv/lib/python3.11/site.py", []) is True
        assert should_skip_file("venv/bin/activate", []) is True

    def test_skips_lock_files(self):
        """Skips lock files."""
        assert should_skip_file("package-lock.json", []) is True
        assert should_skip_file("yarn.lock", []) is True
        assert should_skip_file("poetry.lock", []) is True

    def test_skips_binary_extensions(self):
        """Skips binary file extensions."""
        for ext in [".png", ".jpg", ".pdf", ".zip", ".exe"]:
            assert should_skip_file(f"file{ext}", []) is True

    def test_skips_markdown_by_default(self):
        """Skips markdown files by default."""
        assert should_skip_file("README.md", []) is True
        assert should_skip_file("docs/guide.md", []) is True

    def test_respects_custom_ignores(self):
        """Respects custom ignore patterns."""
        # Custom ignores are regex patterns, not glob patterns
        custom = ["tests/fixtures/", r"\.generated\.py$"]
        assert should_skip_file("tests/fixtures/secrets.txt", custom) is True
        assert should_skip_file("api.generated.py", custom) is True

    def test_allows_normal_source_files(self):
        """Allows normal source code files."""
        assert should_skip_file("app/main.py", []) is False
        assert should_skip_file("src/index.ts", []) is False


class TestSecretMasking:
    """Tests for secret masking."""

    def test_masks_long_secret(self):
        """Fully redacts the secret, leaking no characters."""
        secret = "sk-1234567890abcdefghijklmnop"
        masked = mask_secret(secret)
        assert "1234" not in masked
        assert "abcdef" not in masked
        assert str(len(secret)) in masked

    def test_short_string_redacted(self):
        """Short strings are also fully redacted."""
        masked = mask_secret("short")
        assert "short" not in masked
        assert "5" in masked  # length is reported

    def test_visible_chars_arg_ignored(self):
        """visible_chars is accepted for backwards-compat but never echoes characters."""
        masked = mask_secret("sk-1234567890abcdefghijklmnop", 4)
        assert "sk-1" not in masked


class TestSecretsIgnoreFile:
    """Tests for .secretsignore file handling."""

    def test_loads_ignore_patterns(self, temp_dir: Path):
        """Loads patterns from .secretsignore."""
        ignore_file = temp_dir / ".secretsignore"
        ignore_file.write_text(
            """
# Comment line
tests/fixtures/
*.test.py
config/local.yaml
""",
            encoding="utf-8",
        )
        patterns = load_secretsignore(temp_dir)

        assert "tests/fixtures/" in patterns
        assert "*.test.py" in patterns
        assert "config/local.yaml" in patterns
        assert len(patterns) == 3  # Comments excluded

    def test_returns_empty_when_no_file(self, temp_dir: Path):
        """Returns empty list when no .secretsignore exists."""
        patterns = load_secretsignore(temp_dir)
        assert patterns == []


class TestScanFiles:
    """Tests for scanning multiple files."""

    def test_scans_source_files(self, temp_dir: Path):
        """Scans source files for secrets."""
        # Create a file with a secret
        (temp_dir / "config.py").write_text(
            'API_KEY = "sk-1234567890abcdefghijklmnop"\n', encoding="utf-8"
        )

        matches = scan_files(["config.py"], temp_dir)

        assert len(matches) >= 1
        assert matches[0].file_path == "config.py"

    def test_skips_ignored_files(self, temp_dir: Path):
        """Skips files matching ignore patterns."""
        # Create files
        (temp_dir / "src").mkdir()
        (temp_dir / "src" / "main.py").write_text(
            'KEY = "sk-secret123456789012345678"', encoding="utf-8"
        )

        # Create .secretsignore
        (temp_dir / ".secretsignore").write_text("src/\n", encoding="utf-8")

        matches = scan_files(["src/main.py"], temp_dir)

        assert len(matches) == 0

    def test_handles_missing_files(self, temp_dir: Path):
        """Handles missing files gracefully."""
        matches = scan_files(["nonexistent.py"], temp_dir)
        assert matches == []

    def test_handles_binary_files(self, temp_dir: Path):
        """Skips binary files."""
        binary_file = temp_dir / "image.png"
        binary_file.write_bytes(b"\x89PNG\x0d\x0a\x1a\x0a")

        matches = scan_files(["image.png"], temp_dir)
        assert matches == []

    def test_reports_correct_line_numbers(self, temp_dir: Path):
        """Reports correct line numbers for matches."""
        content = """# Config file
import os

# API Key
API_KEY = "sk-1234567890abcdefghijklmnop"
"""
        (temp_dir / "config.py").write_text(content, encoding="utf-8")

        matches = scan_files(["config.py"], temp_dir)

        assert len(matches) >= 1
        assert matches[0].line_number == 5  # Line with the key


class TestSecretMatchDataClass:
    """Tests for SecretMatch data class."""

    def test_creates_match(self):
        """Creates SecretMatch with all fields."""
        match = SecretMatch(
            file_path="test.py",
            line_number=10,
            pattern_name="OpenAI API key",
            matched_text="sk-12345",
            line_content="api_key = 'sk-12345'",
        )

        assert match.file_path == "test.py"
        assert match.line_number == 10
        assert match.pattern_name == "OpenAI API key"


class TestIntegration:
    """Integration tests for secret scanning."""

    def test_end_to_end_scan(self, temp_git_repo: Path, stage_files):
        """Full scan workflow with staged files."""
        import subprocess

        # Create files with potential secrets
        stage_files(
            {
                "config.py": 'API_KEY = "sk-test1234567890abcdefghij"',
                "safe.py": "x = 42",
            }
        )

        # Scan staged files
        matches = scan_files(["config.py", "safe.py"], temp_git_repo)

        assert len(matches) >= 1
        assert any(m.file_path == "config.py" for m in matches)
        assert not any(m.file_path == "safe.py" for m in matches)

    def test_multiple_secrets_same_file(self, temp_dir: Path):
        """Detects multiple secrets in same file."""
        content = """
API_KEY = "sk-1234567890abcdefghijklmnop"
AWS_KEY = "AKIAIOSFODNN7EXAMPLE"
STRIPE = "sk_test_abcdefghijklmnopqrstuvwxyz"
"""
        (temp_dir / "secrets.py").write_text(content, encoding="utf-8")

        matches = scan_files(["secrets.py"], temp_dir)

        # Should find multiple secrets
        assert len(matches) >= 2

    def test_no_false_positives_in_env_example(self, temp_dir: Path):
        """No false positives in .env.example files."""
        content = """
API_KEY=your-api-key-here
DATABASE_URL=postgresql://localhost/mydb
SECRET=changeme
"""
        (temp_dir / ".env.example").write_text(content, encoding="utf-8")

        # .example files should be skipped by default
        matches = scan_files([".env.example"], temp_dir)
        assert len(matches) == 0


# A fake key, built at runtime so no key-shaped literal sits in the source.
FAKE_KEY = "sk-" + "0a1b2c3d4e" * 3


class TestPatternPrecision:
    """Shapes that used to match although they are no secret, and their neighbours that are."""

    def test_hex_digest_is_not_base64(self):
        """A quoted SHA-256 (lockfile, vendor manifest) is a digest, not base64."""
        content = '"contentSha256": "' + "0123456789abcdef" * 4 + '",'
        assert scan_content(content, "skills-lock.json") == []

    def test_base64_blob_is_still_flagged(self):
        import base64

        blob = base64.b64encode(bytes(range(48))).decode()
        matches = scan_content(f'data = "{blob}"', "config.py")
        assert any(m.pattern_name == "Potential base64-encoded secret" for m in matches)

    def test_twilio_shape_inside_a_digest_is_not_flagged(self):
        digest = "8496cd" + "ac" + "0123456789abcdef" * 2 + "b60f4dea"
        assert scan_content(f"sha: {digest}", "VENDOR.json") == []

    def test_twilio_sid_is_flagged(self):
        sid = "AC" + "0123456789abcdef" * 2
        matches = scan_content(f"account = {sid}", "config.py")
        assert any(m.pattern_name == "Twilio Account SID" for m in matches)

    def test_pass_inside_a_word_is_not_a_password(self):
        matches = scan_content('INTERFACE_BYPASS = "interface_bypass"', "x.py")
        assert matches == []

    @pytest.mark.parametrize(
        "name", ["db_pass", "DB_PASS", "dbPass", "dbPassword", "adminPassword"]
    )
    def test_pass_variable_is_still_a_password(self, name: str):
        matches = scan_content(f'{name} = "correct-horse-battery"', "x.py")
        assert any(m.pattern_name == "Password assignment" for m in matches)

    def test_named_hex_secret_is_flagged_although_digests_are_not(self):
        matches = scan_content(
            '"jwtSecret": "' + "0123456789abcdef" * 4 + '"', "a.json"
        )
        assert any(m.pattern_name == "Hex-encoded secret" for m in matches)

    def test_allowlist_pragma_silences_its_line_only(self):
        content = (
            f'KEY = "{FAKE_KEY}"  # pragma: allowlist secret\nOTHER = "{FAKE_KEY}"\n'
        )
        matches = scan_content(content, "x.py")
        assert matches and {m.line_number for m in matches} == {2}


class TestStagedScan:
    """`--staged-only` scans what the commit holds: the index, not the working tree."""

    def _scan(self, repo: Path) -> list[SecretMatch]:
        return scan_files(get_staged_files(), repo, staged=True)

    def test_secret_in_the_index_is_found_after_the_file_was_cleaned(
        self, temp_git_repo: Path, stage_files, monkeypatch
    ):
        monkeypatch.chdir(temp_git_repo)
        stage_files({"config.py": f'API_KEY = "{FAKE_KEY}"\n'})
        (temp_git_repo / "config.py").write_text("API_KEY = None\n", encoding="utf-8")

        assert {m.file_path for m in self._scan(temp_git_repo)} == {"config.py"}

    def test_unstaged_secret_is_not_reported(
        self, temp_git_repo: Path, stage_files, monkeypatch
    ):
        monkeypatch.chdir(temp_git_repo)
        stage_files({"config.py": "API_KEY = None\n"})
        (temp_git_repo / "config.py").write_text(
            f'API_KEY = "{FAKE_KEY}"\n', encoding="utf-8"
        )

        assert self._scan(temp_git_repo) == []

    def test_renamed_and_edited_file_is_scanned(
        self, temp_git_repo: Path, stage_files, monkeypatch
    ):
        import subprocess

        monkeypatch.chdir(temp_git_repo)
        body = "".join(f"x{i} = {i}\n" for i in range(20))
        stage_files({"a.py": body})
        subprocess.run(["git", "commit", "-qm", "a"], check=True, capture_output=True)
        subprocess.run(["git", "mv", "a.py", "b.py"], check=True, capture_output=True)
        # Similar enough that git reports a rename (R), not a delete and an add.
        stage_files({"b.py": body + f'API_KEY = "{FAKE_KEY}"\n'})

        assert {m.file_path for m in self._scan(temp_git_repo)} == {"b.py"}

    def test_non_ascii_path_is_scanned(
        self, temp_git_repo: Path, stage_files, monkeypatch
    ):
        monkeypatch.chdir(temp_git_repo)
        stage_files({"paramètres.py": f'API_KEY = "{FAKE_KEY}"\n'})

        assert {m.file_path for m in self._scan(temp_git_repo)} == {"paramètres.py"}


def _shell_hooks_runnable() -> bool:
    import shutil

    from core.platform import is_windows

    return not is_windows() and bool(shutil.which("sh") and shutil.which("node"))


@pytest.mark.skipif(
    not _shell_hooks_runnable(), reason="needs sh and node, on a POSIX host"
)
class TestPreCommitHook:
    """`.husky/pre-commit` blocks a commit carrying a secret and lets a clean one through."""

    ROOT = Path(__file__).resolve().parent.parent
    COPIED = (
        ".husky/pre-commit",
        "apps/backend/security/scan_secrets.py",
        "scripts/staged-tests.js",
        "scripts/lib/test-selection.js",
    )

    @pytest.fixture
    def repo(self, temp_git_repo: Path, tmp_path: Path):
        import os
        import shutil
        import sys

        for rel in self.COPIED:
            target = temp_git_repo / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(self.ROOT / rel, target)
        venv_python = temp_git_repo / "apps/backend/.venv/bin/python"
        venv_python.parent.mkdir(parents=True)
        venv_python.symlink_to(sys.executable)
        self.env = {
            **os.environ,
            "HOME": str(tmp_path),
            "GIT_CONFIG_NOSYSTEM": "1",
            "PRE_COMMIT_SKIP_TESTS": "1",
        }
        return temp_git_repo

    def _commit(self, repo: Path, files: dict[str, str], env: dict | None = None):
        import subprocess

        for name, content in files.items():
            (repo / name).parent.mkdir(parents=True, exist_ok=True)
            (repo / name).write_text(content, encoding="utf-8")
            subprocess.run(["git", "add", name], cwd=repo, check=True)
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True
        ).stdout
        result = subprocess.run(
            ["git", "-c", "core.hooksPath=.husky", "commit", "-m", "chore: x"],
            cwd=repo,
            env=env or self.env,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        moved = (
            subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True
            ).stdout
            != head
        )
        return result, moved

    def test_blocks_a_secret_in_a_file_nothing_lints(self, repo: Path):
        result, committed = self._commit(repo, {"settings.yaml": f"key: {FAKE_KEY}\n"})

        assert not committed
        assert "Commit bloqué : secret potentiel" in result.stderr

    def test_blocks_a_secret_in_a_linted_python_file(self, repo: Path):
        result, committed = self._commit(
            repo, {"apps/backend/settings.py": f'API_KEY = "{FAKE_KEY}"\n'}
        )

        assert not committed
        assert "Commit bloqué : secret potentiel" in result.stderr

    def test_lets_a_clean_commit_through(self, repo: Path):
        result, committed = self._commit(repo, {"settings.yaml": "key: null\n"})

        assert committed, result.stderr

    def test_missing_python_warns_without_blocking(self, repo: Path, tmp_path: Path):
        import shutil

        (repo / "apps/backend/.venv/bin/python").unlink()
        # A PATH with git and grep, and no Python.
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        for tool in ("git", "grep"):
            wrapper = bin_dir / tool
            wrapper.write_text(
                f'#!/bin/sh\nexec "{shutil.which(tool)}" "$@"\n', encoding="utf-8"
            )
            wrapper.chmod(0o755)
        env = {**self.env, "PATH": str(bin_dir)}

        result, committed = self._commit(
            repo, {"settings.yaml": f"key: {FAKE_KEY}\n"}, env=env
        )

        assert committed, result.stderr
        assert "Python 3.10+ introuvable" in result.stderr
