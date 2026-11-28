"""The `gh` client every GitHub workflow goes through.

`GHClient` runs the GitHub CLI for the PR review, the follow-up review, the
issue triage and the auto-fix: it bounds each command with a timeout, retries
a hung one, keeps under GitHub's rate limit and turns the CLI's answers into
data. These tests drive it against a fake `gh` (tests/gh_fake.py) that answers
chosen commands and records each one, so every call is checked the way GitHub
would receive it: which command, which method, against which repository.
"""

from __future__ import annotations

import asyncio
import importlib
import json

import pytest
from runners.github.gh_client import (
    GHClient,
    GHCommandError,
    GHTimeoutError,
    PRTooLargeError,
)
from runners.github.rate_limiter import RateLimitExceeded

REPO = "own/repo"


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def fresh_rate_limiter():
    """Each test starts with GitHub's full hourly budget, and leaves it so."""
    limiter = importlib.import_module("runners.github.gh_client").RateLimiter
    limiter.reset_instance()
    yield limiter
    limiter.reset_instance()


@pytest.fixture
def client(tmp_path, gh):
    return GHClient(project_dir=tmp_path, repo=REPO)


@pytest.fixture
def local_client(tmp_path, gh):
    """A client that lets `gh` infer the repository from the clone."""
    return GHClient(project_dir=tmp_path)


# --- running a command ------------------------------------------------------


def test_a_command_returns_what_gh_printed(client, gh):
    gh.answer({"pr list": {"stdout": "[]", "stderr": "note"}})
    result = run(client.run(["pr", "list"]))
    assert (result.stdout, result.stderr, result.returncode) == ("[]", "note", 0)
    assert result.attempts == 1
    assert result.command[1:] == ["pr", "list"]


def test_every_command_runs_against_the_configured_repository(client, gh):
    gh.answer({"api": {"stdout": "{}"}})
    run(client.run(["api", "repos/{owner}/{repo}/pulls/7/reviews"]))
    assert gh.repos() == [REPO]


def test_without_a_repository_gh_infers_it_from_the_clone(local_client, gh):
    gh.answer({"api": {"stdout": "{}"}})
    run(local_client.run(["api", "user"]))
    assert gh.repos() == [None]


def test_a_failed_command_raises_with_gh_error_text(client, gh):
    gh.answer({"pr view": {"stderr": "no pull requests found", "code": 1}})
    with pytest.raises(GHCommandError, match="no pull requests found"):
        run(client.run(["pr", "view", "9"]))


def test_a_failure_without_error_text_still_says_it_failed(client, gh):
    gh.answer({"pr view": {"code": 1}})
    with pytest.raises(GHCommandError, match="Unknown error"):
        run(client.run(["pr", "view", "9"]))


def test_a_failure_can_be_returned_instead_of_raised(client, gh):
    gh.answer({"label delete": {"stderr": "not found", "code": 1}})
    result = run(client.run(["label", "delete", "x"], raise_on_error=False))
    assert (result.returncode, result.stderr) == (1, "not found")


def test_a_rate_limit_answer_is_reported_as_such_and_counted(
    client, gh, fresh_rate_limiter
):
    gh.answer({"api": {"stderr": "HTTP 403: API rate limit exceeded", "code": 1}})
    with pytest.raises(RateLimitExceeded, match="403"):
        run(client.run(["api", "user"], raise_on_error=False))
    assert fresh_rate_limiter.get_instance().statistics()["github"]["errors"] == 1


def test_a_rate_limit_answer_is_reported_without_the_limiter_too(tmp_path, gh):
    unlimited = GHClient(project_dir=tmp_path, enable_rate_limiting=False)
    gh.answer({"api": {"stderr": "secondary rate limit", "code": 1}})
    with pytest.raises(RateLimitExceeded):
        run(unlimited.run(["api", "user"]))


