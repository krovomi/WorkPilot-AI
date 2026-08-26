"""Tests for the two things every `*/api.py` hands to, or takes from, a caller.

These lock in the properties that made 132 of the 141 code-scanning alerts,
so that undoing one is a test failure rather than a scan result three days
later:

* an exception's text never reaches a caller (`py/stack-trace-exposure`);
* a caller-supplied path is normalised, capped and refused a `..`
  (`py/path-injection`), and confined when a real root exists.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from core.api_safety import MAX_PATH_LEN, safe_error, validated_dir  # noqa: E402


class TestSafeError:
    """The message a caller reads is chosen here, never quoted from `exc`."""

    @pytest.mark.parametrize(
        ("exc", "expected"),
        [
            (ValueError("/srv/secrets/db.sqlite is corrupt"), "Invalid input"),
            (KeyError("api_token"), "Missing required field"),
            (FileNotFoundError("/home/alice/.ssh/id_rsa"), "Resource not found"),
            (PermissionError("/etc/shadow"), "Permission denied"),
            (TimeoutError("upstream 10.0.0.4:5432"), "Request timed out"),
            (ConnectionError("refused"), "Connection failed"),
            (OSError("ENOSPC"), "System error"),
        ],
    )
    def test_known_types_map_to_a_fixed_message(self, exc, expected):
        assert safe_error(exc) == expected

    def test_an_unknown_type_falls_back(self):
        class Weird(Exception):
            pass

        assert safe_error(Weird("boom")) == "An unexpected error occurred"

    def test_no_returned_message_contains_the_exception_text(self):
        """The property that matters, stated directly.

        A mapping by type cannot leak, but someone may later be tempted to
        append `str(exc)` "just for the unknown case".
        """
        secret = "s3cret-/var/lib/vault/token"
        for exc in (
            ValueError(secret),
            KeyError(secret),
            RuntimeError(secret),
            OSError(secret),
        ):
            assert secret not in safe_error(exc)

    def test_the_detail_reaches_the_log(self, caplog):
        log = logging.getLogger("test_api_safety")
        with caplog.at_level(logging.ERROR, logger="test_api_safety"):
            safe_error(ValueError("the real reason"), log, "loading")
        assert "the real reason" in caplog.text
        assert "loading" in caplog.text

    def test_it_does_not_require_a_logger(self):
        assert safe_error(ValueError("x")) == "Invalid input"


class TestValidatedDir:
    def test_it_returns_a_resolved_directory(self, tmp_path):
        assert validated_dir(str(tmp_path), "project_dir") == tmp_path.resolve()

    def test_a_project_outside_this_repository_is_accepted(self, tmp_path):
        """The regression that shipped once and must not come back.

        WorkPilot builds *other people's* projects, so a project directory is
        outside this repository by definition.
        """
        assert not tmp_path.resolve().is_relative_to(REPO_ROOT.resolve())
        assert validated_dir(str(tmp_path), "project_dir") == tmp_path.resolve()

    @pytest.mark.parametrize("raw", ["", "   ", "-rf", "--output"])
    def test_empty_or_option_lookalikes_are_refused(self, raw):
        with pytest.raises(ValueError, match="non-empty"):
            validated_dir(raw, "project_dir")

    def test_a_path_carrying_dot_dot_is_refused(self, tmp_path):
        """Not a behaviour change — a barrier CodeQL is able to see.

        `resolve()` normalises `..` away, so this refuses nothing that would
        otherwise have been reachable. It is asserted because the guard is
        load-bearing for a different reason: `ConstCompareAsSanitizerGuard`
        is what keeps `py/path-injection` off every module that calls this,
        and `is_relative_to` — which the allowlist below uses — CodeQL does
        not recognise at all.
        """
        with pytest.raises(ValueError, match=r"\.\."):
            validated_dir(f"{tmp_path}/../..", "project_dir")

    def test_an_overlong_path_is_refused_before_it_is_walked(self):
        with pytest.raises(ValueError, match="longer than"):
            validated_dir("/" + "a" * (MAX_PATH_LEN + 1), "project_dir")

    def test_a_missing_directory_is_refused(self, tmp_path):
        with pytest.raises(ValueError, match="does not exist"):
            validated_dir(str(tmp_path / "nope"), "project_dir")

    def test_a_file_is_not_a_directory(self, tmp_path):
        f = tmp_path / "f.txt"
        f.write_text("x")
        with pytest.raises(ValueError, match="does not exist or is not a directory"):
            validated_dir(str(f), "project_dir")

    def test_must_exist_false_allows_a_path_yet_to_be_created(self, tmp_path):
        target = tmp_path / "not-yet"
        assert validated_dir(str(target), "d", must_exist=False) == target.resolve()

    def test_no_error_message_contains_the_resolved_path(self, tmp_path):
        """Half of stack-trace exposure was validators quoting the path back."""
        missing = tmp_path / "sekrit-dir-name"
        with pytest.raises(ValueError) as ei:
            validated_dir(str(missing), "project_dir")
        assert "sekrit-dir-name" not in str(ei.value)
        assert str(tmp_path) not in str(ei.value)


class TestAllowedRoots:
    def test_a_path_under_an_allowed_root_passes(self, tmp_path):
        child = tmp_path / "child"
        child.mkdir()
        assert (
            validated_dir(str(child), "d", allowed_roots=[tmp_path]) == child.resolve()
        )

    def test_the_root_itself_passes(self, tmp_path):
        assert (
            validated_dir(str(tmp_path), "d", allowed_roots=[tmp_path])
            == tmp_path.resolve()
        )

    def test_a_path_outside_every_root_is_refused(self, tmp_path):
        other = tmp_path.parent / f"{tmp_path.name}-elsewhere"
        other.mkdir()
        with pytest.raises(ValueError, match="outside every allowed root"):
            validated_dir(str(other), "d", allowed_roots=[tmp_path])

    def test_a_sibling_sharing_a_name_prefix_does_not_slip_through(self, tmp_path):
        """`/a/bc` must not count as being under `/a/b`.

        A `str.startswith` containment test gets this wrong; `is_relative_to`
        compares path components, which is why it is used here.
        """
        root = tmp_path / "b"
        root.mkdir()
        sibling = tmp_path / "bc"
        sibling.mkdir()
        with pytest.raises(ValueError, match="outside every allowed root"):
            validated_dir(str(sibling), "d", allowed_roots=[root])
