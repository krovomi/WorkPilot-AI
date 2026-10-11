"""Which directories `storage_dir` may name, and what a refusal says.

The regression these guard: `_allowed_storage_roots` used to fall back to the
backend's working directory, which the desktop app sets to `apps/backend`.
Every trail is written to `<project_dir>/.workpilot/audit-trail` inside the
user's own checkout, so the Audit Trail panel could reach no directory any
trail is ever written to — and the refusal read "Invalid input".
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from audit_trail.api import (
    STORAGE_DIR_REFUSED,
    StorageDirRefused,
    _allowed_storage_roots,
    _error,
    _validate_dir,
)


@pytest.fixture(autouse=True)
def _no_inherited_roots(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AUDIT_TRAIL_ALLOWED_ROOTS", raising=False)


class TestAllowedRoots:
    def test_env_var_wins(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setenv("AUDIT_TRAIL_ALLOWED_ROOTS", str(tmp_path))
        assert _allowed_storage_roots() == [tmp_path.resolve()]

    def test_env_var_takes_several_roots(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        a, b = tmp_path / "a", tmp_path / "b"
        monkeypatch.setenv("AUDIT_TRAIL_ALLOWED_ROOTS", f"{a}{os.pathsep}{b}")
        assert _allowed_storage_roots() == [a.resolve(), b.resolve()]

    def test_local_mode_is_unconfined(self) -> None:
        """No env var and no server mode — `validated_dir` normalises only.

        The working-directory fallback this replaces admitted exactly one
        subtree, and nothing writes a trail there.
        """
        assert _allowed_storage_roots() is None


class TestValidateDir:
    def test_accepts_a_project_trail_directory(self, tmp_path: Path) -> None:
        """The path the panel now opens on, well outside the backend's cwd."""
        trail = tmp_path / "some-project" / ".workpilot" / "audit-trail"
        assert _validate_dir(str(trail)) == trail.resolve()
        assert trail.is_dir()  # created on demand, as the endpoints expect

    def test_refusal_says_why_and_how_to_fix_it(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """`safe_error` flattens this to "Invalid input"; the user cannot act on that."""
        monkeypatch.setenv("AUDIT_TRAIL_ALLOWED_ROOTS", str(tmp_path / "allowed"))
        with pytest.raises(StorageDirRefused) as excinfo:
            _validate_dir(str(tmp_path / "elsewhere"))
        message = str(excinfo.value)
        assert "AUDIT_TRAIL_ALLOWED_ROOTS" in message
        # The roots are server configuration — named to the operator's log,
        # never to the caller.
        assert str(tmp_path) not in message

    def test_other_refusals_are_not_dressed_up_as_containment(self) -> None:
        """A `..` or an empty path is still an ordinary ValueError."""
        for bad in ("", "   ", "../escape"):
            with pytest.raises(ValueError) as excinfo:
                _validate_dir(bad)
            assert not isinstance(excinfo.value, StorageDirRefused)


class TestErrorMessages:
    """What reaches the caller. Both arms must be fixed strings.

    `safe_error` is a barrier because it returns constants. An earlier version
    of `_error` returned `str(e)` for the refusal, which put exception data on
    the response path and raised `py/stack-trace-exposure` at every handler in
    this module.
    """

    def test_refusal_returns_the_constant_not_the_exception(self) -> None:
        assert _error(StorageDirRefused("anything at all"), "events") == (
            STORAGE_DIR_REFUSED
        )

    def test_the_constant_is_actionable(self) -> None:
        assert "AUDIT_TRAIL_ALLOWED_ROOTS" in STORAGE_DIR_REFUSED

    def test_every_other_exception_is_still_flattened(self) -> None:
        """A path the caller cannot act on must not describe itself."""
        secret = "/srv/tenant-42/private/db.sqlite is locked"
        assert secret not in _error(RuntimeError(secret), "events")
        assert secret not in _error(ValueError(secret), "events")