def test_a_hung_command_is_retried_then_reported_as_timed_out(tmp_path, gh):
    patient = GHClient(project_dir=tmp_path, max_retries=2)
    gh.answer({"pr diff": {"sleep": 30, "stdout": "late"}})
    with pytest.raises(GHTimeoutError, match="timed out after 2 attempts"):
        run(patient.run(["pr", "diff", "7"], timeout=0.5))
    assert gh.calls() == [["pr", "diff", "7"], ["pr", "diff", "7"]]


def test_a_command_that_cannot_start_is_retried_then_reported(tmp_path, gh):
    nowhere = GHClient(project_dir=tmp_path / "deleted-clone", max_retries=2)
    with pytest.raises(GHCommandError, match="deleted-clone"):
        run(nowhere.run(["pr", "list"]))
    assert gh.calls() == []


def test_a_client_allowed_no_attempt_never_runs_gh(tmp_path, gh):
    idle = GHClient(project_dir=tmp_path, max_retries=0)
    with pytest.raises(GHCommandError, match="after 0 attempts"):
        run(idle.run(["pr", "list"]))
    assert gh.calls() == []


def test_without_gh_installed_the_error_says_where_to_get_it(client, gh, monkeypatch):
    module = importlib.import_module("runners.github.gh_client")
    monkeypatch.setattr(module, "get_gh_executable", lambda: None)
    with pytest.raises(GHCommandError, match="https://cli.github.com/"):
        run(client.run(["pr", "list"]))


def test_an_exhausted_budget_that_never_refills_stops_before_gh(
    tmp_path, gh, fresh_rate_limiter
):
    fresh_rate_limiter.get_instance(github_limit=1, github_refill_rate=0)
    gh.answer({"api": {"stdout": "{}"}})
    limited = GHClient(project_dir=tmp_path)
    run(limited.run(["api", "user"]))
    with pytest.raises(RateLimitExceeded, match="does not replenish"):
        run(limited.run(["api", "user"]))
    assert gh.calls() == [["api", "user"]]


def test_an_exhausted_budget_waits_for_the_next_token(tmp_path, gh, fresh_rate_limiter):
    fresh_rate_limiter.get_instance(github_limit=1, github_refill_rate=1.0)
    gh.answer({"api": {"stdout": "{}"}})
    limited = GHClient(project_dir=tmp_path)
    run(limited.run(["api", "user"]))
    run(limited.run(["api", "user"]))
    assert gh.calls() == [["api", "user"], ["api", "user"]]
    assert (
        fresh_rate_limiter.get_instance().statistics()["github"]["total_requests"] == 2
    )


# --- pull requests ----------------------------------------------------------


def test_pull_requests_are_listed_from_the_configured_repository(client, gh):
    gh.answer({"pr list": {"stdout": json.dumps([{"number": 7}])}})
    assert run(client.pr_list()) == [{"number": 7}]
    assert run(client.pr_list(state="all", limit=5, json_fields=["url"])) == [
        {"number": 7}
    ]
    assert gh.calls() == [
        [
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "number,title,state,author,headRefName,baseRefName",
            "-R",
            REPO,
        ],
        ["pr", "list", "--state", "all", "--limit", "5", "--json", "url", "-R", REPO],
    ]


def test_without_a_repository_no_repository_flag_is_sent(local_client, gh):
    gh.answer({"pr list": {"stdout": "[]"}})
    run(local_client.pr_list(json_fields=["number"]))
    assert gh.calls() == [
        ["pr", "list", "--state", "open", "--limit", "100", "--json", "number"]
    ]


PR_FIELDS = (
    "number,title,body,state,headRefName,baseRefName,author,files,"
    "additions,deletions,changedFiles"
)


def test_a_pull_request_is_read_with_its_files_by_default(client, gh):
    gh.answer({"pr view 7": {"stdout": json.dumps({"number": 7})}})
    assert run(client.pr_get(7)) == {"number": 7}
    assert gh.calls()[0] == [
        "pr",
        "view",
        "7",
        "--json",
        PR_FIELDS,
        "-R",
        REPO,
    ]


