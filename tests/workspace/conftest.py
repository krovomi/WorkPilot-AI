"""Fixtures shared by the workspace tests."""

import subprocess

import pytest


@pytest.fixture
def isolated_repo(temp_git_repo, tmp_path, monkeypatch):
    """The shared test repository, with git reading neither the machine's
    configuration nor the user's.

    The shared fixture stages its README under the machine's configuration:
    on Git for Windows that is ``core.autocrlf=true``, so the file is CRLF on
    disk and LF in the index. Without that configuration the file reads as
    modified, and the workspace treats the repository as holding unsaved
    work. It is checked out again as the index holds it.
    """
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "no-global-gitconfig"))
    subprocess.run(
        ["git", "reset", "-q", "--hard"],
        cwd=temp_git_repo,
        check=True,
        capture_output=True,
    )
    return temp_git_repo
