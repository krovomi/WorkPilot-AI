"""Helpers and types shared by the worktree manager and its PR mixin.

Split out of `core/worktree.py` (audit lot L11, F36), which re-exports every
name defined here.
"""

import logging
import os
import re
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TypedDict, TypeVar

# The name the monolith logged under (`core.worktree`), kept so logging
# configuration and log filters keyed on it still match.
logger = logging.getLogger(__name__.rpartition(".")[0] + ".worktree")


T = TypeVar("T")


# ── i18n helpers for PR / MR body fallback ────────────────────────────────


def _get_app_language() -> str:
    """Return the UI language configured by the frontend (``APP_LANGUAGE`` env var)."""
    return os.environ.get("APP_LANGUAGE", "en")


_WORKTREE_PR_STRINGS: dict[str, dict[str, str]] = {
    "en": {
        "fallback_footer": "Auto-generated PR from WorkPilot AI build.",
        "summary_section": "Summary",
        "checklist_section": "Review checklist",
        "check_standards": "Code follows project standards",
        "check_tests": "Tests pass (if applicable)",
        "check_docs": "Documentation is up to date",
        "check_coherent": "Changes are consistent with the task",
        "check_regression": "No regression detected",
        "warning": "This PR requires human validation before merge.",
        "footer": "PR created automatically by WorkPilot AI",
    },
    "fr": {
        "fallback_footer": "PR générée automatiquement par WorkPilot AI.",
        "summary_section": "Résumé",
        "checklist_section": "Checklist de vérification",
        "check_standards": "Le code respecte les standards du projet",
        "check_tests": "Les tests passent (si applicables)",
        "check_docs": "La documentation est à jour",
        "check_coherent": "Les changements sont cohérents avec la tâche",
        "check_regression": "Aucune régression détectée",
        "warning": "Cette PR nécessite une validation humaine avant merge.",
        "footer": "PR créée automatiquement par WorkPilot AI",
    },
}


def _wt(key: str) -> str:
    """Return a translated worktree PR string for the current app language."""
    lang = _get_app_language()
    strings = _WORKTREE_PR_STRINGS.get(lang, _WORKTREE_PR_STRINGS["en"])
    return strings.get(key, _WORKTREE_PR_STRINGS["en"].get(key, key))


def _is_retryable_network_error(stderr: str) -> bool:
    """Check if an error is a retryable network/connection issue."""
    stderr_lower = stderr.lower()
    return any(
        term in stderr_lower
        for term in ["connection", "network", "timeout", "reset", "refused"]
    )


def _is_retryable_http_error(stderr: str) -> bool:
    """
    Check if an HTTP error is retryable (5xx errors, timeouts).
    Excludes auth errors (401, 403) and client errors (404, 422).
    """
    stderr_lower = stderr.lower()
    # Check for HTTP 5xx errors (server errors are retryable)
    if re.search(r"http[s]?\s*5\d{2}", stderr_lower):
        return True
    # Check for HTTP timeout patterns
    if "http" in stderr_lower and "timeout" in stderr_lower:
        return True
    return False


# Fragments of `git worktree add` stderr that indicate a transient filesystem
# failure worth retrying. These show up mostly on Windows, where antivirus or
# the search indexer can briefly lock a just-created file during checkout.
_WORKTREE_ADD_TRANSIENT_TERMS = (
    "could not",
    "unable to",
    "permission denied",
    "access is denied",
    "used by another process",
    "cannot lock",
    "lock ref",
    "index.lock",
    "another git process",
    "file exists",
)


def _is_retryable_worktree_add_error(stderr: str) -> bool:
    """Whether a failed ``git worktree add`` looks transient and worth retrying.

    On Windows CI, ``git worktree add`` intermittently exits non-zero while
    writing *nothing* to stderr -- a just-created file is momentarily locked by
    antivirus/indexing during checkout. An empty/whitespace stderr is therefore
    treated as retryable, alongside the known file-locking messages above.
    """
    text = stderr.strip().lower()
    if not text:
        return True
    return any(term in text for term in _WORKTREE_ADD_TRANSIENT_TERMS)


# Windows NTSTATUS exit codes meaning the git process FAILED TO START (not a
# git error): the loaded GitHub runner couldn't initialize the child process.
# These conditions persist for tens of seconds, so the normal lock-retry
# schedule (~7.5s total) times out before the runner recovers — they get a
# slower, longer backoff schedule instead.
_WINDOWS_SPAWN_FAILURE_EXIT_CODES = frozenset(
    {
        3221225794,  # 0xC0000142 STATUS_DLL_INIT_FAILED
        3221225786,  # 0xC000013A STATUS_CONTROL_C_EXIT (host tearing processes down)
        3221225781,  # 0xC0000135 STATUS_DLL_NOT_FOUND
    }
)


def _with_retry(
    operation: Callable[[], tuple[bool, T | None, str]],
    max_retries: int = 3,
    is_retryable: Callable[[str], bool] | None = None,
    on_retry: Callable[[int, str], None] | None = None,
) -> tuple[T | None, str]:
    """
    Execute an operation with retry logic.

    Args:
        operation: Function that returns a tuple of (success: bool, result: T | None, error: str).
                   On success (success=True), result contains the value and error is empty.
                   On failure (success=False), result is None and error contains the message.
        max_retries: Maximum number of retry attempts
        is_retryable: Function to check if error is retryable based on error message
        on_retry: Optional callback called before each retry with (attempt, error)

    Returns:
        Tuple of (result, last_error) where result is T on success, None on failure
    """
    last_error = ""

    for attempt in range(1, max_retries + 1):
        try:
            success, result, error = operation()
            if success:
                return result, ""

            last_error = error

            # Check if error is retryable
            if is_retryable and attempt < max_retries and is_retryable(error):
                if on_retry:
                    on_retry(attempt, error)
                backoff = 2 ** (attempt - 1)
                time.sleep(backoff)
                continue

            break

        except subprocess.TimeoutExpired:
            last_error = "Operation timed out"
            if attempt < max_retries:
                if on_retry:
                    on_retry(attempt, last_error)
                backoff = 2 ** (attempt - 1)
                time.sleep(backoff)
                continue
            break

    return None, last_error


class PushBranchResult(TypedDict, total=False):
    """Result of pushing a branch to remote."""

    success: bool
    branch: str
    remote: str
    error: str


class PullRequestResult(TypedDict, total=False):
    """Result of creating a pull request."""

    success: bool
    pr_url: str | None  # None when PR was created but URL couldn't be extracted
    already_exists: bool
    error: str
    message: str


class PushAndCreatePRResult(TypedDict, total=False):
    """Result of push_and_create_pr operation."""

    success: bool
    pushed: bool
    remote: str
    branch: str
    provider: str  # 'github', 'gitlab', or 'unknown'
    pr_url: str | None  # None when PR was created but URL couldn't be extracted
    already_exists: bool
    error: str
    message: str
    cross_review_blocked: bool  # held back by a cross review that disagrees


class WorktreeError(Exception):
    """Error during worktree operations."""

    pass


@dataclass
class WorktreeInfo:
    """Information about a spec's worktree."""

    path: Path
    branch: str
    spec_name: str
    base_branch: str
    is_active: bool = True
    commit_count: int = 0
    files_changed: int = 0
    additions: int = 0
    deletions: int = 0
    last_commit_date: datetime | None = None
    days_since_last_commit: int | None = None