def test_a_pull_request_diff_is_returned_as_text(client, gh):
    gh.answer({"pr diff 7": {"stdout": "diff --git a/x b/x\n"}})
    assert run(client.pr_diff(7)) == "diff --git a/x b/x\n"
    assert gh.calls() == [["pr", "diff", "7", "-R", REPO]]


@pytest.mark.parametrize(
    "error",
    [
        "could not find pull request diff: diff exceeded the maximum number of lines",
        "HTTP 406: Sorry, the diff is too large",
    ],
)
def test_a_diff_too_large_for_github_says_so(client, gh, error):
    gh.answer({"pr diff 7": {"stderr": error, "code": 1}})
    with pytest.raises(PRTooLargeError, match="20,000 line"):
        run(client.pr_diff(7))


def test_another_diff_failure_is_left_as_it_is(client, gh):
    gh.answer({"pr diff 7": {"stderr": "no pull requests found", "code": 1}})
    with pytest.raises(GHCommandError, match="no pull requests found"):
        run(client.pr_diff(7))


def test_a_review_is_posted_with_the_requested_verdict(client, gh):
    gh.answer({"pr review 7": {}})
    assert run(client.pr_review(7, "Looks good", event="APPROVE")) == 0
    run(client.pr_review(7, "Fix it", event="request_changes"))
    run(client.pr_review(7, "Fix it", event="request-changes"))
    run(client.pr_review(7, "Noted"))
    verdicts = [call[3] for call in gh.calls()]
    assert verdicts == [
        "--approve",
        "--request-changes",
        "--request-changes",
        "--comment",
    ]
    # The body goes on stdin, never on the command line.
    assert gh.calls()[0][4:] == ["--body-file", "-", "-R", REPO]
    assert gh.stdins() == ["Looks good", "Fix it", "Fix it", "Noted"]


def test_a_merge_sends_the_method_and_the_optional_message(client, gh):
    gh.answer({"pr merge 7": {}})
    run(client.pr_merge(7))
    run(client.pr_merge(7, "rebase", commit_title="Title", commit_message="Body"))
    assert gh.calls() == [
        ["pr", "merge", "7", "--squash", "-R", REPO],
        [
            "pr",
            "merge",
            "7",
            "--rebase",
            "--subject",
            "Title",
            "--body-file",
            "-",
            "-R",
            REPO,
        ],
    ]
    assert gh.stdins() == [None, "Body"]


def test_a_pull_request_comment_goes_to_the_configured_repository(client, gh):
    gh.answer({"pr comment 7": {}})
    run(client.pr_comment(7, "Thanks"))
    assert gh.calls() == [["pr", "comment", "7", "--body-file", "-", "-R", REPO]]
    assert gh.stdins() == ["Thanks"]


def test_the_assignees_of_a_pull_request_are_their_logins(client, gh):
    gh.answer({"pr view 7": {"stdout": json.dumps({"assignees": [{"login": "ann"}]})}})
    assert run(client.pr_get_assignees(7)) == ["ann"]
    gh.answer({"pr view 7": {"stdout": "{}"}})
    assert run(client.pr_get_assignees(7)) == []


def test_assigning_sends_the_logins_as_an_array(client, gh):
    gh.answer({"api": {"stdout": "{}"}})
    run(client.pr_assign(7, ["ann", "bob"]))
    assert gh.calls() == [
        [
            "api",
            "/repos/{owner}/{repo}/issues/7/assignees",
            "-X",
            "POST",
            "-f",
            "assignees[]=ann",
            "-f",
            "assignees[]=bob",
        ]
    ]
    assert gh.repos() == [REPO]


def test_assigning_nobody_sends_nothing(client, gh):
    run(client.pr_assign(7, []))
    assert gh.calls() == []


def test_the_head_of_a_pull_request_is_its_last_commit(client, gh):
    commits = {"commits": [{"oid": "aaa"}, {"oid": "bbb"}]}
    gh.answer({"pr view 7 --json commits": {"stdout": json.dumps(commits)}})
    assert run(client.get_pr_head_sha(7)) == "bbb"
    gh.answer({"pr view 7 --json commits": {"stdout": json.dumps({"commits": []})}})
    assert run(client.get_pr_head_sha(7)) is None


