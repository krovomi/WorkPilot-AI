"""`scan_secrets.py` as the pre-commit hook and a person run it."""

from __future__ import annotations

import json
import subprocess
import sys

import pytest
from security import scan_secrets
from security.scan_secrets import (
    SecretMatch,
    is_false_positive,
    load_secretsignore,
    print_results,
    read_staged_blobs,
    scan_content,
)

FAKE_AWS_KEY = "AKIA" + "Q7ZXR4MW2PLK9VBN"
LEAK = f'AWS_ACCESS_KEY_ID = "{FAKE_AWS_KEY}"\n'


@pytest.fixture
def repo(temp_git_repo, monkeypatch):
    monkeypatch.chdir(temp_git_repo)
    return temp_git_repo


def _main(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["scan_secrets.py", *argv])
    return scan_secrets.main()


def test_staged_leak_blocks_and_the_value_is_never_printed(repo, monkeypatch, capsys):
    (repo / "keys.py").write_text(LEAK, encoding="utf-8")
    subprocess.run(["git", "add", "keys.py"], check=True)

    assert _main(monkeypatch) == 1

    out = capsys.readouterr().out
    assert "POTENTIAL SECRETS DETECTED!" in out
    assert "File: keys.py" in out
    assert "[REDACTED: secret value not displayed]" in out
    assert FAKE_AWS_KEY not in out


def test_nothing_staged(repo, monkeypatch, capsys):
    assert _main(monkeypatch) == 0
    assert "No files to scan." in capsys.readouterr().out
    assert _main(monkeypatch, "--quiet") == 0
    assert capsys.readouterr().out == ""


def test_all_tracked_files_as_json(repo, monkeypatch, capsys):
    (repo / "keys.py").write_text(LEAK, encoding="utf-8")
    (repo / "ok.py").write_text("x = 1\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], check=True)

    assert _main(monkeypatch, "--all-files", "--json") == 1

    report = json.loads(capsys.readouterr().out)
    assert report["secrets_found"] is True
    assert report["count"] == 1
    assert report["matches"][0]["file"] == "keys.py"
    assert report["matches"][0]["preview"] == "[REDACTED]"


def test_a_path_inside_the_project(repo, monkeypatch, capsys):
    (repo / "src" / "deep").mkdir(parents=True)
    (repo / "src" / "deep" / "keys.py").write_text(LEAK, encoding="utf-8")
    (repo / "src" / "clean.py").write_text("x = 1\n", encoding="utf-8")

    assert _main(monkeypatch, "--path", "src") == 1
    assert "File: src/deep/keys.py" in capsys.readouterr().out
    assert _main(monkeypatch, "--path", "src/clean.py", "--quiet") == 0
    assert _main(monkeypatch, "--path", "src/clean.py") == 0
    assert "No secrets detected. Commit allowed." in capsys.readouterr().out


def test_a_path_outside_the_project_or_missing_is_an_error(repo, monkeypatch, capsys):
    assert _main(monkeypatch, "--path", "..") == 2
    assert "Path outside the project" in capsys.readouterr().err
    assert _main(monkeypatch, "--path", "nope") == 2
    assert "Path not found" in capsys.readouterr().err


def test_secretsignore(tmp_path):
    assert load_secretsignore(tmp_path) == []
    (tmp_path / ".secretsignore").write_text(
        "# comment\n\n^fixtures/\n", encoding="utf-8"
    )
    assert load_secretsignore(tmp_path) == ["^fixtures/"]


def test_an_unreadable_secretsignore_ignores_nothing(tmp_path):
    (tmp_path / ".secretsignore").mkdir()
    assert load_secretsignore(tmp_path) == []


def test_false_positive_shapes():
    assert is_false_positive("api_key: str", "api_key") is True
    assert is_false_positive("# token = abc", "token = abc") is True
    assert is_false_positive("# " + "k" * 45, "k" * 45) is False
    assert is_false_positive("key = os.environ['KEY']", "x") is True


def test_a_bad_pattern_is_skipped(monkeypatch):
    monkeypatch.setattr(
        scan_secrets, "ALL_PATTERNS", [("(", "broken"), (r"AKIA[0-9A-Z]{16}", "aws")]
    )
    [match] = scan_content(LEAK, "a.py")
    assert match.pattern_name == "aws"


def test_staged_blobs_edge_cases(repo):
    assert read_staged_blobs([], repo) == {}
    assert read_staged_blobs(["bad\nname"], repo) == {}
    (repo / "a.py").write_text("one\n", encoding="utf-8")
    subprocess.run(["git", "add", "a.py"], check=True)
    assert read_staged_blobs(["a.py", "missing.py"], repo) == {"a.py": "one\n"}


def test_staged_blobs_outside_git(tmp_path):
    assert read_staged_blobs(["a.py"], tmp_path / "missing") == {}


def test_print_results_groups_by_file(capsys):
    print_results(
        [
            SecretMatch("a.py", 1, "aws", "x", "x"),
            SecretMatch("a.py", 4, "github", "y", "y"),
        ]
    )
    out = capsys.readouterr().out
    assert out.count("File: a.py") == 1
    assert "Line 4: [github]" in out
