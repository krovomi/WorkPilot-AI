"""Server-side repository clones.

In server mode the server owns one clone per registered project, under
``REPOS_ROOT/{project_id}/``. Agents and worktrees operate on that clone
exactly as they do on a local repo in single-user mode.

Git authentication is the server's responsibility (SSH deploy key or a
credential helper configured for the service account running the backend).
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import stat
from pathlib import Path

from server.config import get_settings

logger = logging.getLogger(__name__)


class RepoError(RuntimeError):
    pass


def project_clone_path(project_id: str) -> Path:
    return get_settings().repos_root / project_id


async def _run_git(
    args: list[str], cwd: Path | None = None, timeout: float = 600
) -> str:
    proc = await asyncio.create_subprocess_exec(
        "git",
        *args,
        cwd=str(cwd) if cwd else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        raise RepoError(f"git {' '.join(args[:2])} timed out after {timeout}s")
    if proc.returncode != 0:
        # stderr may contain the remote URL but never credentials (we don't
        # accept URL-embedded credentials, see clone_project).
        raise RepoError(
            f"git {' '.join(args[:2])} failed (exit {proc.returncode}): "
            f"{stderr.decode(errors='replace')[:500]}"
        )
    return stdout.decode(errors="replace")


def _validate_repo_url(repo_url: str) -> None:
    url = repo_url.strip()
    if "@" in url.split("://", 1)[-1].split("/", 1)[0] and url.startswith(
        ("http://", "https://")
    ):
        # https://user:pat@host/... would persist the credential in
        # .git/config of a shared server — refuse it.
        raise RepoError(
            "Credentials embedded in the repo URL are not allowed. "
            "Configure a git credential helper or SSH key for the server instead."
        )
    if not (url.startswith(("https://", "http://", "ssh://", "git@"))):
        raise RepoError(f"Unsupported repo URL scheme: {url[:80]}")


async def clone_project(project_id: str, repo_url: str, default_branch: str) -> Path:
    """Clone the repo for a newly registered project. Idempotent-ish:
    refuses to overwrite an existing non-empty directory."""
    _validate_repo_url(repo_url)
    dest = project_clone_path(project_id)
    if dest.exists() and any(dest.iterdir()):
        raise RepoError(f"Clone destination already exists: {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    logger.info("Cloning %s into %s", repo_url, dest)
    await _run_git(["clone", "--branch", default_branch, repo_url, str(dest)])
    return dest


async def fetch_project(server_path: str) -> None:
    """Refresh remote refs for an existing clone."""
    await _run_git(["fetch", "--all", "--prune"], cwd=Path(server_path), timeout=300)


def _make_writable_and_retry(function, path: str, _error: BaseException) -> None:
    # Git writes its objects read-only, and Windows refuses to delete a
    # read-only file: lift the flag and try once more.
    os.chmod(path, stat.S_IWRITE)
    function(path)


def remove_tree(path: Path) -> None:
    """Delete ``path`` and everything under it, a git checkout included.

    A link is removed, not followed. Raises if something still cannot be
    deleted, so a caller never takes a folder for gone that is still there.
    """
    if path.is_symlink():
        path.unlink()
        return
    if not path.exists():
        return
    shutil.rmtree(path, onexc=_make_writable_and_retry)


def delete_clone(project_id: str) -> None:
    """Delete the clone and the home its runs kept (build memory, caches)."""
    from server.services.run_isolation import project_home

    # Not `rmtree(ignore_errors=True)`: on Windows that left the whole clone
    # behind, because git's objects are read-only there. The project's rows
    # are already gone, so what still cannot be deleted is logged, not raised.
    for folder in (
        project_clone_path(project_id),
        project_home(get_settings().repos_root, project_id),
    ):
        if not folder.exists() and not folder.is_symlink():
            continue
        try:
            remove_tree(folder)
        except OSError as exc:
            logger.warning("Could not delete %s: %s", folder, exc)
        else:
            logger.info("Deleted %s", folder)