# --- issues -----------------------------------------------------------------


def test_issues_are_read_from_the_configured_repository(client, gh):
    gh.answer(
        {
            "issue list": {"stdout": json.dumps([{"number": 5}])},
            "issue view 5": {"stdout": json.dumps({"number": 5})},
        }
    )
    assert run(client.issue_list()) == [{"number": 5}]
    assert run(client.issue_get(5)) == {"number": 5}
    run(client.issue_list(state="closed", limit=3, json_fields=["number"]))
    run(client.issue_get(5, json_fields=["title"]))
    calls = gh.calls()
    assert calls[0][:6] == ["issue", "list", "--state", "open", "--limit", "100"]
    assert calls[0][-2:] == ["-R", REPO]
    assert calls[1][:3] == ["issue", "view", "5"] and calls[1][-2:] == ["-R", REPO]
    assert calls[2] == [
        "issue",
        "list",
        "--state",
        "closed",
        "--limit",
        "3",
        "--json",
        "number",
        "-R",
        REPO,
    ]
    assert calls[3] == ["issue", "view", "5", "--json", "title", "-R", REPO]


def test_issue_comments_and_labels_go_to_the_configured_repository(client, gh):
    gh.answer({"issue comment 5": {}, "issue edit 5": {}})
    run(client.issue_comment(5, "Triaged"))
    run(client.issue_add_labels(5, ["bug", "p1"]))
    run(client.issue_remove_labels(5, ["needs-triage"]))
    assert gh.calls() == [
        ["issue", "comment", "5", "--body-file", "-", "-R", REPO],
        ["issue", "edit", "5", "--add-label", "bug,p1", "-R", REPO],
        ["issue", "edit", "5", "--remove-label", "needs-triage", "-R", REPO],
    ]
    assert gh.stdins() == ["Triaged", None, None]


def test_no_labels_means_no_edit(client, gh):
    run(client.issue_add_labels(5, []))
    run(client.issue_remove_labels(5, []))
    assert gh.calls() == []


def test_removing_a_label_the_issue_does_not_have_is_not_an_error(client, gh):
    gh.answer({"issue edit 5": {"stderr": "label not found", "code": 1}})
    run(client.issue_remove_labels(5, ["gone"]))
    assert len(gh.calls()) == 1


# --- REST API ---------------------------------------------------------------


def test_an_api_read_is_a_get_even_with_query_parameters(client, gh):
    gh.answer({"api --method GET": {"stdout": json.dumps([{"id": 1}])}})
    assert run(client.api_get("/repos/own/repo/issues")) == [{"id": 1}]
    run(client.api_get("/repos/own/repo/issues", {"state": "all", "per_page": "5"}))
    assert gh.calls() == [
        ["api", "--method", "GET", "/repos/own/repo/issues"],
        [
            "api",
            "--method",
            "GET",
            "/repos/own/repo/issues",
            "-f",
            "state=all",
            "-f",
            "per_page=5",
        ],
    ]


def test_two_commits_are_compared_through_the_api(client, gh):
    comparison = {"ahead_by": 2, "commits": [], "files": []}
    gh.answer({"api": {"stdout": json.dumps(comparison)}})
    assert run(client.compare_commits("aaa", "bbb")) == comparison
    assert gh.calls() == [["api", "repos/{owner}/{repo}/compare/aaa...bbb"]]
    assert gh.repos() == [REPO]


def _comments_key(kind: str, since: str) -> str:
    return f"api --method GET repos/{{owner}}/{{repo}}/{kind}/7/comments?since={since}"


def test_comments_since_a_review_are_read_from_both_threads(client, gh):
    since = "2026-11-01T10:00:00Z"
    gh.answer(
        {
            _comments_key("pulls", since): {"stdout": json.dumps([{"id": 1}])},
            _comments_key("issues", since): {"stdout": json.dumps([{"id": 2}])},
        }
    )
    assert run(client.get_comments_since(7, since)) == {
        "review_comments": [{"id": 1}],
        "issue_comments": [{"id": 2}],
    }


