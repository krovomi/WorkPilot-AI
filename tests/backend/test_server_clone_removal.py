"""A server clone is deleted with its project, even where read-only files
resist (a git checkout on Windows).

On Windows, deleting a server project left its whole clone on disk: git
writes its objects read-only, Windows refuses to delete such a file, and
``rmtree(ignore_errors=True)`` said nothing.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest
import server.services.repos as repos
from server.services.repos import remove_tree


def _refuse_read_only_files(monkeypatch) -> None:
    """Delete files the way Windows does: a read-only one is refused."""
    real_unlink = os.unlink

    def windows_unlink(path, *, dir_fd=None):
        mode = os.stat(path, dir_fd=dir_fd, follow_symlinks=False).st_mode
        if not mode & stat.S_IWRITE:
            raise PermissionError(13, "Access is denied", str(path))
        return real_unlink(path, dir_fd=dir_fd)

    monkeypatch.setattr(repos.os, "unlink", windows_unlink)


def _checkout(root: Path) -> Path:
    objects = root / ".git" / "objects" / "ab"
    objects.mkdir(parents=True)
    blob = objects / "cdef"
    blob.write_bytes(b"blob")
    blob.chmod(stat.S_IREAD)
    (root / "app.py").write_text("print('hi')\n", encoding="utf-8")
    return root


def test_a_checkout_with_read_only_objects_is_deleted(tmp_path: Path, monkeypatch):
    clone = _checkout(tmp_path / "clone")
    _refuse_read_only_files(monkeypatch)

    remove_tree(clone)

    assert not clone.exists()


def test_what_still_cannot_be_deleted_is_raised(tmp_path: Path, monkeypatch):
    clone = _checkout(tmp_path / "clone")

    def refuse(*_a, **_k):
        raise PermissionError(13, "Access is denied")

    monkeypatch.setattr(repos.os, "unlink", refuse)

    with pytest.raises(PermissionError):
        remove_tree(clone)
    assert clone.exists()


def test_a_link_is_removed_not_followed(tmp_path: Path):
    target = tmp_path / "kept"
    target.mkdir()
    (target / "file.txt").write_text("x", encoding="utf-8")
    link = tmp_path / "link"
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError:
        pytest.skip("this machine cannot create a symbolic link")

    remove_tree(link)

    assert not link.exists() and (target / "file.txt").is_file()


def test_a_missing_folder_is_nothing_to_do(tmp_path: Path):
    remove_tree(tmp_path / "never-there")
