"""The base branch of a task: the branch its worktree starts from and its diff is taken against.

Read by the prompts, QA, the CLI, the architecture validator and the consensus
arbiter. It lived in ``prompts_pkg.prompts``, which tied each of them to the
prompt loader and, through it, to the agents' import cycle (plan of 29 October,
A1). It reads ``task_metadata.json``, the environment and git, nothing of the
backend.
"""

import json
import os
import re
import subprocess
from pathlib import Path

__all__ = [
    "detect_base_branch",
    "get_base_branch_from_metadata",
    "get_use_local_branch_from_metadata",
    "validate_branch_name",
]


def validate_branch_name(branch: str | None) -> str | None:
    """
    Validate a git branch name for safety and correctness.

    Args:
        branch: The branch name to validate

    Returns:
        The validated branch name, or None if invalid
    """
    if not branch or not isinstance(branch, str):
        return None

    # Trim whitespace
    branch = branch.strip()

    # Reject empty or whitespace-only strings
    if not branch:
        return None

    # Enforce maximum length (git refs can be long, but 255 is reasonable)
    if len(branch) > 255:
        return None

    # Require at least one alphanumeric character
    if not any(c.isalnum() for c in branch):
        return None

    # Only allow common git-ref characters: letters, numbers, ., _, -, /
    # This prevents prompt injection and other security issues
    if not re.match(r"^[A-Za-z0-9._/-]+$", branch):
        return None

    # Reject suspicious patterns that could be prompt injection attempts
    # (newlines, control characters are already blocked by the regex above)

    return branch


def get_base_branch_from_metadata(spec_dir: Path) -> str | None:
    """
    Read baseBranch from task_metadata.json if it exists.

    Args:
        spec_dir: Directory containing the spec files

    Returns:
        The baseBranch from metadata, or None if not found or invalid
    """
    metadata_path = spec_dir / "task_metadata.json"
    if metadata_path.exists():
        try:
            with open(metadata_path, encoding="utf-8") as f:
                metadata = json.load(f)
                base_branch = metadata.get("baseBranch")
                # Validate the branch name before returning
                return validate_branch_name(base_branch)
        except (json.JSONDecodeError, OSError):
            pass
    return None


def get_use_local_branch_from_metadata(spec_dir: Path) -> bool:
    """
    Read useLocalBranch from task_metadata.json if it exists.

    When True, the worktree should be created from the local branch directly
    instead of preferring origin/branch. This preserves gitignored files
    (.env, configs) that may not exist on the remote.

    Args:
        spec_dir: Directory containing the spec files

    Returns:
        True if useLocalBranch is set in metadata, False otherwise
    """
    metadata_path = spec_dir / "task_metadata.json"
    if metadata_path.exists():
        try:
            with open(metadata_path, encoding="utf-8") as f:
                metadata = json.load(f)
                return bool(metadata.get("useLocalBranch", False))
        except (json.JSONDecodeError, OSError):
            pass
    return False


# Alias for backwards compatibility (internal use)
def detect_base_branch(spec_dir: Path, project_dir: Path) -> str:
    """
    Detect the base branch for a project/task.

    Priority order:
    1. baseBranch from task_metadata.json (task-level override)
    2. DEFAULT_BRANCH environment variable
    3. Auto-detect main/master/develop (if they exist in git)
    4. Fall back to "main"

    Args:
        spec_dir: Directory containing the spec files
        project_dir: Project root directory

    Returns:
        The detected base branch name
    """
    # 1. Check task_metadata.json for task-specific baseBranch
    metadata_branch = get_base_branch_from_metadata(spec_dir)
    if metadata_branch:
        return metadata_branch

    # 2. Check for DEFAULT_BRANCH env var
    env_branch = validate_branch_name(os.getenv("DEFAULT_BRANCH"))
    if env_branch:
        # Verify the branch exists (with timeout to prevent hanging)
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--verify", env_branch],
                cwd=project_dir,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=3,
            )
            if result.returncode == 0:
                return env_branch
        except subprocess.TimeoutExpired:
            # Treat timeout as branch verification failure
            pass

    # 3. Auto-detect main/master/develop
    for branch in ["main", "master", "develop"]:
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--verify", branch],
                cwd=project_dir,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=3,
            )
            if result.returncode == 0:
                return branch
        except subprocess.TimeoutExpired:
            # Treat timeout as branch verification failure, try next branch
            continue

    # 4. Fall back to "main"
    return "main"
