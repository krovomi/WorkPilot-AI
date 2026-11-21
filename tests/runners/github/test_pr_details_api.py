"""The PR details route: a github.com pull request URL in, its metadata and diff out.

`GET /api/github/pr-details?pr_url=...` (runners/github/api.py, mounted by
provider_api) reads a pull request through the GitHub provider. These tests
call it over HTTP, against a fake `gh` that answers and records the commands.
The URL comes from the caller, so the route also has to refuse one that is not
a github.com pull request before anything reaches gh.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from runners.github.api import router

PR = {
    "number": 7,
    "title": "Fix the parser",
    "body": "Closes #5",
    "author": {"login": "ann"},
    "state": "OPEN",
    "headRefName": "fix/parser",
    "baseRefName": "main",
    "additions": 3,
    "deletions": 1,
    "changedFiles": 1,
    "files": [{"path": "parser.py"}],
    "url": "https://github.com/own/repo/pull/7",
    "createdAt": "2026-11-01T10:00:00Z",
    "updatedAt": "2026-11-02T10:00:00Z",
    "mergeable": "MERGEABLE",
}

app = FastAPI()
app.include_router(router)
client = TestClient(app)


def details(pr_url: str) -> dict:
    response = client.get("/api/github/pr-details", params={"pr_url": pr_url})
    assert response.status_code == 200
    return response.json()


def test_a_pull_request_url_gives_its_details_and_diff(gh):
    gh.answer(
        {
            "pr view 7": {"stdout": json.dumps(PR)},
            "pr diff 7": {"stdout": "diff --git a/parser.py b/parser.py\n"},
        }
    )
    answer = details("https://github.com/own/repo/pull/7/files")
    assert answer["success"] is True
    assert answer["data"] == {
        "number": 7,
        "title": "Fix the parser",
        "body": "Closes #5",
        "state": "OPEN",
        "author": "ann",
        "createdAt": "2026-11-01T10:00:00+00:00",
        "updatedAt": "2026-11-02T10:00:00+00:00",
        "url": "https://github.com/own/repo/pull/7",
        "baseBranch": "main",
        "headBranch": "fix/parser",
        "mergeable": True,
        "additions": 3,
        "deletions": 1,
        "changedFiles": 1,
        "files": [{"path": "parser.py"}],
        "diff": "diff --git a/parser.py b/parser.py\n",
    }
    asked = gh.calls()
    assert asked[0][:3] == ["pr", "view", "7"]
    assert asked[0][-2:] == ["-R", "own/repo"]
    assert asked[1] == ["pr", "diff", "7", "-R", "own/repo"]


@pytest.mark.parametrize(
    "pr_url",
    [
        "https://gitlab.com/own/repo/pull/7",
        "https://github.com/own/repo/issues/7",
        "https://github.com/own/repo",
        "https://github.com/own/repo/pull/seven",
        "https://github.com/own/repo/pull/²",
        "https://github.com/-R/repo/pull/7",
        "https://github.com/--hostname=evil.example/repo/pull/7",
        "https://github.com/own/../pull/7",
        "https://github.com/own/re%20po/pull/7",
    ],
)
def test_anything_but_a_github_pull_request_url_is_refused_before_gh(gh, pr_url):
    assert details(pr_url) == {
        "success": False,
        "error": "Invalid GitHub PR URL format",
    }
    assert gh.calls() == []


def test_a_pull_request_gh_cannot_read_fails_without_gh_s_words(gh):
    gh.answer({"pr view 9": {"stderr": "secret-ish detail", "code": 1}})
    answer = details("https://github.com/own/repo/pull/9")
    assert answer["success"] is False
    assert "secret-ish detail" not in answer["error"]
