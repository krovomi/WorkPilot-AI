"""The re-review after a fix: check the fixer's delta before the whole review.

Every QA pass used to be a fresh session that re-read the spec and the whole
diff, started the environment and ran every suite, even when the fixer had
only touched one line of the issue the previous pass named, or had not fixed
it at all. At effort ``high`` the loop allows 12 passes (`qa.budget`), so a
task that needs three fixes paid for four complete reviews.

From the second pass on, the reviewer now starts with what changed since the
pass that rejected: the issues it raised, the fixer's diff since then (git,
not the fixer's own account) and the tests of the files that diff touched. An
issue still open, a failing test or a new problem in the delta rejects right
there, without the environment, the whole suites or the criteria already
verified. Only when every issue is fixed does the reviewer go on to the
complete review, which is the one that signs: an approval is never given on
the delta alone, and the gates after it (coverage, targeted, architecture,
goal) are unchanged.

The worktree is snapshotted as a git tree object, built in a temporary index
seeded from the real one: nothing in the worktree, its index or its refs
moves, untracked files are included and ``.gitignore`` is honoured (the spec
directory under ``.workpilot/`` is not part of it). The snapshot is taken when
a pass rejects and a fix follows, and kept in ``qa_recheck.json``; a pass
uses it only when it was recorded by the pass right before it.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

#: The kill switch, for a project that wants every pass reviewed from scratch.
RECHECK_ENV = "WORKPILOT_QA_RECHECK"

#: The file, in the spec directory, that holds the last rejection's snapshot.
STATE_FILE = "qa_recheck.json"

#: Above this, the fixer's delta is cut: the reviewer opens the files.
DELTA_MAX_CHARS = 30_000

#: At most this many issues are listed; the rest are counted.
MAX_ISSUES = 20


def recheck_enabled() -> bool:
    """False when the project turned the re-review by delta off."""
    return os.environ.get(RECHECK_ENV, "1").strip().lower() not in (
        "0",
        "false",
        "off",
        "no",
    )


def snapshot_tree(project_dir: Path) -> str | None:
    """A git tree object of the worktree as it is now, or None.

    Built in a temporary copy of the index, so the worktree's own index, its
    HEAD and its branches are untouched. Untracked, non-ignored files count.
    """
    from foundation.git_executable import get_isolated_git_env, run_git

    index = run_git(["rev-parse", "--git-path", "index"], cwd=project_dir, timeout=15)
    if index.returncode != 0 or not index.stdout.strip():
        return None
    real_index = Path(index.stdout.strip())
    if not real_index.is_absolute():
        real_index = Path(project_dir) / real_index
    with tempfile.TemporaryDirectory(prefix="wp-qa-recheck-") as tmp:
        tmp_index = Path(tmp) / "index"
        try:
            if real_index.is_file():
                shutil.copyfile(real_index, tmp_index)
        except OSError:
            return None
        env = {**get_isolated_git_env(), "GIT_INDEX_FILE": str(tmp_index)}
        added = run_git(["add", "-A"], cwd=project_dir, timeout=120, env=env)
        if added.returncode != 0:
            return None
        tree = run_git(["write-tree"], cwd=project_dir, timeout=60, env=env)
    sha = tree.stdout.strip()
    return sha if tree.returncode == 0 and sha else None


def _issue_view(issue: Any) -> dict[str, str] | None:
    if not isinstance(issue, dict):
        return None
    view = {
        key: str(issue.get(key) or "").strip()[:400]
        for key in ("severity", "title", "description", "location", "fix")
    }
    return view if view["title"] or view["description"] else None


def record_rejection(
    spec_dir: Path, project_dir: Path, qa_iteration: int, issues: list[dict] | None
) -> bool:
    """Keep the snapshot and the issues of the pass that just rejected.

    False (and no file) when the snapshot cannot be taken: the next pass is
    then a complete review, as before.
    """
    path = Path(spec_dir) / STATE_FILE
    if not recheck_enabled():
        return False
    tree = snapshot_tree(project_dir)
    views = [v for v in map(_issue_view, issues or []) if v]
    if tree is None or not views:
        path.unlink(missing_ok=True)
        return False
    try:
        path.write_text(
            json.dumps({"iteration": qa_iteration, "tree": tree, "issues": views}),
            encoding="utf-8",
        )
    except OSError:
        return False  # the next pass is a complete review
    return True


def clear(spec_dir: Path) -> None:
    """Forget the last rejection (an approval, a new QA run)."""
    (Path(spec_dir) / STATE_FILE).unlink(missing_ok=True)


def _load(spec_dir: Path, qa_iteration: int) -> dict | None:
    try:
        state = json.loads((Path(spec_dir) / STATE_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(state, dict) or state.get("iteration") != qa_iteration - 1:
        return None  # a rejection older than the previous pass: start over
    if not isinstance(state.get("tree"), str) or not state.get("issues"):
        return None
    return state


def _delta(project_dir: Path, base: str, head: str) -> tuple[list[str], str] | None:
    from foundation.git_executable import run_git

    names = run_git(["diff", "--name-only", base, head], cwd=project_dir, timeout=30)
    diff = run_git(["diff", base, head], cwd=project_dir, timeout=60)
    if names.returncode != 0 or diff.returncode != 0:
        return None
    files = [f for f in names.stdout.splitlines() if f.strip()]
    text = diff.stdout
    if len(text) > DELTA_MAX_CHARS:
        text = (
            text[:DELTA_MAX_CHARS]
            + "\n[... delta truncated: read the files themselves ...]\n"
        )
    return files, text


def _touched_tests(project_dir: Path, files: list[str]) -> tuple[list[str], list[str]]:
    """The tests the delta's files map to, and the files without one."""
    from foundation.change_scope import is_text_only_path
    from foundation.git_executable import run_git
    from foundation.touched_tests import map_tests

    code = [f for f in files if not is_text_only_path(f)]
    if not code:
        return [], []
    listed = run_git(
        ["ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=project_dir,
        timeout=30,
    )
    repo = listed.stdout.splitlines() if listed.returncode == 0 else []
    present = [f for f in code if (Path(project_dir) / f).is_file()]
    mapping, unmapped = map_tests(present, repo)
    tests = sorted({t for ts in mapping.values() for t in ts})
    return tests, unmapped


def _data(text: str) -> str:
    """Repository and model text, made inert inside a fenced block."""
    return text.replace("```", "``​`").replace("{{", "{ {")


def _issue_line(i: int, issue: dict) -> str:
    head = f"{i}. **[{issue.get('severity') or '?'}] {issue.get('title') or ''}**"
    details = [
        part
        for part in (
            issue.get("location") and f"at `{issue['location']}`",
            issue.get("description"),
            issue.get("fix") and f"asked fix: {issue['fix']}",
        )
        if part
    ]
    return _data(head + (" — " + "; ".join(details) if details else ""))


def recheck_section(spec_dir: Path, project_dir: Path, qa_iteration: int) -> str:
    """The prompt section that opens a re-review, or "" for a complete one."""
    if qa_iteration < 2 or not recheck_enabled():
        return ""
    state = _load(spec_dir, qa_iteration)
    if state is None:
        return ""
    head = snapshot_tree(project_dir)
    delta = _delta(project_dir, state["tree"], head) if head else None
    if delta is None:
        return ""
    files, diff = delta
    issues = [i for i in state["issues"] if isinstance(i, dict)]
    lines = [_issue_line(n, i) for n, i in enumerate(issues[:MAX_ISSUES], start=1)]
    if len(issues) > MAX_ISSUES:
        lines.append(f"... and {len(issues) - MAX_ISSUES} more (see qa_report.md).")
    tests, unmapped = _touched_tests(project_dir, files)
    if not files:
        changed = (
            "**The fixer changed no file since pass "
            f"{qa_iteration - 1}.** An issue that needed a code change is "
            "therefore still open."
        )
    else:
        changed = (
            "Files the fixer changed: "
            + ", ".join(f"`{_data(f)}`" for f in files)
            + f"\n\n```diff\n{_data(diff)}\n```"
        )
    if tests:
        run = "Tests of the files the fixer touched (run these, and only these, "
        run += "in this step): " + ", ".join(f"`{_data(t)}`" for t in tests)
    else:
        run = "No test maps to the fixer's files by naming convention."
    if unmapped:
        run += " Without a mapped test: " + ", ".join(f"`{_data(f)}`" for f in unmapped)
    return f"""## RE-REVIEW AFTER A FIX (PASS {qa_iteration}): CHECK THE FIXES FIRST

Pass {qa_iteration - 1} rejected this task. **Before PHASE 0 and anything
else above**, check the fix against what that pass found. The delta below is
read from git, not from the fixer's account.

### The issues pass {qa_iteration - 1} raised

{chr(10).join(lines)}

### What changed since pass {qa_iteration - 1}

{changed}

{run}

### Step 1 (this is the cheap part)

1. For each issue above, decide from the delta (open a file only when the
   delta is not enough) whether it is fixed.
2. Run the tests listed above, by path, if any.
3. Look at the delta itself for a new problem (a regression, a test weakened
   or deleted to pass, a requirement of the spec now broken).

If **any** issue is still open, a listed test fails, or the delta brings a
new problem: record `rejected` in `qa_signoff`, listing the open and new
issues, and stop. Do not start the environment, run the whole suites or
re-check criteria the previous pass verified: the next pass will.

### Step 2 (only if step 1 found nothing)

Go on with the complete review above, every phase of it: this is the pass
that signs, so nothing in it is skipped, and an approval given on the delta
alone is not an approval.
"""
