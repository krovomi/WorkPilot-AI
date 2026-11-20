"""What a PR review knows before its agents start.

`PRContextGatherer` collects a pull request for the reviewer in one pass: its
metadata through `gh`, each changed file before and after (read from the
local clone with git, fetching the PR's commits first), the full diff, the
repository's layout and what AI review bots already said.
`FollowupContextGatherer` does the same for a follow-up review: only what
changed and what was said since the previous one.

`gh` is a fake (tests/gh_fake.py); git is real, on repositories built in
tmp_path, with an "upstream" the clone fetches the PR from.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import subprocess
import sys
from pathlib import Path

import pytest
from context_gatherer import FollowupContextGatherer, PRContextGatherer
from models import PRReviewResult

REPO = "own/repo"
METADATA = (
    "pr view 7 --json number,title,body,state,headRefName,baseRefName,headRefOid,"
    "baseRefOid,author,files,additions,deletions,changedFiles,labels,mergeable,"
    "mergeStateStatus"
)
REVIEW_COMMENTS = "api repos/{owner}/{repo}/pulls/7/comments --jq ."
ISSUE_COMMENTS = "api repos/{owner}/{repo}/issues/7/comments --jq ."


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@e.x", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout.strip()


@pytest.fixture
def pr_repo(tmp_path):
    """An upstream with `main` and a PR branch `feature`, and a clone of it.

    The PR changes app.py, adds new.py, edits a binary file; GitHub's
    `refs/pull/7/head` points at its head, as it does for every PR.
    """
    upstream = tmp_path / "upstream"
    upstream.mkdir()
    git(upstream, "init", "-q", "-b", "main")
    (upstream / "app.py").write_text("print('v1')\n", encoding="utf-8")
    (upstream / "logo.bin").write_bytes(b"\x89PNG\xff\xfe\x00\x01")
    git(upstream, "add", ".")
    git(upstream, "commit", "-q", "-m", "base")
    base = git(upstream, "rev-parse", "HEAD")
    git(upstream, "checkout", "-q", "-b", "feature")
    (upstream / "app.py").write_text("print('v2')\n", encoding="utf-8")
    (upstream / "new.py").write_text("NEW = 1\n", encoding="utf-8")
    (upstream / "logo.bin").write_bytes(b"\x89PNG\xff\xfe\x00\x02")
    git(upstream, "add", ".")
    git(upstream, "commit", "-q", "-m", "head")
    head = git(upstream, "rev-parse", "HEAD")
    git(upstream, "update-ref", "refs/pull/7/head", head)
    git(upstream, "checkout", "-q", "main")
    project = tmp_path / "project"
    git(tmp_path, "clone", "-q", "--single-branch", str(upstream), str(project))
    return project, base, head


def pr_metadata(base: str, head: str, **overrides) -> dict:
    data = {
        "number": 7,
        "title": "Bump the greeting",
        "body": "It says v2 now.",
        "state": "OPEN",
        "headRefName": "feature",
        "baseRefName": "main",
        "headRefOid": head,
        "baseRefOid": base,
        "author": {"login": "ann"},
        "files": [
            {"path": "app.py", "additions": 1, "deletions": 1},
            {"path": "new.py", "status": "ADDED", "additions": 1},
            {"path": "logo.bin", "status": "changed"},
        ],
        "additions": 2,
        "deletions": 1,
        "labels": [{"name": "enhancement"}],
        "mergeable": "MERGEABLE",
        "mergeStateStatus": "CLEAN",
    }
    data.update(overrides)
    return data


def answer_pr(gh, metadata: dict, **answers) -> None:
    gh.answer(
        {
            METADATA: {"stdout": json.dumps(metadata)},
            "pr diff 7": {"stdout": "diff --git a/app.py b/app.py\n"},
            "pr view 7 --json commits": {
                "stdout": json.dumps({"commits": [{"oid": metadata.get("headRefOid")}]})
            },
            REVIEW_COMMENTS: {"stdout": "[]"},
            ISSUE_COMMENTS: {"stdout": "[]"},
            **answers,
        }
    )


def gather(project: Path):
    return asyncio.run(PRContextGatherer(project, 7, repo=REPO).gather())


def by_path(context) -> dict:
    return {f.path: f for f in context.changed_files}


# --- a full review context --------------------------------------------------


def test_a_review_gets_the_pr_its_files_before_and_after_and_its_diff(
    pr_repo, gh, capsys
):
    project, base, head = pr_repo
    answer_pr(gh, pr_metadata(base, head))

    context = gather(project)

    assert (context.title, context.description) == (
        "Bump the greeting",
        "It says v2 now.",
    )
    assert (context.author, context.base_branch, context.head_branch) == (
        "ann",
        "main",
        "feature",
    )
    assert (context.head_sha, context.base_sha) == (head, base)
    assert context.labels == ["enhancement"]
    assert context.commits == [{"oid": head}]
    assert context.diff.startswith("diff --git")
    assert context.diff_truncated is False
    assert context.has_merge_conflicts is False
    files = by_path(context)
    assert (files["app.py"].base_content, files["app.py"].content) == (
        "print('v1')\n",
        "print('v2')\n",
    )
    assert "+print('v2')" in files["app.py"].patch
    assert files["app.py"].status == "modified"
    assert (files["new.py"].status, files["new.py"].base_content) == ("added", "")
    assert "+NEW = 1" in files["new.py"].patch
    # A binary file has no text to show the reviewer, but its patch says so
    assert (files["logo.bin"].content, files["logo.bin"].base_content) == ("", "")
    assert "Binary files" in files["logo.bin"].patch
    assert files["logo.bin"].status == "modified"
    assert context.repo_structure == "**Structure**: Standard single-package repository"
    assert context.related_files == []
    out = capsys.readouterr().out
    assert f"Fetched PR refs: base={base[:8]} → head={head[:8]}" in out
    # Every PR command named the repository
    assert all(call[-2:] == ["-R", REPO] for call in gh.calls() if call[0] == "pr")


def test_file_statuses_read_the_same_whatever_word_github_used(pr_repo, gh):
    project, base, head = pr_repo
    statuses = ["add", "MOD", "removed", "del", "renamed", "rename", "copied"]
    files = [{"path": f"f{i}.py", "status": s} for i, s in enumerate(statuses)]
    answer_pr(gh, pr_metadata(base, head, files=files))
    context = gather(project)
    assert [f.status for f in context.changed_files] == [
        "added",
        "modified",
        "deleted",
        "deleted",
        "renamed",
        "renamed",
        "copied",
    ]


def test_a_pr_with_conflicts_says_so(pr_repo, gh, capsys):
    project, base, head = pr_repo
    metadata = pr_metadata(
        base, head, files=[], mergeable="CONFLICTING", mergeStateStatus="DIRTY"
    )
    answer_pr(gh, metadata)
    context = gather(project)
    assert context.has_merge_conflicts is True
    assert context.merge_state_status == "DIRTY"
    assert "PR has merge conflicts (mergeStateStatus: DIRTY)" in capsys.readouterr().out


def test_a_head_commit_gone_from_github_is_fetched_through_the_pr_ref(
    pr_repo, gh, capsys
):
    project, base, _head = pr_repo
    vanished = "f" * 40  # force-pushed away: no longer fetchable by its SHA
    answer_pr(gh, pr_metadata(base, vanished, files=[]))
    gather(project)
    out = capsys.readouterr().out
    assert "Direct SHA fetch failed, trying PR ref..." in out
    assert "Fetched PR ref: refs/pr/7" in out
    assert git(project, "rev-parse", "refs/pr/7") == git(
        project.parent / "upstream", "rev-parse", "refs/pull/7/head"
    )


def test_without_a_remote_the_review_goes_on_without_local_files(
    tmp_path, pr_repo, gh, capsys
):
    _project, base, head = pr_repo
    lonely = tmp_path / "lonely"
    lonely.mkdir()
    git(lonely, "init", "-q")
    answer_pr(gh, pr_metadata(base, head))

    context = gather(lonely)

    out = capsys.readouterr().out
    assert "Failed to fetch PR refs:" in out
    assert "Could not fetch PR refs locally" in out
    assert "Failed to get patch for app.py" in out
    app = by_path(context)["app.py"]
    assert (app.content, app.base_content, app.patch) == ("", "", "")
    # GitHub's own diff still reaches the reviewer
    assert context.diff.startswith("diff --git")


def test_a_fetch_that_hangs_is_given_up_on(pr_repo, gh, capsys, monkeypatch):
    project, base, head = pr_repo
    sleeper = f"{Path(sys.executable).as_posix()} -c 'import time; time.sleep(5)'"
    git(project, "config", "remote.origin.uploadpack", sleeper)
    monkeypatch.setattr(
        importlib.import_module("context_gatherer"), "GIT_FETCH_TIMEOUT", 0.5
    )
    answer_pr(gh, pr_metadata(base, head, files=[]))
    gather(project)
    out = capsys.readouterr().out
    assert "[Context] Timeout fetching PR refs" in out
    assert "Could not fetch PR refs locally" in out


def test_without_git_installed_the_review_goes_on(pr_repo, gh, capsys, monkeypatch):
    project, base, head = pr_repo
    answer_pr(gh, pr_metadata(base, head, files=[{"path": "app.py"}]))
    monkeypatch.setenv("PATH", str(project.parent / "no-tools-here"))
    context = gather(project)
    out = capsys.readouterr().out
    assert "[Context] Error fetching PR refs:" in out
    assert f"[Context] Error reading app.py from {head}:" in out
    assert "[Context] Error getting patch for app.py:" in out
    assert by_path(context)["app.py"].content == ""


def test_without_commit_shas_the_branch_names_are_read(pr_repo, gh, capsys):
    project, base, head = pr_repo
    git(project, "fetch", "-q", "origin", "feature:feature")
    metadata = pr_metadata(base, head, files=[{"path": "app.py"}])
    del metadata["headRefOid"], metadata["baseRefOid"]
    answer_pr(gh, metadata)
    context = gather(project)
    app = by_path(context)["app.py"]
    assert (app.base_content, app.content) == ("print('v1')\n", "print('v2')\n")
    assert "Fetched PR refs" not in capsys.readouterr().out


def test_unsafe_refs_and_paths_never_reach_git(pr_repo, gh, capsys):
    project, base, head = pr_repo
    files = [{"path": "../outside.py"}, {"path": "app.py"}]
    answer_pr(gh, pr_metadata(base, "bad;ref", files=files))
    context = gather(project)
    out = capsys.readouterr().out
    assert "Invalid head SHA rejected: bad;ref" in out
    assert out.count("Invalid file path rejected: ../outside.py") == 3
    assert "Invalid git ref rejected: bad;ref" in out
    assert "Invalid head ref rejected: bad;ref" in out
    files = by_path(context)
    assert files["../outside.py"].content == ""
    # The base side of a safe file is still read
    assert files["app.py"].base_content == "print('v1')\n"


def test_an_overlong_ref_or_an_empty_path_never_reaches_git(pr_repo, gh, capsys):
    project, base, _head = pr_repo
    overlong = "a" * 300
    answer_pr(gh, pr_metadata(base, overlong, files=[{"path": ""}]))
    context = gather(project)
    out = capsys.readouterr().out
    assert f"Invalid head SHA rejected: {overlong[:50]}" in out
    assert out.count("Invalid file path rejected:") == 3
    assert context.changed_files[0].content == ""


def test_an_unsafe_base_ref_never_reaches_git(pr_repo, gh, capsys):
    project, _base, head = pr_repo
    answer_pr(gh, pr_metadata("bad;ref", head, files=[{"path": "app.py"}]))
    context = gather(project)
    out = capsys.readouterr().out
    assert "Invalid base SHA rejected: bad;ref" in out
    assert "Invalid base ref rejected: bad;ref" in out
    assert by_path(context)["app.py"].patch == ""


def test_a_diff_too_large_for_github_leaves_the_per_file_patches(pr_repo, gh, capsys):
    project, base, head = pr_repo
    answer_pr(
        gh,
        pr_metadata(base, head, files=[{"path": "app.py"}]),
        **{
            "pr diff 7": {"stderr": "HTTP 406: diff too large", "code": 1},
            "pr view 7 --json commits": {"stderr": "timeout", "code": 1},
        },
    )
    context = gather(project)
    assert context.diff == "" and context.diff_truncated is True
    assert "+print('v2')" in by_path(context)["app.py"].patch
    assert context.commits == []
    assert "Skipping full diff" in capsys.readouterr().out


# --- what AI review bots already said ---------------------------------------


def test_comments_from_ai_review_tools_are_kept_and_cleaned(pr_repo, gh):
    project, base, head = pr_repo
    review_comments = [
        {
            "id": 1,
            "user": {"login": "coderabbitai[bot]"},
            "body": "Possible None here.",
            "path": "app.py",
            "line": 1,
            "created_at": "2026-11-01T10:00:00Z",
        },
        {
            "id": 2,
            "author": None,
            "user": {"login": "Cursor[bot]"},
            "body": "Typo",
            "path": "new.py",
            "original_line": 3,
        },
        {"id": 3, "user": {"login": "ann"}, "body": "Agreed"},
        {"id": 4, "author": None, "user": None, "body": "from a deleted account"},
    ]
    issue_comments = [
        {
            "id": 5,
            "author": {"login": "github-actions[bot]"},
            "body": "Coverage 90%",
            "createdAt": "2026-11-01T11:00:00Z",
            "path": "ignored.py",
        },
        {"id": 6, "author": {"login": "bob"}, "body": "LGTM"},
    ]
    answer_pr(
        gh,
        pr_metadata(base, head, files=[]),
        **{
            REVIEW_COMMENTS: {"stdout": json.dumps(review_comments)},
            ISSUE_COMMENTS: {"stdout": json.dumps(issue_comments)},
        },
    )
    comments = gather(project).ai_bot_comments
    assert [(c.comment_id, c.tool_name) for c in comments] == [
        (1, "CodeRabbit"),
        (2, "Cursor"),
        (5, "GitHub Actions"),
    ]
    assert (comments[0].file, comments[0].line) == ("app.py", 1)
    assert comments[0].created_at == "2026-11-01T10:00:00Z"
    assert (comments[1].author, comments[1].line) == ("cursor[bot]", 3)
    assert (comments[2].file, comments[2].line) == (None, None)
    assert comments[2].created_at == "2026-11-01T11:00:00Z"


def test_unreadable_bot_comments_are_left_out(pr_repo, gh, capsys):
    project, base, head = pr_repo
    answer_pr(
        gh,
        pr_metadata(base, head, files=[]),
        **{
            REVIEW_COMMENTS: {"stdout": "not json"},
            ISSUE_COMMENTS: {"stderr": "Not Found", "code": 1},
        },
    )
    assert gather(project).ai_bot_comments == []
    answer_pr(
        gh,
        pr_metadata(base, head, files=[]),
        **{
            REVIEW_COMMENTS: {"stdout": "  "},
            ISSUE_COMMENTS: {"stdout": "{oops"},
        },
    )
    assert gather(project).ai_bot_comments == []
    out = capsys.readouterr().out
    assert "Error fetching review comments" in out
    assert "Error fetching issue comments" in out


def test_comments_in_an_unexpected_shape_are_skipped_whole(pr_repo, gh, capsys):
    project, base, head = pr_repo
    answer_pr(
        gh,
        pr_metadata(base, head, files=[]),
        **{REVIEW_COMMENTS: {"stdout": json.dumps(["just a string"])}},
    )
    assert gather(project).ai_bot_comments == []
    assert "Error fetching AI bot comments" in capsys.readouterr().out


# --- the repository's layout ------------------------------------------------


def _layout(project: Path, files: dict[str, str], dirs: list[str]) -> None:
    for d in dirs:
        (project / d).mkdir(parents=True)
    for name, text in files.items():
        (project / name).write_text(text, encoding="utf-8")


def test_a_monorepo_layout_is_described_for_the_reviewer(pr_repo, gh):
    project, base, head = pr_repo
    _layout(
        project,
        {
            "package.json": json.dumps({"workspaces": ["apps/*", "packages/*"]}),
            "pyproject.toml": "",
            "requirements.txt": "",
            "angular.json": "{}",
            "next.config.js": "",
            "nuxt.config.js": "",
            "vite.config.ts": "",
            "electron.vite.config.ts": "",
        },
        ["apps/web", "apps/.cache", "packages/ui", "libs/core"],
    )
    answer_pr(gh, pr_metadata(base, head, files=[]))
    assert gather(project).repo_structure.split("\n") == [
        "**Monorepo Apps**: web",
        "**Packages**: ui",
        "**Libraries**: core",
        "**Workspaces**: apps/*, packages/*",
        "**Python Project** (pyproject.toml)",
        "**Python** (requirements.txt)",
        "**Framework**: Angular",
        "**Framework**: Next.js",
        "**Framework**: Nuxt.js",
        "**Build**: Vite",
        "**Electron** app",
    ]


def test_empty_monorepo_folders_say_nothing(pr_repo, gh):
    project, base, head = pr_repo
    _layout(
        project,
        {"package.json": json.dumps({"name": "solo"}), "vite.config.js": ""},
        ["apps/.hidden", "packages", "libs"],
    )
    (project / "apps" / "README.md").write_text("", encoding="utf-8")
    answer_pr(gh, pr_metadata(base, head, files=[]))
    assert gather(project).repo_structure == "**Build**: Vite"


def test_an_unreadable_package_json_is_ignored(pr_repo, gh):
    project, base, head = pr_repo
    _layout(project, {"package.json": "{not json"}, [])
    answer_pr(gh, pr_metadata(base, head, files=[]))
    assert "Standard single-package" in gather(project).repo_structure


# --- follow-up reviews ------------------------------------------------------

SINCE = "2026-11-01T10:00:00Z"
FOLLOWUP_COMMITS = "pr view 7 --json commits"
MERGE_STATUS = "pr view 7 --json mergeable,mergeStateStatus"


def _pages(kind: str) -> str:
    return (
        f"api --method GET repos/{{owner}}/{{repo}}/pulls/7/{kind}?page=1&per_page=100"
    )


def _since(kind: str) -> str:
    return f"api --method GET repos/{{owner}}/{{repo}}/{kind}/7/comments?since={SINCE}"


REVIEWS = "api --method GET repos/{owner}/{repo}/pulls/7/reviews"


def previous(sha: str | None = "1111111aaaa", **fields) -> PRReviewResult:
    return PRReviewResult(
        pr_number=7,
        repo=REPO,
        success=True,
        reviewed_commit_sha=sha,
        reviewed_at=SINCE,
        **fields,
    )


def followup(tmp_path, review: PRReviewResult):
    return asyncio.run(FollowupContextGatherer(tmp_path, 7, review, repo=REPO).gather())


def answer_followup(gh, head: str = "3333333cccc", **answers) -> None:
    gh.answer(
        {
            FOLLOWUP_COMMITS: {
                "stdout": json.dumps({"commits": [{"oid": "x"}, {"oid": head}]})
            },
            _pages("files"): {
                "stdout": json.dumps(
                    [
                        {"filename": "app.py", "sha": "b1", "patch": "@@ -1 +1 @@"},
                        {"filename": "logo.png", "sha": "b2"},
                    ]
                )
            },
            _pages("commits"): {
                "stdout": json.dumps(
                    [{"sha": "1111111aaaa"}, {"sha": "2222222bbbb"}, {"sha": head}]
                )
            },
            _since("pulls"): {"stdout": "[]"},
            _since("issues"): {"stdout": "[]"},
            REVIEWS: {"stdout": "[]"},
            MERGE_STATUS: {
                "stdout": json.dumps(
                    {"mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN"}
                )
            },
            **answers,
        }
    )


def test_a_followup_without_a_reviewed_commit_has_nothing_to_compare(tmp_path, gh):
    context = followup(tmp_path, previous(sha=None))
    assert (context.previous_commit_sha, context.current_commit_sha) == ("", "")
    assert gh.calls() == []


def test_a_followup_without_a_known_head_stops_there(tmp_path, gh):
    gh.answer({FOLLOWUP_COMMITS: {"stdout": json.dumps({"commits": []})}})
    context = followup(tmp_path, previous())
    assert (context.previous_commit_sha, context.current_commit_sha) == (
        "1111111aaaa",
        "",
    )


def test_a_followup_on_the_reviewed_head_has_no_changes(tmp_path, gh):
    answer_followup(gh, head="1111111aaaa")
    context = followup(tmp_path, previous())
    assert context.current_commit_sha == "1111111aaaa"
    assert context.commits_since_review == []
    assert len(gh.calls()) == 1


def test_a_followup_gets_the_new_commits_files_and_feedback(tmp_path, gh, capsys):
    comments = [
        {"id": 1, "user": {"login": "coderabbitai[bot]"}, "body": "Nit"},
        {"id": 2, "author": {"login": "Ann"}, "body": "Why?"},
        {"id": 3, "body": "no author"},
    ]
    reviews = [
        {
            "id": 10,
            "user": {"login": "cursor[bot]"},
            "submitted_at": "2026-11-02T00:00:00Z",
        },
        {"id": 11, "user": {"login": "bob"}, "submitted_at": "2026-11-02T00:00:00Z"},
        {"id": 12, "user": None, "submitted_at": "2026-11-02T00:00:00Z"},
    ]
    answer_followup(
        gh,
        **{
            _since("pulls"): {"stdout": json.dumps(comments[:1])},
            _since("issues"): {"stdout": json.dumps(comments[1:])},
            REVIEWS: {"stdout": json.dumps(reviews)},
            MERGE_STATUS: {
                "stdout": json.dumps(
                    {"mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY"}
                )
            },
        },
    )
    context = followup(tmp_path, previous())
    assert context.current_commit_sha == "3333333cccc"
    assert context.commits_since_review == [
        {"sha": "2222222bbbb"},
        {"sha": "3333333cccc"},
    ]
    assert context.files_changed_since_review == ["app.py", "logo.png"]
    assert context.diff_since_review == "--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@"
    assert [c["id"] for c in context.ai_bot_comments_since_review] == [1, 10]
    assert [c["id"] for c in context.contributor_comments_since_review] == [
        2,
        3,
        11,
        12,
    ]
    assert [r["id"] for r in context.pr_reviews_since_review] == [10, 11, 12]
    assert (context.has_merge_conflicts, context.merge_state_status) == (True, "DIRTY")
    assert context.error is None
    out = capsys.readouterr().out
    assert "2 AI feedback (1 comments, 1 reviews)" in out
    assert "PR has merge conflicts" in out


def test_after_a_rebase_a_followup_compares_file_blobs(tmp_path, gh, capsys):
    answer_followup(gh)
    review = previous(sha="9999999", reviewed_file_blobs={"app.py": "b1"})
    context = followup(tmp_path, review)
    assert context.files_changed_since_review == ["logo.png"]
    assert context.commits_since_review == []
    assert "(blob comparison used)" in capsys.readouterr().out


def test_when_the_pr_endpoints_fail_the_commits_are_compared(tmp_path, gh, capsys):
    comparison = {
        "commits": [{"sha": "3333333cccc"}],
        "files": [{"filename": "merged.py", "patch": "+x"}],
    }
    answer_followup(
        gh,
        **{
            _pages("files"): {"stderr": "Server Error", "code": 1},
            "api repos/{owner}/{repo}/compare/1111111aaaa...3333333cccc": {
                "stdout": json.dumps(comparison)
            },
        },
    )
    context = followup(tmp_path, previous())
    assert context.files_changed_since_review == ["merged.py"]
    assert context.commits_since_review == [{"sha": "3333333cccc"}]
    assert "Falling back to commit comparison" in capsys.readouterr().out


def test_when_the_comparison_fails_too_the_followup_says_why(tmp_path, gh):
    answer_followup(gh, **{_pages("files"): {"stderr": "Server Error", "code": 1}})
    context = followup(tmp_path, previous())
    assert context.error.startswith("Failed to get PR context: gh api failed")
    assert "fallback: gh api failed" in context.error
    assert context.current_commit_sha == "3333333cccc"


def test_feedback_that_cannot_be_read_does_not_stop_a_followup(tmp_path, gh, capsys):
    limited = {"stderr": "API rate limit exceeded", "code": 1}
    answer_followup(
        gh,
        **{
            _since("pulls"): limited,
            REVIEWS: limited,
            MERGE_STATUS: {"stderr": "Bad credentials", "code": 1},
        },
    )
    context = followup(tmp_path, previous())
    assert context.contributor_comments_since_review == []
    assert context.pr_reviews_since_review == []
    assert (context.has_merge_conflicts, context.merge_state_status) == (
        False,
        "UNKNOWN",
    )
    assert context.files_changed_since_review == ["app.py", "logo.png"]
    out = capsys.readouterr().out
    assert "Error fetching comments" in out
    assert "Error fetching PR reviews" in out
    assert "Could not fetch merge status" in out
