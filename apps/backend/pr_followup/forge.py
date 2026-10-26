"""Reading a GitHub pull request through the `gh` CLI.

GitHub only, for now: the URL decides, and a GitLab or Azure DevOps URL gets
`None` from `forge_for_url`, which the runner reports as unsupported instead
of pretending to follow it. Every command is an argument list, never a shell
string; the PR URL is parsed and only its owner, name and number reach argv.

`gh` is injected (`GhRun`) so the tests drive the adapter with recorded
answers and no network.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .model import Check, CheckState, PRSnapshot, ReviewComment, ReviewThread

GhRun = Callable[[list[str]], Awaitable[tuple[int, str, str]]]
"""(args) -> (returncode, stdout, stderr), args without the `gh` itself."""

_GITHUB_PR = re.compile(
    r"^https://github\.com/(?P<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/"
    r"(?P<repo>[A-Za-z0-9._-]{1,100})/pull/(?P<number>[0-9]{1,9})/?(?:[#?].*)?$"
)
_JOB_LINK = re.compile(r"/actions/runs/(?P<run>[0-9]+)/job/(?P<job>[0-9]+)")
_GH_TIMEOUT_SECONDS = 60
LOG_TAIL_CHARS = 8_000

_THREADS_QUERY = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line
          comments(last: 20) { nodes { id body url author { login } } }
        }
      }
    }
  }
}
""".strip()

# `gh pr checks --json bucket`: pass, fail, pending, skipping, cancel.
_BUCKETS = {
    "pass": CheckState.PASSED,
    "skipping": CheckState.PASSED,
    "fail": CheckState.FAILED,
    "cancel": CheckState.FAILED,
    "pending": CheckState.PENDING,
}
_BASE_FAILED_CONCLUSIONS = frozenset({"failure", "timed_out", "startup_failure"})


@dataclass(frozen=True)
class GitHubPR:
    owner: str
    repo: str
    number: int

    @property
    def slug(self) -> str:
        return f"{self.owner}/{self.repo}"

    @property
    def url(self) -> str:
        return f"https://github.com/{self.slug}/pull/{self.number}"


def parse_github_pr_url(url: str) -> GitHubPR | None:
    match = _GITHUB_PR.match((url or "").strip())
    if not match:
        return None
    return GitHubPR(match["owner"], match["repo"], int(match["number"]))


def subprocess_gh(cwd: Path) -> GhRun:
    """The real `gh`, run in `cwd` with a timeout. A missing binary is an
    error return, not an exception: the snapshot carries it as `error`."""

    async def run(args: list[str]) -> tuple[int, str, str]:
        from core.gh_executable import get_gh_executable

        gh = get_gh_executable()
        if not gh:
            return 127, "", "GitHub CLI (gh) not found"
        proc = await asyncio.create_subprocess_exec(
            gh,
            *args,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), _GH_TIMEOUT_SECONDS)
        except TimeoutError:
            proc.kill()
            await proc.wait()
            return 124, "", f"gh {args[0]} timed out after {_GH_TIMEOUT_SECONDS}s"
        return (
            proc.returncode or 0,
            out.decode("utf-8", "replace"),
            err.decode("utf-8", "replace"),
        )

    return run


