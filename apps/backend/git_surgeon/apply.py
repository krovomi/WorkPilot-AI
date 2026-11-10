"""Apply a rewrite plan on a new branch, never on the person's own.

The plan is replayed in a temporary worktree started at the base: each commit
is brought in with ``git cherry-pick --no-commit`` and recorded with
``git commit-tree`` (no hook runs, as with ``git rebase``), its author, email
and date kept. The commits before the first change keep their sha, and so
their signatures.

Before anything is named, the tree of the result must be the tree of the
branch, byte for byte: only the history changed, never the code. The result
then becomes a new local branch ``surgeon/<branch>-<date>``. The branch the
person works on, its remote and every other ref stay as they were: nothing is
pushed, nothing is forced. A conflict, a branch that moved since the plan or a
plan that does not cover every commit exactly once stops the run, and the
temporary worktree goes away with it.
"""

from __future__ import annotations

import re
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from foundation.git_executable import get_isolated_git_env, run_git

from .commits import Commit, SurgeonError, current_branch, git, read_range, verify
from .planner import KINDS, Planned

MAX_MESSAGE = 8000
MAX_STEPS = 1000
_SHA = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")


def _text(value: object, limit: int) -> str:
    if not isinstance(value, str) or "\x00" in value or len(value) > limit:
        raise SurgeonError("a message of the plan is not text")
    return value.strip()


def validate(raw: object, commits: list[Commit]) -> list[Planned]:
    """The plan as the page sent it, checked against the commits of the range."""
    if not isinstance(raw, list) or not raw or len(raw) > MAX_STEPS:
        raise SurgeonError("the plan is empty or too long")
    by_sha = {c.sha: c for c in commits}
    if any(c.is_merge for c in commits):
        raise SurgeonError("the range holds merge commits: start after the last merge")
    steps: list[Planned] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict) or item.get("kind") not in KINDS:
            raise SurgeonError(f"step {index + 1} is not a step")
        sources = item.get("sources")
        if not isinstance(sources, list) or not sources or len(sources) > len(commits):
            raise SurgeonError(f"step {index + 1} has no commit")
        if not all(
            isinstance(s, str) and _SHA.match(s) and s in by_sha for s in sources
        ):
            raise SurgeonError(f"step {index + 1} names a commit outside the range")
        kind = str(item["kind"])
        if (kind == "squash") != (len(sources) > 1):
            raise SurgeonError(f"step {index + 1}: only a squash joins several commits")
        message = _text(item.get("message"), MAX_MESSAGE)
        if not message.split("\n", 1)[0].strip():
            raise SurgeonError(f"step {index + 1} has no subject")
        paths: list[str] = []
        if kind == "split":
            files = {f.path for f in by_sha[sources[0]].files}
            raw_paths = item.get("paths")
            if not isinstance(raw_paths, list) or not all(
                isinstance(p, str) and p in files for p in raw_paths
            ):
                raise SurgeonError(
                    f"step {index + 1} splits files the commit does not touch"
                )
            paths = list(raw_paths)
        steps.append(Planned(f"p{index + 1}", kind, list(sources), message, "", paths))
    seen: list[str] = []
    for index, step in enumerate(steps):
        continuing = (
            step.kind == "split" and index > 0 and steps[index - 1].kind == "split"
        )
        if continuing and steps[index - 1].sources == step.sources:
            continue
        seen.extend(step.sources)
    if sorted(seen) != sorted(by_sha) or len(seen) != len(set(seen)):
        raise SurgeonError("the plan must hold every commit of the range exactly once")
    return steps


def _author_env(commit: Commit) -> dict[str, str]:
    env = dict(get_isolated_git_env())
    env.update(
        GIT_AUTHOR_NAME=commit.author_name,
        GIT_AUTHOR_EMAIL=commit.author_email,
        GIT_AUTHOR_DATE=commit.author_date,
    )
    return env


def _record(worktree: Path, parent: str, message: str, author: Commit) -> str:
    tree = git(worktree, "write-tree").strip()
    result = run_git(
        ["commit-tree", tree, "-p", parent, "-F", "-"],
        cwd=worktree,
        input_data=message + "\n",
        env=_author_env(author),
    )
    if result.returncode != 0:
        raise SurgeonError((result.stderr or "git commit-tree failed").strip()[:400])
    sha = result.stdout.strip()
    git(worktree, "reset", "-q", "--soft", sha)
    return sha