def test_unreadable_or_failed_comment_reads_count_as_none(client, gh):
    since = "2026-11-01T10:00:00Z"
    gh.answer(
        {
            _comments_key("pulls", since): {"stdout": "not json"},
            _comments_key("issues", since): {"stdout": "<html>"},
        }
    )
    empty = {"review_comments": [], "issue_comments": []}
    assert run(client.get_comments_since(7, since)) == empty
    gh.answer({"api": {"stderr": "Not Found", "code": 1}})
    assert run(client.get_comments_since(7, since)) == empty


REVIEWS_KEY = "api --method GET repos/{owner}/{repo}/pulls/7/reviews"


def test_only_reviews_submitted_after_the_last_one_are_kept(client, gh):
    reviews = [
        {"id": 1, "submitted_at": "2026-11-01T09:00:00Z"},  # before
        {"id": 2, "submitted_at": "2026-11-01T11:00:00Z"},  # after
        {"id": 3, "submitted_at": "2026-11-01T12:00:00"},  # after, no zone: UTC
        {"id": 4, "submitted_at": "yesterday"},  # unreadable date: kept
        {"id": 5, "submitted_at": ""},  # pending, never submitted
        {"id": 6},
    ]
    gh.answer({REVIEWS_KEY: {"stdout": json.dumps(reviews)}})
    kept = run(client.get_reviews_since(7, "2026-11-01T10:00:00Z"))
    assert [r["id"] for r in kept] == [2, 3, 4]
    naive = run(client.get_reviews_since(7, "2026-11-01T10:00:00"))
    assert [r["id"] for r in naive] == [2, 3, 4]


def test_unreadable_or_failed_review_reads_count_as_none(client, gh):
    gh.answer({REVIEWS_KEY: {"stdout": "not json"}})
    assert run(client.get_reviews_since(7, "2026-11-01T10:00:00Z")) == []
    gh.answer({REVIEWS_KEY: {"stderr": "Not Found", "code": 1}})
    assert run(client.get_reviews_since(7, "2026-11-01T10:00:00Z")) == []


# --- CI checks and workflow approvals ---------------------------------------


def test_checks_are_counted_by_outcome(client, gh):
    checks = [
        {"name": "lint", "state": "SUCCESS"},
        {"name": "docs", "state": "skipped"},
        {"name": "fmt", "state": "NEUTRAL"},
        {"name": "test", "state": "FAILURE"},
        {"name": "e2e", "state": "TIMED_OUT"},
        {"name": "build", "state": "IN_PROGRESS"},
        {},
    ]
    gh.answer({"pr checks 7": {"stdout": json.dumps(checks)}})
    status = run(client.get_pr_checks(7))
    assert (status["passing"], status["failing"], status["pending"]) == (3, 2, 2)
    assert status["failed_checks"] == ["test", "e2e"]
    assert gh.calls() == [["pr", "checks", "7", "--json", "name,state", "-R", REPO]]


def test_a_pull_request_without_checks_has_none(client, gh):
    gh.answer({"pr checks 7": {"stdout": "  \n"}})
    status = run(client.get_pr_checks(7))
    assert status["checks"] == [] and status["pending"] == 0


def test_unreadable_checks_are_reported_as_an_error(client, gh):
    gh.answer({"pr checks 7": {"stderr": "no checks reported", "code": 1}})
    status = run(client.get_pr_checks(7))
    assert status["failing"] == 0 and "no checks reported" in status["error"]


RUNS_KEY = (
    "api --method GET repos/{owner}/{repo}/actions/runs"
    " -f status=action_required -f per_page=100"
)


