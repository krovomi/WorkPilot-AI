#!/usr/bin/env python3
"""
Git Worktree Manager - Per-Spec Architecture
=============================================

Each spec gets its own worktree:
- Worktree path: .workpilot/worktrees/tasks/{spec-name}/
- Branch name: workpilot/{spec-name}

This allows:
1. Multiple specs to be worked on simultaneously
2. Each spec's changes are isolated
3. Branches persist until explicitly merged
4. Clear 1:1:1 mapping: spec → worktree → branch
"""

import asyncio
import logging
import os
import re
import shutil
import subprocess
import time
import unicodedata
from datetime import datetime
from pathlib import Path

from core.build_artifacts import ensure_artifact_excludes, strip_committed_artifacts

# Helpers and types live in `core.worktree_common`, the PR half in
# `core.worktree_pr` (audit lot L11, F36). Every name is imported back so the
# module keeps its surface.
from core.worktree_common import (  # noqa: F401
    _WINDOWS_SPAWN_FAILURE_EXIT_CODES,
    _WORKTREE_ADD_TRANSIENT_TERMS,
    _WORKTREE_PR_STRINGS,
    PullRequestResult,
    PushAndCreatePRResult,
    PushBranchResult,
    T,
    WorktreeError,
    WorktreeInfo,
    _get_app_language,
    _is_retryable_http_error,
    _is_retryable_network_error,
    _is_retryable_worktree_add_error,
    _with_retry,
    _wt,
)
from core.worktree_pr import WorktreePRMixin
from foundation.debug import debug_warning
from foundation.git_executable import run_git

logger = logging.getLogger(__name__)


