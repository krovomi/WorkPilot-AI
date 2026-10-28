"""One look at the PR, and the fix round when the policy asks for one.

`run_round` is the unit the runner repeats: read the PR, decide, and on FIX
give the QA fixer the failures and threads, check what it committed, push.
Every collaborator that touches the outside world (the forge, the fixer, git,
the push) is a parameter, so the tests run the whole round in a temp repo.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from foundation.git_executable import run_git

from .guards import Violation, check_fix_diff
from .model import Check, PRSnapshot, ReviewThread
from .policy import Decision, DecisionKind, FollowupConfig, decide
from .state import FollowupState, load_state, save_state

FIX_REQUEST = "QA_FIX_REQUEST.md"
_PLAN = "implementation_plan.json"
_THREAD_COMMENT_CHARS = 2_000


class Forge(Protocol):
    async def snapshot(self) -> PRSnapshot:
        """The PR as the forge sees it now: head, checks, review threads."""

    async def base_failing_names(self, base_branch: str) -> frozenset[str] | None:
        """Checks red on the base branch too, or None when the forge cannot say."""

    async def failed_log(self, check: Check) -> str:
        """The log of a failed check, as the forge serves it."""


Fixer = Callable[[Path, Path, int], Awaitable[tuple[str, str]]]
"""(worktree_dir, spec_dir, fix_session) -> (status, response), as
`qa.fixer.run_qa_fixer_session` returns it."""
Pusher = Callable[[], tuple[bool, str]]
"""Push the worktree's branch, never forced. (ok, error)."""


@dataclass
class RoundResult:
    decision: Decision
    action: str = "none"
    """none, fixed, no_change, reverted, push_failed, fixer_error, diverged."""
    head_sha: str = ""
    pushed_sha: str = ""
    detail: str = ""
    violations: list[Violation] = field(default_factory=list)

    @property
    def finished(self) -> bool:
        """The loop stops: a terminal decision, or a fix round that went wrong."""
        return self.decision.terminal or self.action in {
            "reverted",
            "push_failed",
            "fixer_error",
            "diverged",
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "decision": self.decision.kind.value,
            "reason": self.decision.reason,
            "action": self.action,
            "head_sha": self.head_sha,
            "pushed_sha": self.pushed_sha,
            "detail": self.detail,
            "failing": [c.name for c in self.decision.failing],
            "base_failing": [c.name for c in self.decision.base_failing],
            "threads": [t.id for t in self.decision.threads],
            "violations": [v.describe() for v in self.violations],
            "finished": self.finished,
        }


async def run_round(
    *,
    spec_dir: Path,
    worktree_dir: Path,
    forge: Forge,
    fixer: Fixer,
    pusher: Pusher,
    config: FollowupConfig | None = None,
) -> RoundResult:
    cfg = config or FollowupConfig()
    state = load_state(spec_dir)
    snap = await forge.snapshot()

    base_failing: frozenset[str] | None = None
    if not snap.error and any(c.state == "failed" for c in snap.checks):
        base_failing = await forge.base_failing_names(snap.base_branch)

    decision = decide(snap, state, cfg, base_failing)
    if snap.error or snap.checks:
        state.no_checks_polls = 0
    else:
        state.no_checks_polls += 1

    if decision.kind != DecisionKind.FIX:
        _remember(spec_dir, state, decision.kind.value, snap.head_sha, decision.reason)
        return RoundResult(decision, head_sha=snap.head_sha)

    # The fixer works on the commit the forge judged, nothing older or newer.
    synced, detail = _sync_worktree(worktree_dir, snap)
    if not synced:
        _remember(spec_dir, state, "diverged", snap.head_sha, detail)
        return RoundResult(
            decision, action="diverged", head_sha=snap.head_sha, detail=detail
        )

    before = snap.head_sha
    _write_fix_request(
        spec_dir, decision, await _logs(forge, decision.failing), state.rounds + 1
    )
    plan_before = _read_bytes(spec_dir / _PLAN)
    state.rounds += 1
    try:
        status, response = await fixer(worktree_dir, spec_dir, state.rounds)
    except Exception as exc:  # noqa: BLE001 - the round reports, the loop stops
        status, response = "error", str(exc)
    finally:
        # The follow-through keeps its own record; the build's sign-off stays
        # what the QA loop wrote.
        _restore_bytes(spec_dir / _PLAN, plan_before)
        (spec_dir / FIX_REQUEST).unlink(missing_ok=True)

    if status == "error":
        _remember(spec_dir, state, "fixer_error", before, response)
        return RoundResult(
            decision, action="fixer_error", head_sha=before, detail=response[:500]
        )

    after = _head(worktree_dir)
    for thread in decision.threads:
        state.handled_threads[thread.id] = thread.last_comment_id
    if not after or after == before:
        state.no_progress_heads.append(before)
        _remember(spec_dir, state, "no_change", before, "the fixer made no commit")
        return RoundResult(decision, action="no_change", head_sha=before)

    violations = check_fix_diff(
        _git(worktree_dir, ["diff", "--name-status", f"{before}..{after}"]),
        _git(worktree_dir, ["diff", "--unified=0", f"{before}..{after}"]),
    )
    if violations:
        run_git(["reset", "--hard", before], cwd=worktree_dir)
        detail = "; ".join(v.describe() for v in violations[:5])
        _remember(spec_dir, state, "reverted", before, detail)
        return RoundResult(
            decision,
            action="reverted",
            head_sha=before,
            detail=detail,
            violations=violations,
        )

    ok, error = pusher()
    if not ok:
        _remember(spec_dir, state, "push_failed", after, error)
        return RoundResult(
            decision, action="push_failed", head_sha=before, detail=error
        )

    state.last_pushed_sha = after
    _remember(spec_dir, state, "fixed", after, decision.reason)
    return RoundResult(decision, action="fixed", head_sha=before, pushed_sha=after)