def test_fork_workflows_awaiting_approval_are_those_of_the_pr_head(client, gh):
    runs = {
        "workflow_runs": [
            {
                "id": 11,
                "name": "CI",
                "html_url": "https://github.com/own/repo/actions/runs/11",
                "head_sha": "head1",
                "workflow": {"name": "ci.yml"},
            },
            {"id": 12, "name": "Other PR", "head_sha": "elsewhere"},
            {"id": 13, "name": "Bare", "head_sha": "head1"},
        ]
    }
    gh.answer(
        {
            "pr view 7 --json headRefOid": {
                "stdout": json.dumps({"headRefOid": "head1"})
            },
            RUNS_KEY: {"stdout": json.dumps(runs)},
        }
    )
    awaiting = run(client.get_workflows_awaiting_approval(7))
    assert awaiting["awaiting_approval"] == 2
    assert awaiting["can_approve"] is True
    assert [r["workflow_name"] for r in awaiting["workflow_runs"]] == [
        "ci.yml",
        "Unknown",
    ]
    assert gh.repos()[1] == REPO


def test_no_runs_await_approval_when_github_lists_none(client, gh):
    gh.answer(
        {
            "pr view 7 --json headRefOid": {
                "stdout": json.dumps({"headRefOid": "head1"})
            },
            RUNS_KEY: {"stdout": ""},
        }
    )
    assert run(client.get_workflows_awaiting_approval(7))["awaiting_approval"] == 0


def test_a_pull_request_without_a_head_has_nothing_to_approve(client, gh):
    gh.answer({"pr view 7 --json headRefOid": {"stdout": ""}})
    awaiting = run(client.get_workflows_awaiting_approval(7))
    assert awaiting == {
        "awaiting_approval": 0,
        "workflow_runs": [],
        "can_approve": False,
    }
    assert len(gh.calls()) == 1


def test_an_unreadable_approval_queue_is_reported_as_an_error(client, gh):
    gh.answer({"pr view 7 --json headRefOid": {"stdout": "{oops"}})
    awaiting = run(client.get_workflows_awaiting_approval(7))
    assert awaiting["can_approve"] is False and "error" in awaiting


def test_approving_a_workflow_run_reports_whether_it_worked(client, gh):
    approve = "api --method POST repos/{owner}/{repo}/actions/runs/11/approve"
    gh.answer({approve: {"stdout": ""}})
    assert run(client.approve_workflow_run(11)) is True
    gh.answer({approve: {"stderr": "Must have admin rights", "code": 1}})
    assert run(client.approve_workflow_run(11)) is False
    assert gh.repos() == [REPO, REPO]


def test_runs_awaiting_approval_count_as_pending_checks(client, gh):
    gh.answer(
        {
            "pr checks 7": {
                "stdout": json.dumps([{"name": "lint", "state": "QUEUED"}])
            },
            "pr view 7 --json headRefOid": {
                "stdout": json.dumps({"headRefOid": "head1"})
            },
            RUNS_KEY: {
                "stdout": json.dumps(
                    {"workflow_runs": [{"id": 1, "head_sha": "head1"}]}
                )
            },
        }
    )
    status = run(client.get_pr_checks_comprehensive(7))
    assert status["pending"] == 2
    assert status["awaiting_approval"] == 1
    assert [r["id"] for r in status["awaiting_workflow_runs"]] == [1]


# --- files and commits of a pull request ------------------------------------


def _page_key(kind: str, page: int) -> str:
    return (
        f"api --method GET repos/{{owner}}/{{repo}}/pulls/7/{kind}"
        f" -f page={page} -f per_page=100"
    )


def test_pull_request_files_are_read_page_by_page(client, gh):
    first = [{"filename": f"f{i}.py"} for i in range(100)]
    gh.answer(
        {
            _page_key("files", 1): {"stdout": json.dumps(first)},
            _page_key("files", 2): {"stdout": json.dumps([{"filename": "last.py"}])},
        }
    )
    files = run(client.get_pr_files(7))
    assert len(files) == 101 and files[-1]["filename"] == "last.py"
    # The query goes in fields: no argument holds the `&` that a Windows
    # `.cmd` shim of gh would read as a command separator.
    assert not any("&" in arg for call in gh.calls() for arg in call)


