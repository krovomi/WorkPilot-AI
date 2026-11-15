"""The edges of the guards: empty input, a dependency that fails, a path that
will not resolve. Each one answers the way its module promises."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from security import path_guard, profile, untrusted
from security.command_guard import validate_command_line
from security.content_sanitizer import ContentSanitizer
from security.filesystem_validators import validate_rm_command
from security.git_validators import validate_git_command, validate_git_commit_secrets
from security.parser import (
    extract_commands,
    split_command_segments,
    unwrap_rtk_prefixes,
)
from security.path_guard import make_write_path_hook, protected_config_refusal
from security.process_validators import validate_pkill_command
from security.profile import get_security_profile, resolve_active_profile
from security.scan_secrets import get_staged_files, read_staged_blobs, scan_files
from security.validator_registry import get_validator

# ── content_sanitizer ───────────────────────────────────────────────────────


def test_sanitizer_empty_and_truncated():
    sanitizer = ContentSanitizer(max_comment=10)
    assert sanitizer.sanitize("").content == ""

    result = sanitizer.sanitize("x" * 25, content_type="comment")
    assert (result.content, result.was_truncated, result.original_length) == (
        "x" * 10,
        True,
        25,
    )
    assert result.warnings == ["Content truncated from 25 to 10 chars"]


def test_wrap_sanitizes_first_unless_told_not_to():
    sanitizer = ContentSanitizer()
    wrapped = sanitizer.wrap_user_content("<!-- hidden -->hello", max_length=3)
    assert wrapped == "<user_content>\nhel\n</user_content>"
    raw = sanitizer.wrap_user_content("<!-- kept -->", sanitize_first=False)
    assert "<!-- kept -->" in raw


# ── untrusted ───────────────────────────────────────────────────────────────


def test_untrusted_survives_a_broken_sanitizer_and_scanner(monkeypatch):
    import injection_guard
    import security.content_sanitizer as cs

    def broken():
        raise RuntimeError("no sanitizer")

    monkeypatch.setattr(cs, "get_sanitizer", broken)
    monkeypatch.setattr(injection_guard, "get_default_scanner", broken)

    cleaned = untrusted.clean_untrusted("<!-- x -->text", kind="comment")

    assert cleaned.text == "<!-- x -->text"
    assert cleaned.threat_level == ""
    assert untrusted.quote_untrusted("plain") == "plain"


def test_untrusted_survives_a_sanitizer_that_raises_mid_way(monkeypatch):
    class Raising:
        def sanitize(self, *_a, **_k):
            raise ValueError("bad")

        def wrap_user_content(self, *_a, **_k):
            raise ValueError("bad")

    monkeypatch.setattr(untrusted, "_sanitizer", lambda: Raising())

    assert untrusted.clean_untrusted("body").text == "body"
    assert untrusted.quote_untrusted("body") == "body"


# ── command_guard ───────────────────────────────────────────────────────────


def _base_profile(tmp_path):
    return get_security_profile(tmp_path)


@pytest.mark.parametrize(
    ("command", "allowed", "reason"),
    [
        ("eval", True, ""),
        ('eval "unclosed', False, "Could not read the command inside eval"),
        ("find . -exec", True, ""),
        (
            'find . -exec "unclosed',
            False,
            "Could not read the command inside find -exec",
        ),
    ],
)
def test_an_unreadable_eval_or_find_exec_is_refused(tmp_path, command, allowed, reason):
    ok, why = validate_command_line(command, _base_profile(tmp_path))
    assert ok is allowed
    assert why.startswith(reason)


# ── profile ─────────────────────────────────────────────────────────────────


def test_an_unloadable_profile_resolves_to_none(monkeypatch):
    def broken(_path):
        raise OSError("unreadable")

    monkeypatch.setattr(profile, "get_security_profile", broken)
    assert resolve_active_profile() is None


# ── path_guard ──────────────────────────────────────────────────────────────


def test_the_human_input_file_is_refused_with_its_own_reason(tmp_path):
    reason = protected_config_refusal("HUMAN_INPUT.md", tmp_path)
    assert reason.startswith(
        "Refusing to write 'HUMAN_INPUT.md': it holds the person's"
    )


def test_a_path_that_will_not_resolve_is_outside_every_root(tmp_path, monkeypatch):
    def unresolvable(self, *args, **kwargs):
        raise RuntimeError("symlink loop")

    monkeypatch.setattr(path_guard.Path, "resolve", unresolvable)
    assert path_guard._resolved(tmp_path) is None
    assert path_guard.is_within_roots("a.py", [tmp_path], None) is False


async def test_the_write_hook_leaves_malformed_and_pathless_calls_alone(tmp_path):
    hook = make_write_path_hook(tmp_path)
    assert await hook({"tool_name": "Write", "tool_input": "not a dict"}) == {}
    assert await hook({"tool_name": "Write", "tool_input": {"content": "x"}}) == {}
    assert await hook({"tool_name": "Write", "tool_input": {"file_path": "  "}}) == {}


# ── validators: empty and unparsable commands ───────────────────────────────


def test_empty_commands_are_refused():
    assert validate_rm_command("")[0] is False
    assert validate_pkill_command("")[0] is False


def test_git_command_edges(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert validate_git_command('git commit -m "unclosed')[0] is False
    assert validate_git_command("ls -la") == (True, "")
    assert validate_git_command("git") == (True, "")
    assert validate_git_command("git --no-pager") == (True, "")
    assert validate_git_command("git config --list") == (True, "")
    assert validate_git_commit_secrets('git commit "unclosed')[0] is False
    assert validate_git_commit_secrets("ls") == (True, "")
    assert validate_git_commit_secrets("git status") == (True, "")


def test_registry_lookup():
    assert get_validator("rm") is validate_rm_command
    assert get_validator("ls") is None


# ── parser ──────────────────────────────────────────────────────────────────


def test_parser_skips_empty_segments_and_keywords():
    assert extract_commands("ls ;; ; pwd") == ["ls", "pwd"]
    assert extract_commands("if true; then ls; fi") == ["true", "ls"]
    assert extract_commands("make 2>&1") == ["make"]
    assert split_command_segments("ls && ") == ["ls"]


def test_rtk_unwrap_without_the_rtk_module(monkeypatch):
    import builtins

    real = builtins.__import__

    def no_rtk(name, *args, **kwargs):
        if name.startswith("rtk"):
            raise ImportError(name)
        return real(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_rtk)
    assert unwrap_rtk_prefixes("rtk git status") == "rtk git status"


# ── scan_secrets ────────────────────────────────────────────────────────────


def test_staged_files_where_git_cannot_run(tmp_path):
    assert get_staged_files(tmp_path / "missing") == []


def test_scan_files_defaults_to_the_current_folder(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "a.py").write_text("x = 1\n", encoding="utf-8")
    (tmp_path / "dir").mkdir()
    assert scan_files(["a.py", "dir", "missing.py"]) == []


def test_scan_files_skips_an_unreadable_file(tmp_path, monkeypatch):
    (tmp_path / "a.py").write_text("x\n", encoding="utf-8")
    real = Path.read_text

    def read_text(self, *args, **kwargs):
        if self.name == "a.py":
            raise PermissionError(self)
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)
    assert scan_files(["a.py"], tmp_path) == []


def test_staged_blobs_stop_at_a_short_answer(monkeypatch, tmp_path):
    def short(*_a, **_k):
        return subprocess.CompletedProcess([], 0, b"abc blob 3\nabc", b"")

    monkeypatch.setattr(subprocess, "run", short)
    assert read_staged_blobs(["a.py", "b.py"], tmp_path) == {"a.py": "abc"}


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ("git config user.email x@y", False),
        ("git -C . config user.email x@y", False),
        ("git --git-dir=.git config user.name Bot", False),
        ("git config -f .git/config user.email x@y", False),
        ("git config --file=.git/config core.editor vim", False),
        ("git config set user.email x@y", False),
        ("git config --global set core.pager less", False),
        ("git config unset user.name", False),
        ("git config get user.email", True),
        ("git config list", True),
        ("git -C . config --get user.email", True),
        ("git config --type bool core.autocrlf false", True),
        ("git config pull.rebase true", True),
    ],
)
def test_git_config_finds_the_key_wherever_it_is(command, allowed):
    assert validate_git_command(command)[0] is allowed, command