class GitHubForge:
    def __init__(self, pr: GitHubPR, gh: GhRun):
        self.pr = pr
        self._gh = gh

    async def snapshot(self) -> PRSnapshot:
        pr = self.pr
        code, out, err = await self._gh(
            [
                "pr",
                "view",
                str(pr.number),
                "-R",
                pr.slug,
                "--json",
                "number,state,headRefOid,headRefName,baseRefName",
            ]
        )
        if code != 0:
            return PRSnapshot(
                url=pr.url,
                number=pr.number,
                error=_first_line(err, "gh pr view failed"),
            )
        try:
            view = json.loads(out)
        except ValueError:
            return PRSnapshot(
                url=pr.url, number=pr.number, error="gh pr view returned no JSON"
            )

        # `gh pr checks` exits 1 when a check failed and 8 while one is
        # pending: the exit code is part of the answer, the JSON is the answer.
        code, out, err = await self._gh(
            [
                "pr",
                "checks",
                str(pr.number),
                "-R",
                pr.slug,
                "--json",
                "name,bucket,link",
            ]
        )
        checks: list[Check] = []
        if out.strip():
            try:
                rows = json.loads(out)
            except ValueError:
                return _view_error(pr, view, "gh pr checks returned no JSON")
            checks = [_check(row) for row in rows if isinstance(row, dict)]
        elif code not in (0, 1, 8) and "no checks reported" not in err.lower():
            return _view_error(pr, view, _first_line(err, "gh pr checks failed"))

        threads, error = await self._threads()
        if error:
            return _view_error(pr, view, error)

        return PRSnapshot(
            url=pr.url,
            number=int(view.get("number") or pr.number),
            state=str(view.get("state") or "OPEN"),
            head_sha=str(view.get("headRefOid") or ""),
            head_branch=str(view.get("headRefName") or ""),
            base_branch=str(view.get("baseRefName") or ""),
            checks=tuple(checks),
            threads=tuple(threads),
        )

    async def _threads(self) -> tuple[list[ReviewThread], str]:
        pr = self.pr
        code, out, err = await self._gh(
            [
                "api",
                "graphql",
                "-f",
                f"query={_THREADS_QUERY}",
                "-F",
                f"owner={pr.owner}",
                "-F",
                f"name={pr.repo}",
                "-F",
                f"number={pr.number}",
            ]
        )
        if code != 0:
            return [], _first_line(err, "review threads could not be read")
        try:
            nodes = json.loads(out)["data"]["repository"]["pullRequest"][
                "reviewThreads"
            ]["nodes"]
        except (ValueError, KeyError, TypeError):
            return [], "review threads: unexpected answer"
        threads = []
        for node in nodes or []:
            if (
                not isinstance(node, dict)
                or node.get("isResolved")
                or node.get("isOutdated")
            ):
                continue
            comments = tuple(
                ReviewComment(
                    id=str(c.get("id") or ""),
                    author=str((c.get("author") or {}).get("login") or "unknown"),
                    body=str(c.get("body") or ""),
                    url=str(c.get("url") or ""),
                )
                for c in ((node.get("comments") or {}).get("nodes") or [])
                if isinstance(c, dict)
            )
            line = node.get("line")
            threads.append(
                ReviewThread(
                    id=str(node.get("id") or ""),
                    path=str(node.get("path") or ""),
                    line=line if isinstance(line, int) else None,
                    comments=comments,
                )
            )
        return threads, ""

    async def base_failing_names(self, base_branch: str) -> frozenset[str] | None:
        """Check names failing on the base branch's head, None if unknown."""
        if not base_branch or not re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", base_branch):
            return None
        code, out, _err = await self._gh(
            [
                "api",
                f"repos/{self.pr.slug}/commits/{base_branch}/check-runs?per_page=100",
            ]
        )
        if code != 0:
            return None
        try:
            runs = json.loads(out).get("check_runs") or []
        except (ValueError, AttributeError):
            return None
        return frozenset(
            str(r.get("name"))
            for r in runs
            if isinstance(r, dict) and r.get("conclusion") in _BASE_FAILED_CONCLUSIONS
        )

    async def failed_log(self, check: Check) -> str:
        """The tail of the failed steps' log, or a line saying why there is none."""
        if not (check.run_id and check.job_id):
            return (
                f"(no log: {check.name} is not a GitHub Actions job; see {check.link})"
            )
        code, out, err = await self._gh(
            [
                "run",
                "view",
                check.run_id,
                "-R",
                self.pr.slug,
                "--job",
                check.job_id,
                "--log-failed",
            ]
        )
        if code != 0:
            return f"(no log: {_first_line(err, 'gh run view failed')})"
        return out[-LOG_TAIL_CHARS:]


def forge_for_url(url: str, cwd: Path, gh: GhRun | None = None) -> GitHubForge | None:
    pr = parse_github_pr_url(url)
    if pr is None:
        return None
    return GitHubForge(pr, gh or subprocess_gh(cwd))


def _check(row: dict[str, Any]) -> Check:
    link = str(row.get("link") or "")
    match = _JOB_LINK.search(link)
    return Check(
        name=str(row.get("name") or "unnamed check"),
        state=_BUCKETS.get(str(row.get("bucket") or "").lower(), CheckState.PENDING),
        link=link,
        run_id=match["run"] if match else "",
        job_id=match["job"] if match else "",
    )


def _view_error(pr: GitHubPR, view: dict[str, Any], error: str) -> PRSnapshot:
    return PRSnapshot(
        url=pr.url,
        number=pr.number,
        state=str(view.get("state") or "OPEN"),
        head_sha=str(view.get("headRefOid") or ""),
        error=error,
    )


def _first_line(text: str, fallback: str) -> str:
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()[:300]
    return fallback