def test_a_full_last_page_ends_on_the_next_empty_one(client, gh):
    full = [{"filename": f"f{i}.py"} for i in range(100)]
    gh.answer(
        {
            _page_key("files", 1): {"stdout": json.dumps(full)},
            _page_key("files", 2): {"stdout": ""},
        }
    )
    assert len(run(client.get_pr_files(7))) == 100
    assert len(gh.calls()) == 2


def test_file_pages_stop_at_five_thousand_files(client, gh):
    full = json.dumps([{"filename": "f.py"}] * 100)
    gh.answer({_page_key("files", p): {"stdout": full} for p in range(1, 52)})
    assert len(run(client.get_pr_files(7))) == 5000
    assert len(gh.calls()) == 50


def test_pull_request_commits_are_read_page_by_page(client, gh):
    first = [{"sha": f"{i:040d}"} for i in range(100)]
    gh.answer(
        {
            _page_key("commits", 1): {"stdout": json.dumps(first)},
            _page_key("commits", 2): {"stdout": json.dumps([{"sha": "f" * 40}])},
        }
    )
    assert len(run(client.get_pr_commits(7))) == 101
    gh.answer({_page_key("commits", 1): {"stdout": "[]"}})
    assert run(client.get_pr_commits(7)) == []


def test_commit_pages_stop_at_a_thousand_commits(client, gh):
    full = json.dumps([{"sha": "a" * 40}] * 100)
    gh.answer({_page_key("commits", p): {"stdout": full} for p in range(1, 12)})
    assert len(run(client.get_pr_commits(7))) == 1000
    assert len(gh.calls()) == 10


def _answer_pr(gh, files, commits):
    gh.answer(
        {
            _page_key("files", 1): {"stdout": json.dumps(files)},
            _page_key("commits", 1): {"stdout": json.dumps(commits)},
        }
    )


COMMITS = [{"sha": "1111111aaaa"}, {"sha": "2222222bbbb"}, {"sha": "3333333cccc"}]
FILES = [
    {"filename": "kept.py", "sha": "blob-same", "status": "modified"},
    {"filename": "edited.py", "sha": "blob-new", "status": "modified"},
    {"filename": "new.py", "sha": "blob-x", "status": "added"},
    {"filename": "unseen.py", "sha": "blob-y", "status": "modified"},
]


def test_commits_after_the_reviewed_one_are_the_new_ones(client, gh):
    _answer_pr(gh, FILES, COMMITS)
    files, commits = run(client.get_pr_files_changed_since(7, "2222222bbbbffff"))
    assert files == FILES
    assert commits == [{"sha": "3333333cccc"}]


def test_a_short_reviewed_sha_is_matched_as_it_is(client, gh):
    _answer_pr(gh, FILES, [{"sha": "abc"}, {"sha": "def"}])
    _, commits = run(client.get_pr_files_changed_since(7, "abc"))
    assert commits == [{"sha": "def"}]


def test_after_a_rebase_only_files_whose_content_changed_are_kept(client, gh):
    _answer_pr(gh, FILES, COMMITS)
    blobs = {"kept.py": "blob-same", "edited.py": "blob-old", "new.py": "blob-x"}
    files, commits = run(client.get_pr_files_changed_since(7, "9999999", blobs))
    assert [f["filename"] for f in files] == ["edited.py", "new.py", "unseen.py"]
    assert commits == []


def test_after_a_rebase_with_every_file_changed_all_are_kept(client, gh):
    _answer_pr(gh, FILES[1:2], COMMITS)
    files, _ = run(
        client.get_pr_files_changed_since(7, "9999999", {"edited.py": "blob-old"})
    )
    assert files == FILES[1:2]


def test_after_a_rebase_without_blobs_every_file_is_kept(client, gh):
    _answer_pr(gh, FILES, COMMITS)
    files, commits = run(client.get_pr_files_changed_since(7, "9999999"))
    assert files == FILES and commits == []
