"""The GitHub provider: pull requests, issues and labels through the `gh` CLI.

`providers.GitHubProvider` is the forge-neutral face of GitHub (the
`GitProvider` protocol): the app's PR details view reads a pull request
through it. These tests drive it against a fake `gh` (tests/gh_fake.py) that
answers the commands and records them, so each call is checked the way GitHub
would receive it: which command, against which repository.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

import pytest
from runners.github.gh_client import GHClient
from runners.github.providers import (
    GitHubProvider,
    GitProvider,
    IssueFilters,
    PRFilters,
    ProviderType,
    ReviewData,
    factory,
    get_provider,
    register_provider,
)
from runners.github.providers.protocol import LabelData

PR_FIELDS = (
    "number,title,body,author,state,headRefName,baseRefName,additions,deletions,"
    "changedFiles,files,url,createdAt,updatedAt,labels,reviewRequests,isDraft,mergeable"
)
PR = {
    "number": 7,
    "title": "Fix the parser",
    "body": None,
    "author": {"login": "ann"},
    "state": "OPEN",
    "headRefName": "fix/parser",
    "baseRefName": "main",
    "additions": 3,
    "deletions": 1,
    "files": [{"path": "parser.py"}],
    "url": "https://github.com/own/repo/pull/7",
    "createdAt": "2026-11-01T10:00:00Z",
    "updatedAt": "2026-11-02T10:00:00Z",
    "labels": [{"name": "bug"}, "plain"],
    "reviewRequests": [
        {"requestedReviewer": {"login": "bob"}},
        {"requestedReviewer": "a-team"},
        {"other": True},
        "loose",
    ],
    "isDraft": True,
    "mergeable": "CONFLICTING",
}
ISSUE = {
    "number": 5,
    "title": "Crash on save",
    "body": "It crashes",
    "author": {"login": "ann"},
    "state": "OPEN",
    "labels": [{"name": "bug"}],
    "createdAt": "2026-11-01T00:00:00Z",
    "updatedAt": "not a date",
    "url": "https://github.com/own/repo/issues/5",
    "assignees": [{"login": "bob"}, "carl"],
    "milestone": {"title": "v2"},
}


@pytest.fixture
def provider(tmp_path, gh):
    return GitHubProvider(_repo="own/repo", _project_dir=str(tmp_path))


def run(coro):
    return asyncio.run(coro)


def test_a_pull_request_is_read_with_its_diff(provider, gh):
    gh.answer(
        {
            "pr view 7": {"stdout": json.dumps(PR)},
            "pr diff 7": {"stdout": "diff --git a/parser.py b/parser.py\n"},
        }
    )
    pr = run(provider.fetch_pr(7))
    assert gh.calls() == [
        ["pr", "view", "7", "--json", PR_FIELDS, "-R", "own/repo"],
        ["pr", "diff", "7", "-R", "own/repo"],
    ]
    assert (pr.number, pr.title, pr.body, pr.author) == (7, "Fix the parser", "", "ann")
    assert (pr.source_branch, pr.target_branch) == ("fix/parser", "main")
    assert pr.changed_files == 1  # counted from the files when GitHub omits it
    assert pr.diff.startswith("diff --git")
    assert pr.created_at == datetime(2026, 11, 1, 10, tzinfo=UTC)
    assert pr.labels == ["bug", "plain"]
    assert pr.reviewers == ["bob"]
    assert pr.is_draft is True
    assert pr.mergeable is False
    assert pr.provider is ProviderType.GITHUB
    assert run(provider.fetch_pr_diff(7)).startswith("diff --git")


def test_a_pull_request_with_missing_fields_still_reads(provider, gh):
    gh.answer(
        {
            "pr view 8": {
                "stdout": json.dumps(
                    {"author": "ghost", "files": None, "createdAt": None}
                )
            },
            "pr diff 8": {"stdout": ""},
        }
    )
    pr = run(provider.fetch_pr(8))
    assert pr.author == "ghost"
    assert pr.files == [] and pr.changed_files == 0
    assert pr.reviewers == []
    assert pr.mergeable is True
    assert pr.created_at.tzinfo is not None  # "now" when GitHub gives no date

    gh.answer({"pr view 9": {"stdout": json.dumps({"author": None})}, "pr diff 9": {}})
    assert run(provider.fetch_pr(9)).author == "unknown"


def test_listing_pull_requests_applies_every_filter(provider, gh):
    listed = {**PR, "labels": [{"name": "bug"}]}  # gh lists labels as objects
    prs = [
        {**listed, "number": 1},
        {**listed, "number": 2, "author": {"login": "eve"}},
        {**listed, "number": 3, "baseRefName": "develop"},
        {**listed, "number": 4, "headRefName": "other"},
        {**listed, "number": 5, "labels": []},
    ]
    gh.answer({"pr list": {"stdout": json.dumps(prs)}})
    found = run(
        provider.fetch_prs(
            PRFilters(
                state="all",
                limit=20,
                author="ann",
                base_branch="main",
                head_branch="fix/parser",
                labels=["bug"],
            )
        )
    )
    assert [pr.number for pr in found] == [1]
    assert all(pr.diff == "" for pr in found)
    assert gh.calls()[0][:6] == ["pr", "list", "--state", "all", "--limit", "20"]
    assert len(run(provider.fetch_prs())) == 5


def test_a_review_is_posted_with_its_event(provider, gh):
    gh.answer({"pr review 7": {}})
    review = ReviewData(pr_number=7, event="request_changes", body="Please test")
    assert run(provider.post_review(7, review)) == 0
    assert gh.calls()[0][:6] == [
        "pr",
        "review",
        "7",
        "--request-changes",
        "--body-file",
        "-",
    ]
    assert gh.stdins() == ["Please test"]


@pytest.mark.parametrize(
    ("method", "flag"),
    [("squash", "--squash"), ("rebase", "--rebase"), ("merge", "--merge")],
)
def test_merging_names_the_method_and_the_repository(provider, gh, method, flag):
    gh.answer({"pr merge 7": {}})
    assert run(provider.merge_pr(7, merge_method=method, commit_title="Ship")) is True
    assert gh.calls() == [
        ["pr", "merge", "7", flag, "--subject", "Ship", "--yes", "-R", "own/repo"]
    ]


def test_a_refused_merge_or_close_answers_false(provider, gh):
    gh.answer({"pr merge 7": {"stderr": "not mergeable", "code": 1}})
    assert run(provider.merge_pr(7)) is False
    gh.answer({"pr close 7": {"stderr": "gone", "code": 1}})
    assert run(provider.close_pr(7)) is False
    gh.answer({"issue close 5": {"stderr": "gone", "code": 1}})
    assert run(provider.close_issue(5)) is False


def test_closing_comments_first_then_closes(provider, gh):
    gh.answer({"issue comment": {}, "pr close 7": {}, "issue close 5": {}})
    assert run(provider.close_pr(7, comment="Superseded")) is True
    assert run(provider.close_issue(5, comment="Fixed")) is True
    assert run(provider.close_pr(7)) is True
    calls = gh.calls()
    assert calls[0] == [
        "issue",
        "comment",
        "7",
        "--body-file",
        "-",
        "-R",
        "own/repo",
    ]
    assert gh.stdins()[0] == "Superseded"
    assert calls[1] == ["pr", "close", "7", "-R", "own/repo"]
    assert calls[3] == ["issue", "close", "5", "-R", "own/repo"]


def test_an_issue_is_read_with_its_people_and_milestone(provider, gh):
    gh.answer({"issue view 5": {"stdout": json.dumps(ISSUE)}})
    issue = run(provider.fetch_issue(5))
    assert issue.assignees == ["bob", "carl"]
    assert issue.milestone == "v2"
    assert issue.labels == ["bug"]
    assert issue.updated_at.tzinfo is not None  # an unreadable date becomes "now"

    gh.answer(
        {
            "issue view 6": {
                "stdout": json.dumps(
                    {"author": "", "labels": ["raw"], "milestone": "loose"}
                )
            }
        }
    )
    bare = run(provider.fetch_issue(6))
    assert (bare.author, bare.labels, bare.milestone) == ("unknown", ["raw"], "loose")


def test_listing_issues_leaves_out_pull_requests_and_filters(provider, gh):
    issues = [
        {**ISSUE, "number": 1},
        {**ISSUE, "number": 2, "pullRequest": {}},
        {**ISSUE, "number": 3, "author": {"login": "eve"}},
        {**ISSUE, "number": 4, "labels": []},
    ]
    gh.answer({"issue list": {"stdout": json.dumps(issues)}})
    filtered = run(provider.fetch_issues(IssueFilters(author="ann", labels=["bug"])))
    assert [i.number for i in filtered] == [1]
    with_prs = run(provider.fetch_issues(IssueFilters(include_prs=True)))
    assert [i.number for i in with_prs] == [1, 2, 3, 4]
    assert [i.number for i in run(provider.fetch_issues())] == [1, 3, 4]


def test_a_created_issue_is_read_back_from_its_url(provider, gh):
    gh.answer(
        {
            "issue create": {"stdout": "https://github.com/own/repo/issues/5\n"},
            "issue view 5": {"stdout": json.dumps(ISSUE)},
        }
    )
    issue = run(
        provider.create_issue("Crash", "Body", labels=["bug", "p1"], assignees=["bob"])
    )
    assert issue.number == 5
    assert gh.calls()[0] == [
        "issue",
        "create",
        "--title",
        "Crash",
        "--body-file",
        "-",
        "--label",
        "bug",
        "--label",
        "p1",
        "--assignee",
        "bob",
        "-R",
        "own/repo",
    ]
    assert gh.stdins()[0] == "Body"
    gh.answer(
        {
            "issue create": {"stdout": "https://github.com/own/repo/issues/6"},
            "issue view 6": {"stdout": json.dumps(ISSUE)},
        }
    )
    run(provider.create_issue("Plain", "Body"))
    assert gh.calls()[-2] == [
        "issue",
        "create",
        "--title",
        "Plain",
        "--body-file",
        "-",
        "-R",
        "own/repo",
    ]


def test_labels_are_applied_removed_created_and_listed(provider, gh):
    gh.answer(
        {
            "issue edit": {},
            "label create": {},
            "label list": {
                "stdout": json.dumps(
                    [
                        {"name": "bug", "color": "d73a4a", "description": "Broken"},
                        {"name": "x"},
                    ]
                )
            },
        }
    )
    run(provider.apply_labels(5, ["bug"]))
    run(provider.remove_labels(5, ["wontfix"]))
    run(
        provider.create_label(
            LabelData(name="bug", color="d73a4a", description="Broken")
        )
    )
    run(provider.create_label(LabelData(name="plain", color="ffffff")))
    labels = run(provider.list_labels())
    calls = gh.calls()
    assert calls[0] == ["issue", "edit", "5", "--add-label", "bug", "-R", "own/repo"]
    assert calls[1] == [
        "issue",
        "edit",
        "5",
        "--remove-label",
        "wontfix",
        "-R",
        "own/repo",
    ]
    assert calls[2] == [
        "label",
        "create",
        "bug",
        "--color",
        "d73a4a",
        "--description",
        "Broken",
        "--force",
        "-R",
        "own/repo",
    ]
    assert calls[3] == [
        "label",
        "create",
        "plain",
        "--color",
        "ffffff",
        "--force",
        "-R",
        "own/repo",
    ]
    assert labels == [
        LabelData(name="bug", color="d73a4a", description="Broken"),
        LabelData(name="x", color="", description=""),
    ]
    gh.answer({"label list": {"stdout": ""}})
    assert run(provider.list_labels()) == []


def test_a_comment_answers_no_id(provider, gh):
    gh.answer({"issue comment": {}})
    assert run(provider.add_comment(5, "Thanks")) == 0


def test_repository_facts_come_from_the_api(provider, gh):
    gh.answer(
        {
            "api --method GET /repos/own/repo": {
                "stdout": json.dumps({"default_branch": "trunk"})
            },
            "api --method GET /repos/own/repo/collaborators/ann/permission": {
                "stdout": json.dumps({"permission": "write"})
            },
            "api --method GET /repos/own/repo/collaborators/eve/permission": {
                "stderr": "HTTP 404",
                "code": 1,
            },
        }
    )
    assert run(provider.get_default_branch()) == "trunk"
    assert run(provider.check_permissions("ann")) == "write"
    assert run(provider.check_permissions("eve")) == "none"
    gh.answer({"api --method GET /repos/own/repo": {"stdout": "{}"}})
    assert run(provider.get_default_branch()) == "main"


def test_api_get_passes_parameters(provider, gh):
    gh.answer({"api --method GET /rate_limit": {"stdout": json.dumps({"ok": True})}})
    assert run(provider.api_get("/rate_limit", {"page": "2"})) == {"ok": True}
    # A GET, with the parameters in the query string, not a POST body
    assert gh.calls()[0] == ["api", "--method", "GET", "/rate_limit", "-f", "page=2"]


def test_api_post_sends_the_body_as_json(provider, gh, tmp_path):
    gh.answer({"api /repos/own/repo/dispatches": {"stdout": json.dumps({"id": 3})}})
    answer = run(
        provider.api_post(
            "/repos/own/repo/dispatches", {"event_type": "@/etc/passwd", "n": 2}
        )
    )
    assert answer == {"id": 3}
    call = gh.calls()[0]
    assert call[:4] == ["api", "/repos/own/repo/dispatches", "--method", "POST"]
    assert call[4] == "--input"
    # The temporary body is removed once gh has read it.
    assert not (tmp_path / call[5]).exists()

    gh.answer({"api /x": {"stdout": "  "}})
    assert run(provider.api_post("/x")) is None


def test_the_provider_is_a_git_provider(provider):
    assert isinstance(provider, GitProvider)
    assert provider.provider_type is ProviderType.GITHUB
    assert provider.repo == "own/repo"
    assert provider.gh_client.repo == "own/repo"


def test_a_provider_can_reuse_a_client_it_is_given(tmp_path):
    client = GHClient(project_dir=tmp_path, repo="own/repo")
    assert GitHubProvider(_repo="own/repo", _gh_client=client).gh_client is client


def test_without_a_project_the_provider_works_from_the_current_folder(
    gh, tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    provider = GitHubProvider(_repo="own/repo", enable_rate_limiting=False)
    assert provider.gh_client.project_dir == tmp_path


def test_the_factory_builds_github_and_refuses_the_rest(gh, tmp_path, monkeypatch):
    monkeypatch.setattr(factory, "_PROVIDER_REGISTRY", {})
    built = get_provider("GitHub", "own/repo", _project_dir=str(tmp_path))
    assert isinstance(built, GitHubProvider) and built.repo == "own/repo"
    for name, label in (
        ("gitlab", "GitLab"),
        ("bitbucket", "Bitbucket"),
        ("gitea", "Gitea"),
        (ProviderType.AZURE_DEVOPS, "Azure DevOps"),
    ):
        with pytest.raises(NotImplementedError, match=f"^{label} provider not yet"):
            get_provider(name, "own/repo")
    with pytest.raises(ValueError, match="Unknown provider type: svn"):
        get_provider("svn", "own/repo")
    assert factory.list_available_providers() == [ProviderType.GITHUB]
    assert factory.is_provider_available("github") is True
    assert factory.is_provider_available(ProviderType.GITLAB) is False
    assert factory.is_provider_available("svn") is False


def test_a_registered_provider_wins(monkeypatch):
    monkeypatch.setattr(factory, "_PROVIDER_REGISTRY", {})
    made = []

    def make_gitlab(repo, **kwargs):
        made.append((repo, kwargs))
        return "gitlab-provider"

    register_provider(ProviderType.GITLAB, make_gitlab)
    register_provider(ProviderType.GITHUB, make_gitlab)
    assert get_provider(ProviderType.GITLAB, "grp/proj", token="t") == "gitlab-provider"
    assert made == [("grp/proj", {"token": "t"})]
    assert factory.is_provider_available("gitlab") is True
    assert factory.list_available_providers() == [
        ProviderType.GITHUB,
        ProviderType.GITLAB,
    ]