class WorktreeManager(WorktreePRMixin):
    """
    Manages per-spec Git worktrees.

    Each spec gets its own worktree in .workpilot/worktrees/tasks/{spec-name}/ with
    a corresponding branch workpilot/{spec-name}.
    """

    # Timeout constants for subprocess operations
    GIT_PUSH_TIMEOUT = 120  # 2 minutes for git push (network operations)
    CLI_TIMEOUT = 60  # 1 minute for CLI commands (gh/glab)
    CLI_QUERY_TIMEOUT = 30  # 30 seconds for CLI queries (gh/glab)

    def __init__(
        self,
        project_dir: Path,
        base_branch: str | None = None,
        use_local_branch: bool = False,
    ):
        self.project_dir = project_dir
        self.base_branch = base_branch or self._detect_base_branch()
        self.use_local_branch = use_local_branch
        self.worktrees_dir = project_dir / ".workpilot" / "worktrees" / "tasks"
        self._merge_lock = asyncio.Lock()

    def _detect_base_branch(self) -> str:
        """
        Detect the base branch for worktree creation.

        Priority order:
        1. DEFAULT_BRANCH environment variable
        2. Auto-detect main/master (if they exist)
        3. Fall back to current branch (with warning)

        Returns:
            The detected base branch name
        """
        # 1. Check for DEFAULT_BRANCH env var
        env_branch = os.getenv("DEFAULT_BRANCH")
        if env_branch:
            # Verify the branch exists
            result = run_git(
                ["rev-parse", "--verify", env_branch],
                cwd=self.project_dir,
            )
            if result.returncode == 0:
                return env_branch
            else:
                print(
                    f"Warning: DEFAULT_BRANCH '{env_branch}' not found, auto-detecting..."
                )

        # 2. Ask the remote what its default branch is. Source of truth for
        #    repos that don't use 'main'/'master' (GitFlow with 'develop',
        #    'trunk', 'production', etc.). Without this we silently fall
        #    through to the current branch and end up creating PRs against
        #    the wrong base.
        symref = run_git(
            ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
            cwd=self.project_dir,
        )
        if symref.returncode == 0:
            detected = symref.stdout.strip()
            if detected.startswith("origin/"):
                detected = detected[len("origin/") :]
            if detected:
                return detected

        # 3. Auto-detect usual default branches. 'develop' is included so
        #    GitFlow repos resolve without DEFAULT_BRANCH being set.
        for branch in ["main", "master", "develop"]:
            result = run_git(
                ["rev-parse", "--verify", branch],
                cwd=self.project_dir,
            )
            if result.returncode == 0:
                return branch

        # 4. Fall back to current branch with warning
        current = self._get_current_branch()
        print("Warning: Could not find 'main', 'master' or 'develop' branch.")
        print(f"Warning: Using current branch '{current}' as base for worktree.")
        print("Tip: Set DEFAULT_BRANCH=your-branch in .env to avoid this.")
        return current

    def _get_current_branch(self) -> str:
        """Get the current git branch."""
        result = run_git(
            ["rev-parse", "--abbrev-ref", "HEAD"],
            cwd=self.project_dir,
        )
        if result.returncode != 0:
            raise WorktreeError(f"Failed to get current branch: {result.stderr}")
        return result.stdout.strip()

    def _run_git(
        self, args: list[str], cwd: Path | None = None, timeout: int = 60
    ) -> subprocess.CompletedProcess:
        """Run a git command and return the result.

        Args:
            args: Git command arguments (without 'git' prefix)
            cwd: Working directory for the command
            timeout: Command timeout in seconds (default: 60)

        Returns:
            CompletedProcess with command results. On timeout, returns a
            CompletedProcess with returncode=-1 and timeout error in stderr.
        """
        return run_git(args, cwd=cwd or self.project_dir, timeout=timeout)

    def _unstage_gitignored_files(self) -> None:
        """
        Unstage any staged files that are gitignored in the current branch,
        plus any files in the .workpilot directory which should never be merged.

        This is needed after a --no-commit merge because files that exist in the
        source branch (like spec files in .workpilot/specs/) get staged even if
        they're gitignored in the target branch.
        """
        # Get list of staged files
        result = self._run_git(["diff", "--cached", "--name-only"])
        if result.returncode != 0 or not result.stdout.strip():
            return

        staged_files = result.stdout.strip().split("\n")

        # Files to unstage: gitignored files + .workpilot directory files
        files_to_unstage = set()

        # 1. Check which staged files are gitignored
        # git check-ignore returns the files that ARE ignored
        result = run_git(
            ["check-ignore", "--stdin"],
            cwd=self.project_dir,
            input_data="\n".join(staged_files),
        )

        if result.stdout.strip():
            for file in result.stdout.strip().split("\n"):
                if file.strip():
                    files_to_unstage.add(file.strip())

        # 2. Always unstage .workpilot directory files - these are project-specific
        # and should never be merged from the worktree branch
        workpilot_patterns = [".workpilot/", "workpilot/specs/"]
        for file in staged_files:
            file = file.strip()
            if not file:
                continue
            # Normalize path separators for cross-platform (Windows backslash support)
            normalized = file.replace("\\", "/")
            for pattern in workpilot_patterns:
                if normalized.startswith(pattern) or f"/{pattern}" in normalized:
                    files_to_unstage.add(file)
                    break

        if files_to_unstage:
            print(f"Unstaging {len(files_to_unstage)} workpilot/gitignored file(s)...")
            # Unstage each file
            for file in files_to_unstage:
                self._run_git(["reset", "HEAD", "--", file])

    def setup(self) -> None:
        """Create worktrees directory if needed."""
        self.worktrees_dir.mkdir(parents=True, exist_ok=True)

    # ==================== Per-Spec Worktree Methods ====================

    # Whitelist for spec_name. Allows letters, digits, dot, underscore, hyphen.
    # Rejects path separators, "..", null bytes, and anything that could escape
    # the worktree root or inject git ref-name metacharacters.
    _SPEC_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

    @staticmethod
    def _sanitize_spec_name(spec_name: str) -> str:
        """Map an accented/Unicode spec name to its ASCII-only equivalent.

        Why: legacy spec folders created before the slug fix retain accented
        names on disk (e.g. "002-limitation-du-numéro-de-tva-…"). The worktree
        path and git branch must be ASCII to satisfy the strict whitelist and
        avoid git ref-name issues. We strip diacritics via NFKD decomposition
        (é -> e) and drop any remaining non-ASCII codepoint. The result is then
        validated by the caller against ``_SPEC_NAME_RE``, so this NEVER relaxes
        the security checks: dangerous ASCII (path separators, "..", ref
        metacharacters) is untouched here and still rejected downstream.
        """
        normalized = unicodedata.normalize("NFKD", spec_name)
        return "".join(
            ch for ch in normalized if not unicodedata.combining(ch) and ch.isascii()
        )

    @classmethod
    def _validate_spec_name(cls, spec_name: str) -> str:
        """Validate spec_name to prevent path traversal and ref-name injection.

        Why: spec_name is interpolated into filesystem paths and git branch
        refs (workpilot/{spec_name}). An unvalidated value like "../../etc"
        or "foo/..bar" could escape the worktree root or break git plumbing.

        Accented characters are transliterated to ASCII first so that legacy
        spec folders (named before the slug fix) remain buildable; the
        transliterated value must still satisfy the strict whitelist.
        """
        if not isinstance(spec_name, str) or not spec_name:
            raise ValueError("spec_name must be a non-empty string")
        sanitized = cls._sanitize_spec_name(spec_name)
        if not cls._SPEC_NAME_RE.fullmatch(sanitized):
            raise ValueError(
                f"Invalid spec_name {spec_name!r}: must match "
                f"{cls._SPEC_NAME_RE.pattern}"
            )
        return sanitized

    def get_worktree_path(self, spec_name: str) -> Path:
        """Get the worktree path for a spec (checks new and legacy locations)."""
        spec_name = self._validate_spec_name(spec_name)

        # New path first (.workpilot/worktrees/tasks/)
        new_path = self.worktrees_dir / spec_name
        if new_path.exists():
            return new_path

        # Legacy fallback (.worktrees/ instead of .workpilot/worktrees/tasks/)
        legacy_path = self.project_dir / ".worktrees" / spec_name
        if legacy_path.exists():
            return legacy_path

        # Return new path as default for creation
        return new_path

    def get_branch_name(self, spec_name: str) -> str:
        """Get the branch name for a spec."""
        return f"workpilot/{self._validate_spec_name(spec_name)}"

    def worktree_exists(self, spec_name: str) -> bool:
        """Check if a worktree exists for a spec."""
        return self.get_worktree_path(spec_name).exists()

    def get_worktree_info(self, spec_name: str) -> WorktreeInfo | None:
        """Get info about a spec's worktree."""
        worktree_path = self.get_worktree_path(spec_name)
        if not worktree_path.exists():
            return None

        # Verify the branch exists in the worktree
        result = self._run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=worktree_path)
        if result.returncode != 0:
            return None

        actual_branch = result.stdout.strip()

        # Handle detached HEAD state: rev-parse --abbrev-ref returns literal "HEAD"
        # when the worktree is in detached HEAD (e.g. after rebase, merge conflict, etc.)
        # First try to resolve the branch from git's worktree registry, then fall back
        # to the expected branch name derived from the spec name.
        if actual_branch == "HEAD":
            registered_branch = self._get_worktree_registered_branch(worktree_path)
            if registered_branch:
                debug_warning(
                    "worktree",
                    f"Worktree '{spec_name}' is in detached HEAD state. "
                    f"Resolved branch from git worktree registry: {registered_branch}",
                )
                actual_branch = registered_branch
            else:
                expected_branch = self.get_branch_name(spec_name)
                debug_warning(
                    "worktree",
                    f"Worktree '{spec_name}' is in detached HEAD state. "
                    f"Using expected branch name: {expected_branch}",
                )
                actual_branch = expected_branch

        # Get statistics
        stats = self._get_worktree_stats(spec_name)

        return WorktreeInfo(
            path=worktree_path,
            branch=actual_branch,
            spec_name=spec_name,
            base_branch=self.base_branch,
            is_active=True,
            **stats,
        )

    def _get_worktree_registered_branch(self, worktree_path: Path) -> str | None:
        """
        Get the branch name for a worktree from git's worktree registry.

        Uses `git worktree list --porcelain` to find the branch associated with
        a worktree path. This works even when the worktree is in detached HEAD state,
        as git tracks the original branch association in its registry.

        Args:
            worktree_path: The path to the worktree directory.

        Returns:
            The branch name (without refs/heads/ prefix) if found, None otherwise.
        """
        result = self._run_git(["worktree", "list", "--porcelain"])
        if result.returncode != 0:
            return None

        resolved_path = worktree_path.resolve()

        # Parse porcelain output: entries are separated by blank lines,
        # each entry has "worktree <path>", "HEAD <sha>", "branch refs/heads/<name>"
        # (or "detached" instead of "branch" if truly detached in registry too)
        current_path = None
        for line in result.stdout.split("\n"):
            if line.startswith("worktree "):
                current_path = Path(line.split(" ", 1)[1])
            elif line.startswith("branch refs/heads/") and current_path is not None:
                try:
                    if current_path.exists() and resolved_path.exists():
                        if os.path.samefile(resolved_path, current_path):
                            return line[len("branch refs/heads/") :]
                except OSError:
                    pass
                # Fallback to normalized case comparison
                if os.path.normcase(str(resolved_path)) == os.path.normcase(
                    str(current_path)
                ):
                    return line[len("branch refs/heads/") :]
            elif line == "":
                current_path = None

        return None

    def _check_branch_namespace_conflict(self) -> str | None:
        """
        Check if a branch named 'workpilot' exists, which would block creating
        branches in the 'workpilot/*' namespace.

        Git stores branch refs as files under .git/refs/heads/, so a branch named
        'workpilot' creates a file that prevents creating the 'workpilot/'
        directory needed for 'workpilot/{spec-name}' branches.

        Returns:
            The conflicting branch name if found, None otherwise.
        """
        result = self._run_git(["rev-parse", "--verify", "workpilot"])
        if result.returncode == 0:
            return "workpilot"
        return None

    def _branch_exists(self, branch_name: str) -> bool:
        """
        Check if a local branch exists in the repository.

        Uses git show-ref to specifically check for local branches, avoiding
        false positives from tags or other refs with the same name.

        Args:
            branch_name: The name of the branch to check (e.g., 'workpilot/my-spec')

        Returns:
            True if the local branch exists, False otherwise.
        """
        result = self._run_git(["show-ref", "--verify", f"refs/heads/{branch_name}"])
        return result.returncode == 0

    def _worktree_is_registered(self, worktree_path: Path) -> bool:
        """
        Check if a worktree path is registered with git.

        This determines if git tracks the worktree even if the directory exists.
        Useful for detecting orphaned worktree directories that need cleanup.

        Args:
            worktree_path: The path to the worktree directory to check.

        Returns:
            True if the worktree is registered with git, False otherwise.
        """
        result = self._run_git(["worktree", "list", "--porcelain"])
        if result.returncode != 0:
            return False

        # Parse porcelain output to get registered worktree paths
        # Format: "worktree /path/to/worktree" for each worktree
        registered_paths = set()
        for line in result.stdout.split("\n"):
            if line.startswith("worktree "):
                parts = line.split(" ", 1)
                if len(parts) == 2:
                    registered_paths.add(Path(parts[1]))

        # Check if worktree_path matches any registered path
        # Use samefile() for accurate comparison on case-insensitive filesystems
        resolved_path = worktree_path.resolve()
        for registered_path in registered_paths:
            # Try samefile first (handles case-insensitivity and symlinks)
            try:
                if resolved_path.exists() and registered_path.exists():
                    if os.path.samefile(resolved_path, registered_path):
                        return True
            except OSError:
                pass
            # Fallback to normalized case comparison for non-existent paths
            if os.path.normcase(str(resolved_path)) == os.path.normcase(
                str(registered_path)
            ):
                return True
        return False

    def _get_worktree_stats(self, spec_name: str) -> dict:
        """Get diff statistics for a worktree."""
        worktree_path = self.get_worktree_path(spec_name)

        stats = {
            "commit_count": 0,
            "files_changed": 0,
            "additions": 0,
            "deletions": 0,
            "last_commit_date": None,
            "days_since_last_commit": None,
        }

        if not worktree_path.exists():
            return stats

        # Commit count
        result = self._run_git(
            ["rev-list", "--count", f"{self.base_branch}..HEAD"], cwd=worktree_path
        )
        if result.returncode == 0:
            stats["commit_count"] = int(result.stdout.strip() or "0")

        # Last commit date (most recent commit in this worktree)
        result = self._run_git(
            ["log", "-1", "--format=%cd", "--date=iso"], cwd=worktree_path
        )
        if result.returncode == 0 and result.stdout.strip():
            try:
                # Parse ISO date format: "2026-01-04 00:25:25 +0100"
                date_str = result.stdout.strip()
                # Convert git format to ISO format for fromisoformat()
                # "2026-01-04 00:25:25 +0100" -> "2026-01-04T00:25:25+01:00"
                parts = date_str.rsplit(" ", 1)
                if len(parts) == 2:
                    date_part, tz_part = parts
                    # Convert timezone format: "+0100" -> "+01:00"
                    if len(tz_part) == 5 and (
                        tz_part.startswith("+") or tz_part.startswith("-")
                    ):
                        tz_formatted = f"{tz_part[:3]}:{tz_part[3:]}"
                        iso_str = f"{date_part.replace(' ', 'T')}{tz_formatted}"
                        last_commit_date = datetime.fromisoformat(iso_str)
                        stats["last_commit_date"] = last_commit_date
                        # Use timezone-aware now() for accurate comparison
                        now_aware = datetime.now(last_commit_date.tzinfo)
                        stats["days_since_last_commit"] = (
                            now_aware - last_commit_date
                        ).days
                    else:
                        # Fallback for unexpected timezone format
                        last_commit_date = datetime.strptime(
                            parts[0], "%Y-%m-%d %H:%M:%S"
                        )
                        stats["last_commit_date"] = last_commit_date
                        stats["days_since_last_commit"] = (
                            datetime.now() - last_commit_date
                        ).days
                else:
                    # No timezone in output
                    last_commit_date = datetime.strptime(date_str, "%Y-%m-%d %H:%M:%S")
                    stats["last_commit_date"] = last_commit_date
                    stats["days_since_last_commit"] = (
                        datetime.now() - last_commit_date
                    ).days
            except (ValueError, TypeError):
                # If parsing fails, silently continue without date info
                pass

        # Diff stats
        result = self._run_git(
            ["diff", "--numstat", f"{self.base_branch}...HEAD"], cwd=worktree_path
        )
        if result.returncode == 0:
            # --numstat is a machine-readable, locale-independent format:
            # additions<TAB>deletions<TAB>path (one row per changed file).
            for line in result.stdout.splitlines():
                columns = line.split("\t", 2)
                if len(columns) != 3:
                    continue
                additions, deletions, _file_path = columns

                # Binary files are reported as "-" for both counts.
                if additions.isdecimal():
                    stats["additions"] += int(additions)
                if deletions.isdecimal():
                    stats["deletions"] += int(deletions)

        return stats

    def create_worktree(self, spec_name: str) -> WorktreeInfo:
        """
        Create a worktree for a spec (idempotent).

        This method is idempotent - calling it multiple times with the same spec_name
        will succeed regardless of prior state. It handles:
        - Existing valid worktrees (returns existing)
        - Corrupted worktrees (force removes and recreates)
        - Orphaned worktree references (prunes them)
        - Stale worktree directories (cleans them up)
        - Existing branches without worktrees (reuses the branch)

        Note:
            This method is NOT thread-safe for concurrent calls with the same spec_name.
            If concurrent access is needed, implement external locking.

        Args:
            spec_name: The spec folder name (e.g., "002-implement-memory")

        Returns:
            WorktreeInfo for the created or existing worktree

        Raises:
            WorktreeError: If a branch namespace conflict exists or worktree creation fails
        """
        worktree_path = self.get_worktree_path(spec_name)
        branch_name = self.get_branch_name(spec_name)

        # Step 1: Prune orphaned worktree references first
        # This cleans up any stale references that might block operations
        self._run_git(["worktree", "prune"])

        # Step 2: Check for branch namespace conflict (e.g., 'workpilot' blocking 'workpilot/*')
        conflicting_branch = self._check_branch_namespace_conflict()
        if conflicting_branch:
            raise WorktreeError(
                f"Branch '{conflicting_branch}' exists and blocks creating '{branch_name}'.\n"
                f"\n"
                f"Git branch names work like file paths - a branch named 'workpilot' prevents\n"
                f"creating branches under 'workpilot/' (like 'workpilot/{spec_name}').\n"
                f"\n"
                f"Fix: Rename the conflicting branch:\n"
                f"  git branch -m {conflicting_branch} {conflicting_branch}-backup"
            )

        # Step 3: Check if worktree already exists and is valid
        if worktree_path.exists() and self._worktree_is_registered(worktree_path):
            # Worktree exists and is tracked by git - return existing (idempotent)
            existing = self.get_worktree_info(spec_name)
            if existing:
                print(
                    f"Using existing worktree: {worktree_path.name} on branch {existing.branch}"
                )
                return existing
            else:
                # Worktree is registered but corrupted (e.g., unreadable HEAD)
                # Force remove the registration and let it be recreated
                print(f"Removing corrupted worktree registration: {worktree_path.name}")
                remove_result = self._run_git(
                    ["worktree", "remove", "--force", str(worktree_path)]
                )
                if remove_result.returncode != 0:
                    raise WorktreeError(
                        f"Failed to remove corrupted worktree: {remove_result.stderr}"
                    )

        # Step 4: Handle stale worktree directory (exists but not registered with git)
        if worktree_path.exists() and not self._worktree_is_registered(worktree_path):
            print(f"Removing stale worktree directory: {worktree_path.name}")
            shutil.rmtree(worktree_path, ignore_errors=True)
            if worktree_path.exists():
                raise WorktreeError(
                    f"Failed to remove stale worktree directory: {worktree_path}\n"
                    f"This may be due to permission issues or file locks."
                )

        # Step 5: Check if branch already exists
        branch_exists = self._branch_exists(branch_name)

        # Step 6: Fetch latest from remote to ensure we have the most up-to-date code
        # GitHub/remote is the source of truth, not the local branch.
        #
        # Offline / local-branch mode: skip the remote fetch entirely. When the
        # user opted into local-branch mode (useLocalBranch), the remote is not
        # the source of truth and may be unreachable (air-gapped machine, expired
        # credentials, VPN down...). Touching the network here only adds latency
        # and a scary "403 / could not fetch" warning before the local fallback
        # kicks in anyway, so we don't even try.
        if self.use_local_branch:
            print("Local-branch mode: skipping remote fetch (offline-friendly).")
        else:
            fetch_result = self._run_git(["fetch", "origin", self.base_branch])
            if fetch_result.returncode != 0:
                print(
                    f"Warning: Could not fetch {self.base_branch} from origin: {fetch_result.stderr}"
                )
                print("Falling back to local branch...")

        # Step 7: Create the worktree
        if branch_exists:
            # Branch exists - attach worktree to existing branch (no -b flag)
            print(f"Reusing existing branch: {branch_name}")
            add_args = ["worktree", "add", str(worktree_path), branch_name]
            created_branch = None
        else:
            # Branch doesn't exist - create new branch from remote or local base
            # Determine the start point for the worktree
            start_point = self.base_branch  # Default to local branch

            if self.use_local_branch:
                # User explicitly requested local branch - skip auto-switch to remote
                # This preserves gitignored files (.env, configs) that may not exist on remote
                print(f"Creating worktree from local branch: {self.base_branch}")
            else:
                # Check if remote ref exists and use it as the source of truth
                remote_ref = f"origin/{self.base_branch}"
                check_remote = self._run_git(["rev-parse", "--verify", remote_ref])
                if check_remote.returncode == 0:
                    start_point = remote_ref
                    print(f"Creating worktree from remote: {remote_ref}")
                else:
                    print(
                        f"Remote ref {remote_ref} not found, using local branch: {self.base_branch}"
                    )

            # Create worktree with new branch from the start point
            add_args = [
                "worktree",
                "add",
                "-b",
                branch_name,
                str(worktree_path),
                start_point,
            ]
            created_branch = branch_name

        # `git worktree add` is flaky on Windows: it intermittently exits
        # non-zero (often with an empty stderr) when antivirus/indexing briefly
        # locks a just-created file during checkout. Retry transient failures,
        # cleaning up any partial state between attempts.
        result = self._run_worktree_add(
            add_args, worktree_path=worktree_path, created_branch=created_branch
        )

        if result.returncode != 0:
            details = result.stderr.strip() or result.stdout.strip() or "(no output)"
            raise WorktreeError(
                f"Failed to create worktree for {spec_name} "
                f"(git exit {result.returncode}): {details}"
            )

        print(f"Created worktree: {worktree_path.name} on branch {branch_name}")

        return WorktreeInfo(
            path=worktree_path,
            branch=branch_name,
            spec_name=spec_name,
            base_branch=self.base_branch,
            is_active=True,
        )

    def _run_worktree_add(
        self,
        add_args: list[str],
        worktree_path: Path,
        created_branch: str | None,
        max_attempts: int = 7,
    ) -> subprocess.CompletedProcess:
        """Run ``git worktree add``, retrying transient (often Windows) failures.

        Two transient failure classes, with different retry schedules:

        - Momentary filesystem locks (antivirus/indexer during checkout, often
          an empty stderr on CI): short exponential backoff — the lock clears
          in well under a second.
        - Windows process-spawn failures (STATUS_DLL_INIT_FAILED 0xC0000142
          etc. on loaded GitHub runners): the runner-wide condition persists
          for tens of seconds, so these get a slower schedule capped at 15s —
          the previous ~7.5s total window expired before the runner recovered
          and the test failed after all attempts.

        Between attempts any partially-created worktree directory and branch
        are removed so the retry starts from a clean slate. Returns the final
        ``CompletedProcess`` -- the success, or the last failure for the caller
        to report.
        """
        result = self._run_git(add_args)
        for attempt in range(1, max_attempts):
            if result.returncode == 0:
                return result
            is_spawn_failure = result.returncode in _WINDOWS_SPAWN_FAILURE_EXIT_CODES
            if not (
                is_spawn_failure or _is_retryable_worktree_add_error(result.stderr)
            ):
                return result
            print(
                f"Worktree add failed (attempt {attempt}/{max_attempts}, "
                f"git exit {result.returncode}); cleaning up and retrying..."
            )
            self._cleanup_partial_worktree(worktree_path, created_branch)
            if is_spawn_failure:
                time.sleep(min(2.0 * (2 ** (attempt - 1)), 15.0))
            else:
                time.sleep(min(0.5 * (2 ** (attempt - 1)), 5.0))
            result = self._run_git(add_args)
        return result

    def _cleanup_partial_worktree(
        self, worktree_path: Path, created_branch: str | None
    ) -> None:
        """Remove partial state left by a failed ``git worktree add``.

        Best-effort: drops any half-registered worktree, the leftover directory,
        and the branch we were creating, so the next attempt is not blocked by an
        "already exists" error. Errors are ignored -- the state may not exist.
        """
        self._run_git(["worktree", "remove", "--force", str(worktree_path)])
        self._run_git(["worktree", "prune"])
        if worktree_path.exists():
            shutil.rmtree(worktree_path, ignore_errors=True)
        if created_branch:
            self._run_git(["branch", "-D", created_branch])

    def get_or_create_worktree(self, spec_name: str) -> WorktreeInfo:
        """
        Get existing worktree or create a new one for a spec.

        Args:
            spec_name: The spec folder name

        Returns:
            WorktreeInfo for the worktree
        """
        existing = self.get_worktree_info(spec_name)
        if existing:
            print(f"Using existing worktree: {existing.path}")
            return existing

        return self.create_worktree(spec_name)

    def _has_uncommitted_changes(self, spec_name: str) -> tuple[bool, list[str]]:
        """
        Check if a worktree has uncommitted changes.

        Args:
            spec_name: The spec folder name

        Returns:
            Tuple of (has_changes: bool, file_list: list[str])
        """
        worktree_path = self.get_worktree_path(spec_name)
        if not worktree_path.exists():
            return False, []

        # Check for modified/untracked files in the worktree
        result = self._run_git(
            ["status", "--porcelain"],
            cwd=worktree_path,
        )

        if result.returncode != 0:
            return False, []

        if not result.stdout.strip():
            return False, []

        # Parse status output: each line is <status> <filename>
        # M = modified, A = added, ? = untracked, etc.
        changed_files = []
        for line in result.stdout.strip().split("\n"):
            if line.strip():
                # Extract filename (after the status indicator and space)
                parts = line.split(None, 1)
                if len(parts) >= 2:
                    changed_files.append(parts[1])

        return len(changed_files) > 0, changed_files

    def _count_commits_ahead(self, spec_name: str, target_branch: str) -> int | None:
        """
        Compte les commits de la branche du worktree en avance sur ``target_branch``.

        Utilise ``git rev-list --count <target>..HEAD`` pour préserver la
        sémantique de l'UI Kanban ("commits à pousser"). Tente une résolution
        locale puis remote (``origin/<target>``) si la référence locale est
        absente.

        Args:
            spec_name: Nom du dossier spec (worktree).
            target_branch: Branche cible de la PR (ex: ``develop``).

        Returns:
            Nombre de commits en avance, ou ``None`` si la comparaison est
            impossible (ex: target inconnu localement et sans remote).
        """
        worktree_path = self.get_worktree_path(spec_name)
        if not worktree_path.exists():
            return None

        candidates: list[str] = []
        if target_branch:
            candidates.append(target_branch)
            if not target_branch.startswith("origin/"):
                candidates.append(f"origin/{target_branch}")

        for ref in candidates:
            verify = self._run_git(
                ["rev-parse", "--verify", "--quiet", ref],
                cwd=worktree_path,
            )
            if verify.returncode != 0:
                continue
            count = self._run_git(
                ["rev-list", "--count", f"{ref}..HEAD"],
                cwd=worktree_path,
            )
            if count.returncode == 0:
                try:
                    return int(count.stdout.strip() or "0")
                except ValueError:
                    return None
        return None

    def remove_worktree(self, spec_name: str, delete_branch: bool = False) -> None:
        """
        Remove a spec's worktree.

        Args:
            spec_name: The spec folder name
            delete_branch: Whether to also delete the branch

        Raises:
            RuntimeError: If the worktree has uncommitted changes
        """
        worktree_path = self.get_worktree_path(spec_name)
        branch_name = self.get_branch_name(spec_name)

        # Check for uncommitted changes before removing
        has_changes, changed_files = self._has_uncommitted_changes(spec_name)
        if has_changes:
            error_msg = (
                f"Cannot remove worktree for '{spec_name}': "
                f"has {len(changed_files)} uncommitted file(s):\n"
            )
            for file in changed_files[:10]:  # Show first 10 files
                error_msg += f"  - {file}\n"
            if len(changed_files) > 10:
                error_msg += f"  ... and {len(changed_files) - 10} more\n"
            error_msg += (
                "\nPlease commit or stash these changes before removing the worktree.\n"
                "In the worktree, run: git add . && git commit -m 'Save changes'\n"
                "Or use: git stash"
            )
            raise RuntimeError(error_msg)

        if worktree_path.exists():
            result = self._run_git(
                ["worktree", "remove", "--force", str(worktree_path)]
            )
            if result.returncode == 0:
                print(f"Removed worktree: {worktree_path.name}")
            else:
                # Don't silently delete on git failure - raise exception instead
                stderr_msg = (
                    result.stderr[:200] if result.stderr else "<no error details>"
                )
                raise RuntimeError(
                    f"Failed to remove worktree '{spec_name}' via git: {stderr_msg}\n"
                    f"Worktree path: {worktree_path}\n"
                    f"Please manually remove if needed, or investigate the error above."
                )

        if delete_branch:
            self._run_git(["branch", "-D", branch_name])
            print(f"Deleted branch: {branch_name}")

        self._run_git(["worktree", "prune"])

    def merge_worktree(
        self, spec_name: str, delete_after: bool = False, no_commit: bool = False
    ) -> bool:
        """
        Merge a spec's worktree branch back to base branch.

        Args:
            spec_name: The spec folder name
            delete_after: Whether to remove worktree and branch after merge
            no_commit: If True, merge changes but don't commit (stage only for review)

        Returns:
            True if merge succeeded
        """
        info = self.get_worktree_info(spec_name)
        if not info:
            print(f"No worktree found for spec: {spec_name}")
            return False

        self.strip_build_artifacts(spec_name)

        if no_commit:
            print(
                f"Merging {info.branch} into {self.base_branch} (staged, not committed)..."
            )
        else:
            print(f"Merging {info.branch} into {self.base_branch}...")

        # Switch to base branch in main project, but skip if already on it
        # This avoids triggering git hooks unnecessarily
        current_branch = self._get_current_branch()
        if current_branch != self.base_branch:
            result = self._run_git(["checkout", self.base_branch])
            if result.returncode != 0:
                # Check if this is a hook failure vs actual checkout failure
                # Hook failures still change the branch but return non-zero
                new_branch = self._get_current_branch()
                if new_branch == self.base_branch:
                    # Branch did change - likely a hook failure, continue with merge
                    stderr_msg = result.stderr[:100] if result.stderr else "<no stderr>"
                    debug_warning(
                        "worktree",
                        f"Checkout succeeded but hook returned non-zero: {stderr_msg}",
                    )
                else:
                    # Actual checkout failure
                    stderr_msg = result.stderr[:100] if result.stderr else "<no stderr>"
                    print(f"Error: Could not checkout base branch: {stderr_msg}")
                    return False

        # Merge the spec branch
        merge_args = ["merge", "--no-ff", info.branch]
        if no_commit:
            # --no-commit stages the merge but doesn't create the commit
            merge_args.append("--no-commit")
        else:
            merge_args.extend(["-m", f"workpilot: Merge {info.branch}"])

        result = self._run_git(merge_args)

        if result.returncode != 0:
            # Check if it's "already up to date" - not an error
            output = (result.stdout + result.stderr).lower()
            if "already up to date" in output or "already up-to-date" in output:
                print(f"Branch {info.branch} is already up to date.")
                if no_commit:
                    print("No changes to stage.")
                if delete_after:
                    self.remove_worktree(spec_name, delete_branch=True)
                return True
            # Check for actual conflicts
            if "conflict" in output:
                print("Merge conflict! Aborting merge...")
                self._run_git(["merge", "--abort"])
                return False
            # Other error - show details
            stderr_msg = (
                result.stderr[:200]
                if result.stderr
                else result.stdout[:200]
                if result.stdout
                else "<no output>"
            )
            print(f"Merge failed: {stderr_msg}")
            self._run_git(["merge", "--abort"])
            return False

        if no_commit:
            # Unstage any files that are gitignored in the main branch
            # These get staged during merge because they exist in the worktree branch
            self._unstage_gitignored_files()
            print(
                f"Changes from {info.branch} are now staged in your working directory."
            )
            print("Review the changes, then commit when ready:")
            print("  git commit -m 'your commit message'")
        else:
            print(f"Successfully merged {info.branch}")

        if delete_after:
            try:
                self.remove_worktree(spec_name, delete_branch=True)
            except RuntimeError as e:
                # Worktree has uncommitted changes - log but don't fail merge
                print()
                print("WARNING: Worktree cleanup failed")
                print(str(e))
                print()
                print(
                    "The merge completed successfully, but the worktree still has "
                    "uncommitted changes and was not removed."
                )

        return True

    def commit_in_worktree(self, spec_name: str, message: str) -> bool:
        """Commit all changes in a spec's worktree.

        Les artefacts internes de WorkPilot (``.workpilot/`` et fichiers
        ``.workpilot-*``) sont volontairement exclus du staging : ils ne
        doivent jamais polluer la PR (ils restent présents sur le disque pour
        le fonctionnement de l'app). Voir aussi ``_strip_workpilot_artifacts``
        pour les fichiers éventuellement déjà commités par l'agent.
        """
        worktree_path = self.get_worktree_path(spec_name)
        if not worktree_path.exists():
            return False

        # Build and test outputs (bin/, obj/, TestResults/, node_modules/...)
        # stay out of the commit even when the project has no .gitignore.
        ensure_artifact_excludes(worktree_path, self.base_branch)
        self._run_git(
            [
                "add",
                "-A",
                "--",
                ".",
                ":!.workpilot",
                ":!.workpilot-*",
            ],
            cwd=worktree_path,
        )
        result = self._run_git(["commit", "-m", message], cwd=worktree_path)

        if result.returncode == 0:
            return True
        elif "nothing to commit" in result.stdout + result.stderr:
            return True
        else:
            print(f"Commit failed: {result.stderr}")
            return False

    def ensure_build_artifact_excludes(self, spec_name: str) -> list[str]:
        """Keep the project's build and test outputs out of ``git add``.

        See ``core.build_artifacts``: a managed block in the repository's
        ``info/exclude``, so it works whatever agent commits.
        """
        worktree_path = self.get_worktree_path(spec_name)
        if not worktree_path.exists():
            return []
        return ensure_artifact_excludes(worktree_path, self.base_branch)

    def strip_build_artifacts(self, spec_name: str) -> list[str]:
        """Take the build and test outputs the branch committed back out.

        Files the branch added that ``.gitignore`` or the managed excludes
        ignore (``bin/``, ``obj/``, ``TestResults/``...) leave the index in a
        commit of their own and stay on disk. Files of the base branch are
        never touched.
        """
        return strip_committed_artifacts(
            self.get_worktree_path(spec_name), self.base_branch
        )

    def _strip_workpilot_artifacts(self, spec_name: str) -> list[str]:
        """Retire les artefacts internes de WorkPilot de la branche poussée.

        WorkPilot écrit ses propres fichiers de travail à la racine du worktree
        (``.workpilot/specs/...``, ``.workpilot-status``, ``.workpilot-discard-list``,
        ``.workpilot-security.json``...). Le ``.gitignore`` du projet cible ne les
        connaît pas : si l'agent les a commités pendant son travail, ils se
        retrouvent dans la PR et la polluent.

        On les retire de l'index (``git rm -r --cached``) puis on commit la
        suppression : les fichiers restent sur le disque (l'app en a besoin)
        mais disparaissent de l'historique poussé donc de la PR.

        Args:
            spec_name: Nom du dossier spec (worktree).

        Returns:
            Liste des chemins effectivement retirés de l'index.
        """
        worktree_path = self.get_worktree_path(spec_name)
        if not worktree_path.exists():
            return []

        patterns = [".workpilot", ".workpilot-*"]

        # Détecte les fichiers suivis correspondant aux motifs WorkPilot.
        ls = self._run_git(["ls-files", "--", *patterns], cwd=worktree_path)
        tracked = [line.strip() for line in ls.stdout.splitlines() if line.strip()]
        if not tracked:
            return []

        rm = self._run_git(
            ["rm", "-r", "--cached", "--ignore-unmatch", "--", *patterns],
            cwd=worktree_path,
        )
        if rm.returncode != 0:
            logger.warning(
                "[_strip_workpilot_artifacts] git rm --cached failed: %s",
                rm.stderr,
            )
            return []

        commit = self._run_git(
            [
                "commit",
                "-m",
                "workpilot: exclude internal WorkPilot artifacts from PR",
            ],
            cwd=worktree_path,
        )
        if commit.returncode != 0 and "nothing to commit" not in (
            commit.stdout + commit.stderr
        ):
            logger.warning(
                "[_strip_workpilot_artifacts] Commit of artifact removal failed: %s",
                commit.stderr,
            )
            return []

        logger.info(
            "[_strip_workpilot_artifacts] Removed %d WorkPilot artifact(s) "
            "from PR branch of '%s'.",
            len(tracked),
            spec_name,
        )
        return tracked

    # ==================== Listing & Discovery ====================

    def list_all_worktrees(self) -> list[WorktreeInfo]:
        """List all spec worktrees (includes legacy .worktrees/ location)."""
        worktrees = []
        seen_specs = set()

        # Check new location first
        if self.worktrees_dir.exists():
            for item in self.worktrees_dir.iterdir():
                if item.is_dir():
                    info = self.get_worktree_info(item.name)
                    if info:
                        worktrees.append(info)
                        seen_specs.add(item.name)

        # Check legacy location (.worktrees/)
        legacy_dir = self.project_dir / ".worktrees"
        if legacy_dir.exists():
            for item in legacy_dir.iterdir():
                if item.is_dir() and item.name not in seen_specs:
                    info = self.get_worktree_info(item.name)
                    if info:
                        worktrees.append(info)

        return worktrees

    def list_all_spec_branches(self) -> list[str]:
        """List all workpilot branches (even if worktree removed)."""
        result = self._run_git(["branch", "--list", "workpilot/*"])
        if result.returncode != 0:
            return []

        branches = []
        for line in result.stdout.strip().split("\n"):
            branch = line.strip().lstrip("* ")
            if branch:
                branches.append(branch)

        return branches

    def get_changed_files(self, spec_name: str) -> list[tuple[str, str]]:
        """Get list of changed files in a spec's worktree."""
        worktree_path = self.get_worktree_path(spec_name)
        if not worktree_path.exists():
            return []

        result = self._run_git(
            ["diff", "--name-status", f"{self.base_branch}...HEAD"], cwd=worktree_path
        )

        files = []
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            parts = line.split("\t", 1)
            if len(parts) == 2:
                files.append((parts[0], parts[1]))

        return files

    def get_change_summary(self, spec_name: str) -> dict:
        """Get a summary of changes in a worktree."""
        files = self.get_changed_files(spec_name)

        new_files = sum(1 for status, _ in files if status == "A")
        modified_files = sum(1 for status, _ in files if status == "M")
        deleted_files = sum(1 for status, _ in files if status == "D")

        return {
            "new_files": new_files,
            "modified_files": modified_files,
            "deleted_files": deleted_files,
        }

    def cleanup_all(self) -> None:
        """Remove all worktrees and their branches."""
        for worktree in self.list_all_worktrees():
            self.remove_worktree(worktree.spec_name, delete_branch=True)

    def cleanup_stale_worktrees(self) -> None:
        """Remove worktrees that aren't registered with git."""
        if not self.worktrees_dir.exists():
            return

        # Get list of registered worktrees
        result = self._run_git(["worktree", "list", "--porcelain"])
        registered_paths = set()
        for line in result.stdout.split("\n"):
            if line.startswith("worktree "):
                registered_paths.add(Path(line.split(" ", 1)[1]))

        # Remove unregistered directories
        for item in self.worktrees_dir.iterdir():
            if item.is_dir() and item not in registered_paths:
                print(f"Removing stale worktree directory: {item.name}")
                shutil.rmtree(item, ignore_errors=True)

        self._run_git(["worktree", "prune"])

    def get_test_commands(self, spec_name: str) -> list[str]:
        """Detect likely test/run commands for the project."""
        worktree_path = self.get_worktree_path(spec_name)
        commands = []

        if (worktree_path / "package.json").exists():
            commands.append("npm install && npm run dev")
            commands.append("npm test")

        if (worktree_path / "requirements.txt").exists():
            commands.append("pip install -r requirements.txt")

        if (worktree_path / "Cargo.toml").exists():
            commands.append("cargo run")
            commands.append("cargo test")

        if (worktree_path / "go.mod").exists():
            commands.append("go run .")
            commands.append("go test ./...")

        if not commands:
            commands.append("# Check the project's README for run instructions")

        return commands

    def has_uncommitted_changes(self, spec_name: str | None = None) -> bool:
        """Check if there are uncommitted changes."""
        cwd = None
        if spec_name:
            worktree_path = self.get_worktree_path(spec_name)
            if worktree_path.exists():
                cwd = worktree_path
        result = self._run_git(["status", "--porcelain"], cwd=cwd)
        return bool(result.stdout.strip())

    # ==================== Worktree Cleanup Methods ====================

    def get_old_worktrees(
        self, days_threshold: int = 30, include_stats: bool = False
    ) -> list[WorktreeInfo] | list[str]:
        """
        Find worktrees that haven't been modified in the specified number of days.

        Args:
            days_threshold: Number of days without activity to consider a worktree old (default: 30)
            include_stats: If True, return full WorktreeInfo objects; if False, return just spec names

        Returns:
            List of old worktrees (either WorktreeInfo objects or spec names based on include_stats)
        """
        old_worktrees = []

        for worktree_info in self.list_all_worktrees():
            # Skip if we can't determine age
            if worktree_info.days_since_last_commit is None:
                continue

            if worktree_info.days_since_last_commit >= days_threshold:
                if include_stats:
                    old_worktrees.append(worktree_info)
                else:
                    old_worktrees.append(worktree_info.spec_name)

        return old_worktrees

    def cleanup_old_worktrees(
        self, days_threshold: int = 30, dry_run: bool = False
    ) -> tuple[list[str], list[str]]:
        """
        Remove worktrees that haven't been modified in the specified number of days.

        Args:
            days_threshold: Number of days without activity to consider a worktree old (default: 30)
            dry_run: If True, only report what would be removed without actually removing

        Returns:
            Tuple of (removed_specs, failed_specs) containing spec names
        """
        old_worktrees = self.get_old_worktrees(
            days_threshold=days_threshold, include_stats=True
        )

        if not old_worktrees:
            print(f"No worktrees found older than {days_threshold} days.")
            return ([], [])

        removed = []
        failed = []

        if dry_run:
            print(f"\n[DRY RUN] Would remove {len(old_worktrees)} old worktrees:")
            for info in old_worktrees:
                print(
                    f"  - {info.spec_name} (last activity: {info.days_since_last_commit} days ago)"
                )
            return ([], [])

        print(f"\nRemoving {len(old_worktrees)} old worktrees...")
        for info in old_worktrees:
            try:
                self.remove_worktree(info.spec_name, delete_branch=True)
                removed.append(info.spec_name)
                print(
                    f"  ✓ Removed {info.spec_name} (last activity: {info.days_since_last_commit} days ago)"
                )
            except Exception as e:
                failed.append(info.spec_name)
                print(f"  ✗ Failed to remove {info.spec_name}: {e}")

        if removed:
            print(f"\nSuccessfully removed {len(removed)} worktree(s).")
        if failed:
            print(f"Failed to remove {len(failed)} worktree(s).")

        return (removed, failed)

    def get_worktree_count_warning(
        self, warning_threshold: int = 10, critical_threshold: int = 20
    ) -> str | None:
        """
        Check worktree count and return a warning message if threshold is exceeded.

        Args:
            warning_threshold: Number of worktrees to trigger a warning (default: 10)
            critical_threshold: Number of worktrees to trigger a critical warning (default: 20)

        Returns:
            Warning message string if threshold exceeded, None otherwise
        """
        worktrees = self.list_all_worktrees()
        count = len(worktrees)

        if count >= critical_threshold:
            old_worktrees = self.get_old_worktrees(days_threshold=30)
            old_count = len(old_worktrees)
            return (
                f"CRITICAL: {count} worktrees detected! "
                f"Consider cleaning up old worktrees ({old_count} are 30+ days old). "
                f"Run cleanup to remove stale worktrees."
            )
        elif count >= warning_threshold:
            old_worktrees = self.get_old_worktrees(days_threshold=30)
            old_count = len(old_worktrees)
            return (
                f"WARNING: {count} worktrees detected. "
                f"{old_count} are 30+ days old and may be safe to clean up."
            )

        return None

    def print_worktree_summary(self) -> None:
        """Print a summary of all worktrees with age information."""
        worktrees = self.list_all_worktrees()

        if not worktrees:
            print("No worktrees found.")
            return

        print(f"\n{'=' * 80}")
        print(f"Worktree Summary ({len(worktrees)} total)")
        print(f"{'=' * 80}\n")

        # Group by age
        recent = []  # < 7 days
        week_old = []  # 7-30 days
        month_old = []  # 30-90 days
        very_old = []  # > 90 days
        unknown_age = []

        for info in worktrees:
            if info.days_since_last_commit is None:
                unknown_age.append(info)
            elif info.days_since_last_commit < 7:
                recent.append(info)
            elif info.days_since_last_commit < 30:
                week_old.append(info)
            elif info.days_since_last_commit < 90:
                month_old.append(info)
            else:
                very_old.append(info)

        def print_group(title: str, items: list[WorktreeInfo]):
            if not items:
                return
            print(f"{title} ({len(items)}):")
            for info in sorted(items, key=lambda x: x.spec_name):
                age_str = (
                    f"{info.days_since_last_commit}d ago"
                    if info.days_since_last_commit is not None
                    else "unknown"
                )
                print(f"  - {info.spec_name} (last activity: {age_str})")
            print()

        print_group("Recent (< 7 days)", recent)
        print_group("Week Old (7-30 days)", week_old)
        print_group("Month Old (30-90 days)", month_old)
        print_group("Very Old (> 90 days)", very_old)
        print_group("Unknown Age", unknown_age)

        # Print cleanup suggestions
        if month_old or very_old:
            total_old = len(month_old) + len(very_old)
            print(f"{'=' * 80}")
            print(
                f"💡 Suggestion: {total_old} worktree(s) are 30+ days old and may be safe to clean up."
            )
            print("   Review these worktrees and run cleanup if no longer needed.")
            print(f"{'=' * 80}\n")