def _remember(
    spec_dir: Path, state: FollowupState, kind: str, head: str, detail: str
) -> None:
    state.record(kind, head, detail)
    save_state(spec_dir, state)


def _git(cwd: Path, args: list[str]) -> str:
    result = run_git(args, cwd=cwd)
    return result.stdout if result.returncode == 0 else ""


def _head(cwd: Path) -> str:
    return _git(cwd, ["rev-parse", "HEAD"]).strip()


def _sync_worktree(worktree_dir: Path, snap: PRSnapshot) -> tuple[bool, str]:
    """Bring the worktree to the PR's head by fast-forward only.

    Someone may have pushed to the PR branch (a suggestion applied on the
    forge, a person's commit). A fast-forward takes it; anything else means
    the local branch has commits the PR has not, and fixing on top of them
    would push what nobody reviewed.
    """
    head = _head(worktree_dir)
    if not head:
        return False, "the task's worktree is not a git checkout"
    if head == snap.head_sha:
        return True, ""
    if snap.head_branch:
        run_git(["fetch", "origin", snap.head_branch], cwd=worktree_dir, timeout=120)
    merge = run_git(["merge", "--ff-only", snap.head_sha], cwd=worktree_dir)
    if merge.returncode != 0 or _head(worktree_dir) != snap.head_sha:
        return False, (
            f"the worktree is at {head[:12]} and cannot fast-forward to the PR head "
            f"{snap.head_sha[:12]}"
        )
    return True, ""


async def _logs(forge: Forge, failing: tuple[Check, ...]) -> dict[str, str]:
    return {check.name: await forge.failed_log(check) for check in failing}


def _write_fix_request(
    spec_dir: Path, decision: Decision, logs: dict[str, str], fix_round: int
) -> None:
    from security.untrusted import quote_untrusted

    lines = [
        f"# PR follow-up fix request (round {fix_round})",
        "",
        "The pull request of this task is open. Fix what is listed below in this",
        "worktree, run the tests that cover it, and commit (never push: WorkPilot",
        "pushes after checking the commit). A fix that skips, deletes or disables a",
        "test, or edits a CI pipeline file, is undone before it is pushed.",
        "",
    ]
    for idx, check in enumerate(decision.failing, start=1):
        lines += [f"{idx}. [ci] Check `{check.name}` failed", ""]
        log = quote_untrusted(
            logs.get(check.name, ""),
            kind="diff",
            source=f"ci:{check.name}",
            spec_dir=spec_dir,
        )
        lines += ["   Failed steps' log (tail):", "", "```text", log, "```", ""]
    offset = len(decision.failing)
    for idx, thread in enumerate(decision.threads, start=offset + 1):
        where = thread.path + (f":{thread.line}" if thread.line else "")
        lines += [f"{idx}. [review] Unresolved review thread — `{where}`", ""]
        lines += _thread_lines(thread, spec_dir)
    if decision.base_failing:
        names = ", ".join(f"`{c.name}`" for c in decision.base_failing)
        lines += [
            f"Not to fix: {names} fail on the base branch too; they are not this PR's.",
            "",
        ]
    (spec_dir / FIX_REQUEST).write_text("\n".join(lines) + "\n", encoding="utf-8")


def _thread_lines(thread: ReviewThread, spec_dir: Path) -> list[str]:
    from security.untrusted import quote_untrusted

    out = []
    for comment in thread.comments:
        body = quote_untrusted(
            comment.body[:_THREAD_COMMENT_CHARS],
            kind="comment",
            source=f"review:{comment.url or thread.id}",
            spec_dir=spec_dir,
        )
        out += [f"   {comment.author} wrote:", "", body, ""]
    return out


def _read_bytes(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except OSError:
        return None


def _restore_bytes(path: Path, content: bytes | None) -> None:
    if content is None or path.is_symlink():
        return
    try:
        if path.read_bytes() != content:
            path.write_bytes(content)
    except OSError:
        path.write_bytes(content)