def _pick(worktree: Path, sha: str) -> None:
    result = run_git(["cherry-pick", "--no-commit", sha], cwd=worktree, timeout=120)
    if result.returncode != 0:
        raise SurgeonError(
            f"{sha[:8]} does not apply in its new place (a conflict): keep the commits in their order"
        )


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9._-]+", "-", text.lower()).strip("-.")[:40] or "head"


def branch_name(repo: Path, wanted: str | None, branch: str, now: datetime) -> str:
    name = wanted or f"surgeon/{_slug(branch)}-{now.strftime('%Y%m%d-%H%M%S')}"
    check = run_git(["check-ref-format", "--branch", name], cwd=repo)
    if check.returncode != 0 or name.startswith("-"):
        raise SurgeonError(f"not a branch name: {name[:80]!r}")
    if (
        run_git(
            ["rev-parse", "--verify", "--quiet", f"refs/heads/{name}"], cwd=repo
        ).returncode
        == 0
    ):
        raise SurgeonError(f"the branch {name} already exists")
    return name


def _replay(
    worktree: Path, base: str, steps: list[Planned], by_sha: dict[str, Commit]
) -> tuple[str, list[str]]:
    current = base
    made: list[str] = []
    index = 0
    while index < len(steps):
        step = steps[index]
        first = by_sha[step.sources[0]]
        unchanged = (
            step.kind == "keep"
            and first.parents == [current]
            and step.message == first.message.strip()
        )
        if unchanged:
            git(worktree, "reset", "-q", "--hard", first.sha)
            current = first.sha
            made.append(current)
            index += 1
            continue
        if step.kind == "split":
            parts = [step]
            while (
                index + len(parts) < len(steps)
                and steps[index + len(parts)].kind == "split"
                and steps[index + len(parts)].sources == step.sources
            ):
                parts.append(steps[index + len(parts)])
            _pick(worktree, first.sha)
            git(worktree, "reset", "-q")
            for number, part in enumerate(parts):
                if number == len(parts) - 1:
                    git(worktree, "add", "-A")
                elif part.paths:
                    git(
                        worktree,
                        "add",
                        "-A",
                        "--",
                        *[f":(literal){p}" for p in part.paths],
                    )
                current = _record(worktree, current, part.message, first)
                made.append(current)
            index += len(parts)
            continue
        for sha in step.sources:
            _pick(worktree, sha)
        current = _record(worktree, current, step.message, first)
        made.append(current)
        index += 1
    return current, made


def apply_plan(
    repo: Path,
    base: str,
    head: str,
    raw_plan: object,
    *,
    branch: str | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    """Replay ``raw_plan`` over ``base``; the new branch, or SurgeonError."""
    now = now or datetime.now(UTC)
    base_sha = verify(repo, base)
    head_sha = verify(repo, "HEAD")
    if head_sha != head:
        raise SurgeonError(
            "the branch moved since the plan was made: make the plan again"
        )
    commits = read_range(repo, base_sha, head_sha)
    steps = validate(raw_plan, commits)
    by_sha = {c.sha: c for c in commits}
    name = branch_name(repo, branch, current_branch(repo) or head_sha[:8], now)
    holder = Path(tempfile.mkdtemp(prefix="wp-surgeon-"))
    worktree = holder / "replay"
    git(
        repo,
        "worktree",
        "add",
        "--detach",
        "--quiet",
        str(worktree),
        base_sha,
        timeout=120,
    )
    try:
        new_head, made = _replay(worktree, base_sha, steps, by_sha)
        if (
            git(worktree, "rev-parse", f"{new_head}^{{tree}}").strip()
            != git(repo, "rev-parse", f"{head_sha}^{{tree}}").strip()
        ):
            raise SurgeonError(
                "the result's files differ from the branch: nothing was named"
            )
        git(repo, "branch", name, new_head)
    finally:
        run_git(["worktree", "remove", "--force", str(worktree)], cwd=repo, timeout=120)
        run_git(["worktree", "prune"], cwd=repo)
        shutil.rmtree(holder, ignore_errors=True)
    kept = sum(1 for sha in made if sha in by_sha)
    return {
        "branch": name,
        "head": new_head,
        "base": base_sha,
        "source": head_sha,
        "commits": len(made),
        "kept": kept,
        "treeMatches": True,
        "counts": {kind: sum(1 for s in steps if s.kind == kind) for kind in KINDS},
    }
