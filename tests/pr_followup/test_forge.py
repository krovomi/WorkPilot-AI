"""The GitHub adapter, driven by recorded `gh` answers."""

from __future__ import annotations

import json

from pr_followup.forge import GitHubForge, forge_for_url, parse_github_pr_url
from pr_followup.model import CheckState


class FakeGh:
    def __init__(self, answers: dict[str, tuple[int, str, str]]):
        self.answers = answers
        self.calls: list[list[str]] = []

    async def __call__(self, args: list[str]) -> tuple[int, str, str]:
        self.calls.append(args)
        key = " ".join(args[:2])
        return self.answers.get(key, (1, "", f"unexpected gh {key}"))


VIEW = json.dumps(
    {
        "number": 7,
        "state": "OPEN",
        "headRefOid": "abc123",
        "headRefName": "workpilot/7-x",
        "baseRefName": "main",
    }
)
CHECKS = json.dumps(
    [
        {
            "name": "unit",
            "bucket": "fail",
            "link": "https://github.com/acme/app/actions/runs/11/job/22",
        },
        {"name": "lint", "bucket": "pass", "link": ""},
        {"name": "docs", "bucket": "skipping", "link": ""},
        {"name": "odd", "bucket": "something-new", "link": ""},
    ]
)
THREADS = json.dumps(
    {
        "data": {
            "repository": {
                "pullRequest": {
                    "reviewThreads": {
                        "nodes": [
                            {
                                "id": "T1",
                                "isResolved": False,
                                "isOutdated": False,
                                "path": "a.py",
                                "line": 4,
                                "comments": {
                                    "nodes": [
                                        {
                                            "id": "C1",
                                            "body": "rename",
                                            "url": "u",
                                            "author": {"login": "r"},
                                        }
                                    ]
                                },
                            },
                            {
                                "id": "T2",
                                "isResolved": True,
                                "isOutdated": False,
                                "path": "b.py",
                                "line": 1,
                                "comments": {"nodes": []},
                            },
                            {
                                "id": "T3",
                                "isResolved": False,
                                "isOutdated": True,
                                "path": "c.py",
                                "line": 1,
                                "comments": {"nodes": []},
                            },
                        ]
                    }
                }
            }
        }
    }
)


def _forge(answers: dict[str, tuple[int, str, str]]) -> tuple[GitHubForge, FakeGh]:
    gh = FakeGh(answers)
    forge = GitHubForge(parse_github_pr_url("https://github.com/acme/app/pull/7"), gh)
    return forge, gh


def test_only_github_pull_request_urls_are_followed(tmp_path) -> None:
    assert parse_github_pr_url("https://github.com/acme/app/pull/7").number == 7
    assert parse_github_pr_url("https://github.com/acme/app/pull/7/files") is None
    assert parse_github_pr_url("https://gitlab.com/acme/app/-/merge_requests/7") is None
    assert parse_github_pr_url("https://github.com/acme/app/pull/7;rm -rf") is None
    assert (
        forge_for_url("https://dev.azure.com/o/p/_git/r/pullrequest/1", tmp_path)
        is None
    )


async def test_snapshot_reads_checks_and_open_threads() -> None:
    forge, gh = _forge(
        {
            "pr view": (0, VIEW, ""),
            "pr checks": (1, CHECKS, ""),
            "api graphql": (0, THREADS, ""),
        }
    )
    snap = await forge.snapshot()
    assert snap.error == ""
    assert snap.head_sha == "abc123" and snap.base_branch == "main"
    states = {c.name: c.state for c in snap.checks}
    assert states == {
        "unit": CheckState.FAILED,
        "lint": CheckState.PASSED,
        "docs": CheckState.PASSED,
        # A bucket gh did not have when this was written is not taken as a pass.
        "odd": CheckState.PENDING,
    }
    unit = next(c for c in snap.checks if c.name == "unit")
    assert (unit.run_id, unit.job_id) == ("11", "22")
    assert [t.id for t in snap.threads] == ["T1"]
    # Every call is an argument list naming the repository explicitly.
    assert all("-R" in call or call[0] == "api" for call in gh.calls)


async def test_a_failed_checks_call_is_an_error_not_an_empty_green() -> None:
    forge, _ = _forge(
        {
            "pr view": (0, VIEW, ""),
            "pr checks": (4, "", "HTTP 401: Bad credentials"),
            "api graphql": (0, THREADS, ""),
        }
    )
    snap = await forge.snapshot()
    assert snap.error.startswith("HTTP 401")
    assert snap.checks == ()


async def test_no_checks_reported_is_an_empty_list() -> None:
    forge, _ = _forge(
        {
            "pr view": (0, VIEW, ""),
            "pr checks": (1, "", "no checks reported on the 'x' branch"),
            "api graphql": (0, THREADS, ""),
        }
    )
    snap = await forge.snapshot()
    assert snap.error == "" and snap.checks == ()


async def test_unreadable_threads_make_the_snapshot_an_error() -> None:
    forge, _ = _forge(
        {
            "pr view": (0, VIEW, ""),
            "pr checks": (0, "[]", ""),
            "api graphql": (1, "", "boom"),
        }
    )
    assert (await forge.snapshot()).error == "boom"


async def test_base_failures_and_a_hostile_branch_name() -> None:
    runs = json.dumps(
        {
            "check_runs": [
                {"name": "e2e", "conclusion": "failure"},
                {"name": "unit", "conclusion": "success"},
                {"name": "slow", "conclusion": "timed_out"},
            ]
        }
    )
    forge, gh = _forge(
        {"api repos/acme/app/commits/main/check-runs?per_page=100": (0, runs, "")}
    )
    # FakeGh keys on the first two args; the second is the whole endpoint.
    assert await forge.base_failing_names("main") == frozenset({"e2e", "slow"})
    assert await forge.base_failing_names("main; echo") is None
    assert await forge.base_failing_names("") is None
    assert len(gh.calls) == 1
