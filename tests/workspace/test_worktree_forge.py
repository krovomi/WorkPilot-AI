"""Pushing a task's branch and opening its pull / merge request, end to end.

`WorktreePRMixin` (core/worktree_pr.py) against a real repository: a task
worktree with a commit, and an ``origin`` whose fetch URL names the forge
(GitHub, GitLab or Azure DevOps) while its push URL is a bare repository in
``tmp_path``, so ``git push`` really lands somewhere this test can read.

Stand-ins only at the boundaries: ``gh`` / ``glab`` are the fake of
``tests/gh_fake.py`` (a program that records its arguments), the Azure DevOps
REST API is a recorder in place of ``requests.get`` / ``requests.post``, and
the model (impact analyzer, PR template filler) answers from the test.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import core.worktree_pr as worktree_pr
import pytest
import requests
from core import worktree_common
from core.worktree import WorktreeManager

# Loaded by path, not through sys.path (see tests/pr_followup/test_runner_cli.py).
_spec = importlib.util.spec_from_file_location(
    "worktree_forge_gh_fake", Path(__file__).resolve().parents[1] / "gh_fake.py"
)
_gh_fake = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _gh_fake
_spec.loader.exec_module(_gh_fake)
write_fake_gh = _gh_fake.write_fake_gh

SPEC = "001-add-cart"
BRANCH = f"workpilot/{SPEC}"
GITHUB_URL = "https://github.com/acme/shop.git"
GITLAB_URL = "https://gitlab.com/acme/shop.git"
AZURE_URL = "https://dev.azure.com/acme/Shop%20App/_git/shop"
AZURE_PR = "https://dev.azure.com/acme/Shop%20App/_git/shop/pullrequest"
PAT = "azure-test-0000"  # pragma: allowlist secret


def git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=check,
    )


def commit_file(cwd: Path, name: str, content: str, message: str) -> None:
    path = cwd / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    git(cwd, "add", "--", name)
    git(cwd, "commit", "-m", message)


def write_hook(bare: Path, body: str) -> None:
    hook = bare / "hooks" / "pre-receive"
    hook.write_text("#!/bin/sh\n" + body, encoding="utf-8", newline="\n")
    hook.chmod(hook.stat().st_mode | stat.S_IEXEC)


class Forge:
    """The project, its task worktree, and what the forge was asked."""

    def __init__(self, repo: Path, bare: Path, root: Path, monkeypatch):
        self.repo = repo
        self.bare = bare
        self.root = root
        self.monkeypatch = monkeypatch
        self.manager = WorktreeManager(repo, base_branch="main", use_local_branch=True)
        self.manager.create_worktree(SPEC)
        self.worktree = self.manager.get_worktree_path(SPEC)
        commit_file(self.worktree, "cart.py", "def total():\n    return 0\n", "cart")
        self.gh = write_fake_gh(root / "gh", {})
        self.glab = write_fake_gh(root / "glab", {})
        monkeypatch.setattr(worktree_pr, "get_gh_executable", lambda: str(self.gh.path))
        monkeypatch.setattr(
            worktree_pr, "get_glab_executable", lambda: str(self.glab.path)
        )

    def remote(self, url: str) -> None:
        git(self.repo, "remote", "set-url", "origin", url)
        git(self.repo, "config", "remote.origin.pushurl", str(self.bare))

    def origin_has(self, ref: str) -> str | None:
        found = git(self.bare, "rev-parse", "--verify", "--quiet", ref, check=False)
        return found.stdout.strip() or None

    def head(self) -> str:
        return git(self.worktree, "rev-parse", "HEAD").stdout.strip()

    def spec_dir(self, in_worktree: bool = False) -> Path:
        base = self.worktree if in_worktree else self.repo
        path = base / ".workpilot" / "specs" / SPEC
        path.mkdir(parents=True, exist_ok=True)
        return path


@pytest.fixture
def forge(isolated_repo, tmp_path, monkeypatch):
    # No global or system git configuration (credential helpers, hooks) and
    # never a prompt: the test's repository is all git sees.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("GIT_TERMINAL_PROMPT", "0")
    monkeypatch.delenv("GIT_ASKPASS", raising=False)
    monkeypatch.delenv("SSH_ASKPASS", raising=False)
    monkeypatch.delenv("AZURE_DEVOPS_PAT", raising=False)
    monkeypatch.delenv("AZURE_DEVOPS_EXT_PAT", raising=False)
    monkeypatch.delenv("APP_LANGUAGE", raising=False)
    monkeypatch.delenv("GIT_CONFIG_COUNT", raising=False)

    bare = tmp_path / "origin.git"
    git(tmp_path, "init", "--bare", "-b", "main", str(bare))
    git(isolated_repo, "remote", "add", "origin", GITHUB_URL)
    git(isolated_repo, "config", "remote.origin.pushurl", str(bare))
    git(isolated_repo, "push", "origin", "main")
    git(isolated_repo, "update-ref", "refs/remotes/origin/main", "main")

    sleeps: list[float] = []
    # The retry backoff only: `subprocess` polls with the real `time.sleep`.
    monkeypatch.setattr(worktree_common, "time", SimpleNamespace(sleep=sleeps.append))

    impact_calls: list[dict] = []

    def no_model_impact(**kwargs):
        impact_calls.append(kwargs)
        return None

    # On the module object `from agents.x import y` reads (sys.modules): a
    # file that mocks `agents` at collection can leave the package attribute
    # on another copy, and the real model would then be reached.
    monkeypatch.setattr(
        importlib.import_module("agents.impact_analyzer"),
        "run_impact_analyzer_sync",
        no_model_impact,
    )
    f = Forge(isolated_repo, bare, tmp_path, monkeypatch)
    f.sleeps = sleeps
    f.impact_calls = impact_calls
    return f


# ── push_branch ─────────────────────────────────────────────────────────


class TestPushBranch:
    def test_push_lands_the_branch_in_origin(self, forge):
        result = forge.manager.push_branch(SPEC)

        assert result == {"success": True, "branch": BRANCH, "remote": "origin"}
        assert forge.origin_has(f"refs/heads/{BRANCH}") == forge.head()

    def test_no_worktree_is_said(self, forge):
        result = forge.manager.push_branch("999-missing")

        assert result["success"] is False
        assert result["error"] == "No worktree found for spec: 999-missing"

    def test_detached_head_is_reattached_to_the_task_branch(self, forge):
        git(forge.worktree, "checkout", "--detach")
        commit_file(forge.worktree, "cart.py", "def total():\n    return 1\n", "fix")
        detached = forge.head()

        result = forge.manager.push_branch(SPEC)

        assert result["success"] is True
        assert git(forge.worktree, "branch", "--show-current").stdout.strip() == BRANCH
        assert forge.origin_has(f"refs/heads/{BRANCH}") == detached

    def test_detached_head_without_its_branch_creates_it(self, forge):
        git(forge.worktree, "checkout", "--detach")
        git(forge.repo, "branch", "-D", BRANCH)

        result = forge.manager.push_branch(SPEC)

        assert result["success"] is True
        assert forge.origin_has(f"refs/heads/{BRANCH}") == forge.head()

    def test_branch_checked_out_elsewhere_cannot_be_moved(self, forge):
        git(forge.worktree, "checkout", "--detach")
        git(forge.repo, "checkout", BRANCH)

        result = forge.manager.push_branch(SPEC)

        assert result["success"] is False
        assert result["branch"] == BRANCH
        assert result["error"].startswith(f"Failed to update branch '{BRANCH}'")

    def _lock_index(self, forge) -> None:
        gitdir = git(forge.worktree, "rev-parse", "--git-dir").stdout.strip()
        (forge.worktree / gitdir / "index.lock").write_text("", encoding="utf-8")

    def test_locked_index_stops_the_reattach(self, forge):
        git(forge.worktree, "checkout", "--detach")
        commit_file(forge.worktree, "cart.py", "x = 2\n", "detached work")
        self._lock_index(forge)

        result = forge.manager.push_branch(SPEC)

        assert result["success"] is False
        assert result["error"].startswith(f"Failed to re-attach to branch '{BRANCH}'")

    def test_a_ref_in_the_way_stops_the_branch_creation(self, forge):
        git(forge.worktree, "checkout", "--detach")
        git(forge.repo, "branch", "-D", BRANCH)
        git(forge.repo, "branch", f"{BRANCH}/old", "main")

        result = forge.manager.push_branch(SPEC)

        assert result["success"] is False
        assert result["error"].startswith(f"Failed to create branch '{BRANCH}'")

    def test_rewritten_history_needs_force(self, forge):
        assert forge.manager.push_branch(SPEC)["success"] is True
        git(forge.worktree, "commit", "--amend", "-m", "cart, reworded")

        refused = forge.manager.push_branch(SPEC)
        forced = forge.manager.push_branch(SPEC, force=True)

        assert refused["success"] is False
        assert refused["error"].startswith("Failed to push branch: ")
        assert "rejected" in refused["error"]
        assert forced["success"] is True
        assert forge.origin_has(f"refs/heads/{BRANCH}") == forge.head()

    def test_missing_git_is_said(self, forge, monkeypatch):
        monkeypatch.setattr(
            worktree_pr, "get_git_executable", lambda: str(forge.root / "no-git")
        )

        result = forge.manager.push_branch(SPEC)

        assert result["error"] == "Failed to push branch: git executable not found"

    def test_a_hung_push_times_out_after_three_attempts(self, forge):
        forge.manager.GIT_PUSH_TIMEOUT = 0.001

        result = forge.manager.push_branch(SPEC)

        assert result["error"] == "Push timed out after 3 attempts."
        assert forge.sleeps == [1, 2]

    def test_a_dropped_connection_is_retried(self, forge):
        marker = forge.root / "dropped-once"
        write_hook(
            forge.bare,
            f'if [ ! -f "{marker.as_posix()}" ]; then\n'
            f'  touch "{marker.as_posix()}"\n'
            '  echo "fatal: connection reset by peer" >&2\n'
            "  exit 1\n"
            "fi\n",
        )

        result = forge.manager.push_branch(SPEC)

        assert result["success"] is True
        assert forge.sleeps == [1]

    def test_a_403_points_at_the_pat_scope(self, forge):
        write_hook(
            forge.bare, 'echo "The requested URL returned error: 403" >&2\nexit 1\n'
        )

        result = forge.manager.push_branch(SPEC)

        assert result["success"] is False
        assert "HTTP 403" in result["error"]
        assert "Code (Read & Write)" in result["error"]
        assert forge.sleeps == []


# ── Azure DevOps credentials and push authentication ────────────────────


class TestAzureCredentials:
    def test_the_environment_pat_wins(self, forge, monkeypatch):
        monkeypatch.setenv("AZURE_DEVOPS_EXT_PAT", PAT)

        assert forge.manager._get_azure_devops_credentials() == ("", PAT)

    def test_the_git_credential_helper_answers(self, forge):
        forge.remote(AZURE_URL)
        git(
            forge.repo,
            "config",
            "credential.helper",
            "!f() { echo username=bot; echo password=helper-test-0000; }; f",
        )

        assert forge.manager._get_azure_devops_credentials() == (
            "bot",
            "helper-test-0000",  # pragma: allowlist secret
        )

    def test_no_helper_and_no_prompt_gives_nothing(self, forge):
        forge.remote(AZURE_URL)

        assert forge.manager._get_azure_devops_credentials() is None

    def test_no_origin_gives_nothing(self, forge):
        git(forge.repo, "remote", "remove", "origin")

        assert forge.manager._get_azure_devops_credentials() is None

    def test_a_remote_without_host_gives_nothing(self, forge):
        git(forge.repo, "remote", "set-url", "origin", str(forge.bare))

        assert forge.manager._get_azure_devops_credentials() is None

    def test_push_auth_is_added_for_azure_only(self, forge, monkeypatch):
        monkeypatch.setenv("AZURE_DEVOPS_PAT", PAT)
        base = {"PATH": "x"}

        assert forge.manager._inject_azure_push_auth(base) is base  # GitHub remote

        forge.remote(AZURE_URL)
        env = forge.manager._inject_azure_push_auth(base)

        assert env["GIT_CONFIG_COUNT"] == "1"
        assert env["GIT_CONFIG_KEY_0"] == "http.extraheader"
        assert env["GIT_CONFIG_VALUE_0"].startswith("Authorization: Basic ")
        assert base == {"PATH": "x"}

    def test_push_auth_follows_existing_config_entries(self, forge, monkeypatch):
        monkeypatch.setenv("AZURE_DEVOPS_PAT", PAT)
        forge.remote(AZURE_URL)

        after_two = forge.manager._inject_azure_push_auth({"GIT_CONFIG_COUNT": "2"})
        unreadable = forge.manager._inject_azure_push_auth({"GIT_CONFIG_COUNT": "x"})

        assert after_two["GIT_CONFIG_KEY_2"] == "http.extraheader"
        assert after_two["GIT_CONFIG_COUNT"] == "3"
        assert unreadable["GIT_CONFIG_KEY_0"] == "http.extraheader"
        assert unreadable["GIT_CONFIG_COUNT"] == "1"

    def test_no_credentials_leaves_the_push_alone(self, forge):
        forge.remote(AZURE_URL)
        base = {"PATH": "x"}

        assert forge.manager._inject_azure_push_auth(base) is base

    def test_an_azure_push_lands_with_the_pat(self, forge, monkeypatch):
        monkeypatch.setenv("AZURE_DEVOPS_PAT", PAT)
        forge.remote(AZURE_URL)

        assert forge.manager.push_branch(SPEC)["success"] is True
        assert forge.origin_has(f"refs/heads/{BRANCH}") == forge.head()


# ── Azure DevOps pull requests (REST API) ───────────────────────────────


class Reply:
    def __init__(self, status_code: int, data=None, text: str = ""):
        self.status_code = status_code
        self._data = data
        self.text = text if text else json.dumps(data) if data is not None else ""

    def json(self):
        if self._data is None:
            raise ValueError("no JSON body")
        return self._data


class AzureApi:
    """`requests.get` / `requests.post` for dev.azure.com, answering in order."""

    def __init__(self, monkeypatch):
        self.gets: list[tuple[str, tuple]] = []
        self.posts: list[tuple[str, dict, tuple]] = []
        self.get_replies: list = [Reply(200, {"value": []})]
        self.post_replies: list = [Reply(201, {"pullRequestId": 42})]
        monkeypatch.setattr(requests, "get", self.get)
        monkeypatch.setattr(requests, "post", self.post)

    @staticmethod
    def _next(replies: list):
        reply = replies.pop(0) if len(replies) > 1 else replies[0]
        if isinstance(reply, BaseException):
            raise reply
        return reply

    def get(self, url, auth=None, timeout=None):
        self.gets.append((url, auth))
        return self._next(self.get_replies)

    def post(self, url, json=None, auth=None, timeout=None):
        self.posts.append((url, json, auth))
        return self._next(self.post_replies)


@pytest.fixture
def azure(forge, monkeypatch):
    monkeypatch.setenv("AZURE_DEVOPS_PAT", PAT)
    forge.remote(AZURE_URL)
    return AzureApi(monkeypatch)


class TestAzurePullRequest:
    def test_creates_the_pull_request(self, forge, azure):
        result = forge.manager.create_azure_pull_request(
            SPEC, title="Add the cart", draft=True, body="Adds a cart."
        )

        assert result == {
            "success": True,
            "pr_url": f"{AZURE_PR}/42",
            "already_exists": False,
        }
        url, payload, auth = azure.posts[0]
        assert url == (
            "https://dev.azure.com/acme/Shop%20App/_apis/git/repositories/shop"
            "/pullrequests?api-version=7.1"
        )
        assert payload == {
            "sourceRefName": f"refs/heads/{BRANCH}",
            "targetRefName": "refs/heads/main",
            "title": "Add the cart",
            "description": "Adds a cart.",
            "isDraft": True,
        }
        assert auth == ("", PAT)
        assert "searchCriteria.status=active" in azure.gets[0][0]
        assert forge.impact_calls == []  # a caller's body is used verbatim

    def test_composes_the_body_when_none_is_given(self, forge, azure):
        result = forge.manager.create_azure_pull_request(SPEC, body_suffix="## Group")

        assert result["success"] is True
        _url, payload, _auth = azure.posts[0]
        assert payload["title"] == f"feat: {SPEC}"
        assert "isDraft" not in payload
        assert "workpilot-impact-block" in payload["description"]
        assert payload["description"].rstrip().endswith("## Group")
        assert "cart.py" in forge.impact_calls[0]["diff_summary"]

    def test_an_open_pull_request_is_returned(self, forge, azure):
        azure.get_replies = [Reply(200, {"value": [{"pullRequestId": 7}]})]

        result = forge.manager.create_azure_pull_request(SPEC, body="b")

        assert result == {
            "success": True,
            "pr_url": f"{AZURE_PR}/7",
            "already_exists": True,
        }
        assert azure.posts == []

    def test_a_failed_search_still_creates(self, forge, azure):
        azure.get_replies = [requests.exceptions.SSLError("search refused")]

        result = forge.manager.create_azure_pull_request(SPEC, body="b")

        assert result["pr_url"] == f"{AZURE_PR}/42"

    def test_a_conflict_finds_the_existing_pull_request(self, forge, azure):
        azure.get_replies = [
            Reply(200, {"value": []}),
            Reply(200, {"value": [{"pullRequestId": 9}]}),
        ]
        azure.post_replies = [Reply(409, {"message": "TF401179: already exists"})]

        result = forge.manager.create_azure_pull_request(SPEC, body="b")

        assert result == {
            "success": True,
            "pr_url": f"{AZURE_PR}/9",
            "already_exists": True,
        }

    def test_a_conflict_that_cannot_be_found_is_an_error(self, forge, azure):
        azure.get_replies = [Reply(200, {"value": []}), requests.exceptions.SSLError()]
        azure.post_replies = [Reply(409, {"message": "TF401179: already exists"})]

        result = forge.manager.create_azure_pull_request(SPEC, body="b")

        assert result["success"] is False
        assert result["error"] == (
            "Azure DevOps API error (HTTP 409): TF401179: already exists"
        )

    @pytest.mark.parametrize(
        ("status", "error"),
        [
            (401, "Azure DevOps authentication failed. Check your PAT or credentials."),
            (
                403,
                "Azure DevOps access denied. Ensure your PAT has "
                "'Code (Read & Write)' scope.",
            ),
        ],
    )
    def test_auth_refusals_are_explained(self, forge, azure, status, error):
        azure.post_replies = [Reply(status, text="denied")]

        result = forge.manager.create_azure_pull_request(SPEC, body="b")

        assert result == {"success": False, "error": error}
        assert len(azure.posts) == 1

    def test_a_server_error_is_retried_then_reported(self, forge, azure):
        azure.post_replies = [Reply(503, text="Service Unavailable")]

        result = forge.manager.create_azure_pull_request(SPEC, body="b")

        assert result["error"] == (
            "Azure DevOps API error (HTTP 503): Service Unavailable"
        )
        assert len(azure.posts) == 3
        assert forge.sleeps == [1, 2]

    def test_a_timeout_is_retried(self, forge, azure):
        azure.post_replies = [
            requests.exceptions.Timeout(),
            Reply(201, {"pullRequestId": 5}),
        ]

        result = forge.manager.create_azure_pull_request(SPEC, body="b")

        assert result["pr_url"] == f"{AZURE_PR}/5"
        assert forge.sleeps == [1]

    def test_a_connection_error_is_reported(self, forge, azure):
        azure.post_replies = [requests.exceptions.ConnectionError("no route")]

        result = forge.manager.create_azure_pull_request(SPEC, body="b")

        assert result["error"] == "connection error: no route"
        assert len(azure.posts) == 3

    def test_an_unexpected_failure_is_not_retried(self, forge, azure):
        azure.post_replies = [Reply(201, None, text="not json")]

        result = forge.manager.create_azure_pull_request(SPEC, body="b")

        assert result["error"] == (
            "Failed to create Azure DevOps pull request: no JSON body"
        )
        assert len(azure.posts) == 1

    def test_no_worktree(self, forge, azure):
        result = forge.manager.create_azure_pull_request("999-missing", body="b")

        assert result["error"] == "No worktree found for spec: 999-missing"

    @pytest.mark.parametrize(
        ("url", "missing"),
        [
            (GITHUB_URL, "organization"),
            ("https://dev.azure.com/acme/", "project"),
            ("https://dev.azure.com/acme/Shop/_git/", "repository"),
        ],
    )
    def test_coordinates_come_from_the_remote(self, forge, azure, url, missing):
        forge.remote(url)

        result = forge.manager.create_azure_pull_request(SPEC, body="b")

        assert result["error"] == (
            f"Could not extract Azure DevOps {missing} from git remote URL"
        )

    def test_no_credentials(self, forge, azure, monkeypatch):
        monkeypatch.delenv("AZURE_DEVOPS_PAT")

        result = forge.manager.create_azure_pull_request(SPEC, body="b")

        assert result["error"].startswith("No Azure DevOps credentials found.")


# ── GitHub pull requests (gh) ───────────────────────────────────────────

PR_URL = "https://github.com/acme/shop/pull/7"


class TestGitHubPullRequest:
    def test_creates_the_pull_request(self, forge):
        forge.gh.answer({"pr create": {"stdout": PR_URL + "\n"}})

        result = forge.manager.create_pull_request(
            SPEC, title="Add the cart", draft=True, body="Adds a cart."
        )

        assert result == {"success": True, "pr_url": PR_URL, "already_exists": False}
        assert forge.gh.calls() == [
            [
                "pr",
                "create",
                "--base",
                "main",
                "--head",
                BRANCH,
                "--title",
                "Add the cart",
                "--body",
                "Adds a cart.",
                "--draft",
            ]
        ]

    def test_the_url_is_found_among_other_output(self, forge):
        forge.gh.answer(
            {"pr create": {"stdout": f"Creating pull request\n{PR_URL}\nDone\n"}}
        )

        result = forge.manager.create_pull_request(SPEC, body="b")

        assert result["pr_url"] == PR_URL

    def test_output_without_url(self, forge):
        forge.gh.answer({"pr create": {"stdout": "created\n"}})

        result = forge.manager.create_pull_request(SPEC, body="b")

        assert result == {"success": True, "pr_url": None, "already_exists": False}

    def test_composes_the_body_when_none_is_given(self, forge):
        forge.gh.answer({"pr create": {"stdout": PR_URL}})

        result = forge.manager.create_pull_request(SPEC, target_branch="main")

        assert result["success"] is True
        call = forge.gh.calls()[0]
        assert call[:8] == [
            "pr",
            "create",
            "--base",
            "main",
            "--head",
            BRANCH,
            "--title",
            f"feat: {SPEC}",
        ]
        assert "cart.py" in forge.impact_calls[0]["diff_summary"]
        assert "cart" in forge.impact_calls[0]["commit_log"]

    def test_an_existing_pull_request_is_returned(self, forge):
        forge.gh.answer(
            {
                "pr create": {"code": 1, "stderr": "a pull request already exists"},
                f"pr view {BRANCH}": {"stdout": PR_URL + "\n"},
            }
        )

        result = forge.manager.create_pull_request(SPEC, body="b")

        assert result == {"success": True, "pr_url": PR_URL, "already_exists": True}
        assert forge.gh.calls()[1] == [
            "pr",
            "view",
            BRANCH,
            "--json",
            "url",
            "--jq",
            ".url",
        ]

    def test_an_existing_pull_request_without_url(self, forge):
        forge.gh.answer({"pr create": {"code": 1, "stderr": "Already exists"}})

        result = forge.manager.create_pull_request(SPEC, body="b")

        assert result["already_exists"] is True
        assert result["pr_url"] is None
        assert result["message"] == "PR already exists but URL could not be retrieved"

    def test_a_server_error_is_retried(self, forge):
        forge.gh.answer({"pr create": {"code": 1, "stderr": "HTTP 502: Bad Gateway"}})

        result = forge.manager.create_pull_request(SPEC, body="b")

        assert result["error"] == "Failed to create PR: HTTP 502: Bad Gateway"
        assert len(forge.gh.calls()) == 3

    def test_a_validation_error_is_not_retried(self, forge):
        forge.gh.answer({"pr create": {"code": 1, "stderr": "HTTP 422: no commits"}})

        result = forge.manager.create_pull_request(SPEC, body="b")

        assert result["error"] == "Failed to create PR: HTTP 422: no commits"
        assert len(forge.gh.calls()) == 1

    def test_a_hung_gh_times_out(self, forge):
        forge.manager.CLI_TIMEOUT = 0.001

        result = forge.manager.create_pull_request(SPEC, body="b")

        assert result["error"] == "PR creation timed out after 3 attempts."

    def test_no_gh(self, forge, monkeypatch):
        monkeypatch.setattr(worktree_pr, "get_gh_executable", lambda: None)

        result = forge.manager.create_pull_request(SPEC, body="b")

        assert result["error"] == (
            "GitHub CLI (gh) not found. Install from https://cli.github.com/"
        )

    def test_a_vanished_gh_clears_the_cache(self, forge, monkeypatch):
        cleared: list[bool] = []
        monkeypatch.setattr(
            worktree_pr, "get_gh_executable", lambda: str(forge.root / "gone" / "gh")
        )
        monkeypatch.setattr(
            worktree_pr, "invalidate_gh_cache", lambda: cleared.append(1)
        )

        result = forge.manager.create_pull_request(SPEC, body="b")

        assert result["error"].startswith("GitHub CLI (gh) not found.")
        assert cleared == [1]

    def test_no_worktree(self, forge):
        result = forge.manager.create_pull_request("999-missing", body="b")

        assert result["error"] == "No worktree found for spec: 999-missing"


class TestExistingGitHubPullRequest:
    def test_found(self, forge):
        forge.gh.answer({"pr view": {"stdout": PR_URL + "\n"}})

        assert forge.manager._get_existing_pr_url(SPEC, "main") == PR_URL

    def test_none_open(self, forge):
        forge.gh.answer({"pr view": {"code": 1, "stderr": "no pull requests found"}})

        assert forge.manager._get_existing_pr_url(SPEC, "main") is None

    def test_no_worktree_or_no_gh(self, forge, monkeypatch):
        assert forge.manager._get_existing_pr_url("999-missing", "main") is None
        monkeypatch.setattr(worktree_pr, "get_gh_executable", lambda: None)
        assert forge.manager._get_existing_pr_url(SPEC, "main") is None

    def test_a_vanished_gh(self, forge, monkeypatch):
        cleared: list[bool] = []
        monkeypatch.setattr(
            worktree_pr, "get_gh_executable", lambda: str(forge.root / "gone" / "gh")
        )
        monkeypatch.setattr(
            worktree_pr, "invalidate_gh_cache", lambda: cleared.append(1)
        )

        assert forge.manager._get_existing_pr_url(SPEC, "main") is None
        assert cleared == [1]

    def test_a_hung_gh(self, forge):
        forge.manager.CLI_QUERY_TIMEOUT = 0.001

        assert forge.manager._get_existing_pr_url(SPEC, "main") is None


# ── GitLab merge requests (glab) ────────────────────────────────────────

MR_URL = "https://gitlab.com/acme/shop/-/merge_requests/4"


class TestGitLabMergeRequest:
    def test_creates_the_merge_request(self, forge):
        forge.remote(GITLAB_URL)
        forge.glab.answer({"mr create": {"stdout": MR_URL + "\n"}})

        result = forge.manager.create_merge_request(
            SPEC, title="Add the cart", draft=True, body="Adds a cart."
        )

        assert result == {"success": True, "pr_url": MR_URL, "already_exists": False}
        assert forge.glab.calls() == [
            [
                "mr",
                "create",
                "--target-branch",
                "main",
                "--source-branch",
                BRANCH,
                "--title",
                "Add the cart",
                "--description",
                "Adds a cart.",
                "--draft",
            ]
        ]

    def test_composes_the_description(self, forge):
        forge.glab.answer({"mr create": {"stdout": f"Creating\n{MR_URL}\n"}})

        result = forge.manager.create_merge_request(SPEC)

        assert result["pr_url"] == MR_URL
        assert forge.glab.calls()[0][7] == f"feat: {SPEC}"
        assert "cart.py" in forge.impact_calls[0]["diff_summary"]

    def test_output_without_url(self, forge):
        forge.glab.answer({"mr create": {"stdout": "created"}})

        assert forge.manager.create_merge_request(SPEC, body="b")["pr_url"] is None

    def test_an_existing_merge_request_is_returned(self, forge):
        forge.glab.answer(
            {
                "mr create": {"code": 1, "stderr": "MR already exists"},
                f"mr view {BRANCH}": {"stdout": json.dumps({"web_url": MR_URL})},
            }
        )

        result = forge.manager.create_merge_request(SPEC, body="b")

        assert result == {"success": True, "pr_url": MR_URL, "already_exists": True}
        assert forge.glab.calls()[1] == ["mr", "view", BRANCH, "--output", "json"]

    def test_an_existing_merge_request_without_url(self, forge):
        forge.glab.answer(
            {
                "mr create": {"code": 1, "stderr": "already exists"},
                "mr view": {"stdout": "not json"},
            }
        )

        result = forge.manager.create_merge_request(SPEC, body="b")

        assert result["pr_url"] is None
        assert result["message"] == "MR already exists but URL could not be retrieved"

    def test_a_server_error_is_retried(self, forge):
        forge.glab.answer({"mr create": {"code": 1, "stderr": "HTTP 500 error"}})

        result = forge.manager.create_merge_request(SPEC, body="b")

        assert result["error"] == "Failed to create MR: HTTP 500 error"
        assert len(forge.glab.calls()) == 3

    def test_a_hung_glab_times_out(self, forge):
        forge.manager.CLI_TIMEOUT = 0.001

        result = forge.manager.create_merge_request(SPEC, body="b")

        assert result["error"] == "MR creation timed out after 3 attempts."

    def test_no_glab(self, forge, monkeypatch):
        monkeypatch.setattr(worktree_pr, "get_glab_executable", lambda: None)

        result = forge.manager.create_merge_request(SPEC, body="b")

        assert result["error"] == (
            "GitLab CLI (glab) not found. Install from https://gitlab.com/gitlab-org/cli"
        )

    def test_a_vanished_glab_clears_the_cache(self, forge, monkeypatch):
        cleared: list[bool] = []
        monkeypatch.setattr(
            worktree_pr, "get_glab_executable", lambda: str(forge.root / "gone")
        )
        monkeypatch.setattr(
            worktree_pr, "invalidate_glab_cache", lambda: cleared.append(1)
        )

        result = forge.manager.create_merge_request(SPEC, body="b")

        assert result["error"].startswith("GitLab CLI (glab) not found.")
        assert cleared == [1]

    def test_no_worktree(self, forge):
        result = forge.manager.create_merge_request("999-missing", body="b")

        assert result["error"] == "No worktree found for spec: 999-missing"


class TestExistingGitLabMergeRequest:
    def test_found(self, forge):
        forge.glab.answer({"mr view": {"stdout": json.dumps({"web_url": MR_URL})}})

        assert forge.manager._get_existing_mr_url(SPEC, "main") == MR_URL

    def test_none_open(self, forge):
        forge.glab.answer({"mr view": {"code": 1, "stderr": "no open MR"}})

        assert forge.manager._get_existing_mr_url(SPEC, "main") is None

    def test_no_worktree_or_no_glab(self, forge, monkeypatch):
        assert forge.manager._get_existing_mr_url("999-missing", "main") is None
        monkeypatch.setattr(worktree_pr, "get_glab_executable", lambda: None)
        assert forge.manager._get_existing_mr_url(SPEC, "main") is None

    def test_a_vanished_glab(self, forge, monkeypatch):
        cleared: list[bool] = []
        monkeypatch.setattr(
            worktree_pr, "get_glab_executable", lambda: str(forge.root / "gone")
        )
        monkeypatch.setattr(
            worktree_pr, "invalidate_glab_cache", lambda: cleared.append(1)
        )

        assert forge.manager._get_existing_mr_url(SPEC, "main") is None
        assert cleared == [1]

    def test_a_hung_glab(self, forge):
        forge.manager.CLI_QUERY_TIMEOUT = 0.001

        assert forge.manager._get_existing_mr_url(SPEC, "main") is None


class TestFindExistingPullRequest:
    def test_github(self, forge):
        forge.gh.answer({"pr view": {"stdout": PR_URL}})

        assert forge.manager.find_existing_pr_url(SPEC) == PR_URL

    def test_gitlab(self, forge):
        forge.remote(GITLAB_URL)
        forge.glab.answer({"mr view": {"stdout": json.dumps({"web_url": MR_URL})}})

        assert forge.manager.find_existing_pr_url(SPEC) == MR_URL

    def test_azure(self, forge, azure):
        azure.get_replies = [Reply(200, {"value": [{"pullRequestId": 3}]})]

        assert forge.manager.find_existing_pr_url(SPEC, "develop") == f"{AZURE_PR}/3"
        assert "targetRefName=refs/heads/develop" in azure.gets[0][0]

    def test_azure_without_an_open_pull_request(self, forge, azure):
        assert forge.manager.find_existing_pr_url(SPEC) is None

    def test_azure_unreachable(self, forge, azure):
        azure.get_replies = [requests.exceptions.ConnectionError("down")]

        assert forge.manager.find_existing_pr_url(SPEC) is None

    def test_azure_without_credentials_coordinates_or_worktree(
        self, forge, azure, monkeypatch
    ):
        assert forge.manager._get_existing_azure_pr_url("999-missing") is None
        monkeypatch.delenv("AZURE_DEVOPS_PAT")
        assert forge.manager._get_existing_azure_pr_url(SPEC) is None
        forge.remote(GITHUB_URL)
        assert forge.manager._get_existing_azure_pr_url(SPEC) is None
        assert azure.gets == []


# ── The PR body ─────────────────────────────────────────────────────────


@pytest.fixture
def template(forge):
    # The directory form (.github/PULL_REQUEST_TEMPLATE/<name>.md): this
    # repository's own single-file template must stay unread by tests
    # (tests/test_ci_triggers.py), and the filler reads both forms.
    github = forge.repo / ".github"
    (github / "PULL_REQUEST_TEMPLATE").mkdir(parents=True)
    (github / "PULL_REQUEST_TEMPLATE" / "default.md").write_text(
        "## What\n\n## Why\n", encoding="utf-8"
    )
    return github


@pytest.fixture
def filler(monkeypatch):
    """The PR template filler, answering instead of a model."""
    calls: list[dict] = []
    answer: dict = {"value": "## What\nA cart."}

    async def fill(**kwargs):
        calls.append(kwargs)
        value = answer["value"]
        if isinstance(value, BaseException):
            raise value
        return value

    monkeypatch.setattr(
        importlib.import_module("agents.pr_template_filler"),
        "run_pr_template_filler",
        fill,
    )
    fill.calls = calls
    fill.answer = answer
    return fill


class TestAiPrBody:
    def _body(self, forge):
        return forge.manager._try_ai_pr_body(
            spec_name=SPEC,
            target_branch="main",
            branch_name=BRANCH,
            diff_summary="d",
            commit_log="c",
        )

    def test_no_template_no_model(self, forge, filler):
        forge.spec_dir()

        assert self._body(forge) is None
        assert filler.calls == []

    def test_the_template_is_filled(self, forge, template, filler):
        spec_dir = forge.spec_dir()

        assert self._body(forge) == "## What\nA cart."
        assert filler.calls[0]["spec_dir"] == spec_dir
        assert filler.calls[0]["branch_name"] == BRANCH

    def test_the_worktree_spec_is_used_when_the_project_has_none(
        self, forge, template, filler
    ):
        spec_dir = forge.spec_dir(in_worktree=True)

        assert self._body(forge) == "## What\nA cart."
        assert filler.calls[0]["spec_dir"] == spec_dir

    def test_no_spec_no_model(self, forge, template, filler):
        assert self._body(forge) is None
        assert filler.calls == []

    @pytest.mark.parametrize(
        "failure", [TimeoutError(), RuntimeError("model down")], ids=["slow", "down"]
    )
    def test_a_failing_model_gives_no_body(self, forge, template, filler, failure):
        forge.spec_dir()
        filler.answer["value"] = failure

        assert self._body(forge) is None

    def test_inside_a_running_loop(self, forge, template, filler):
        forge.spec_dir()

        async def from_async_code():
            return self._body(forge)

        assert asyncio.run(from_async_code()) == "## What\nA cart."

    def test_without_the_filler_module(self, forge, template, monkeypatch):
        monkeypatch.setitem(sys.modules, "agents.pr_template_filler", None)

        assert self._body(forge) is None

    def test_the_ai_body_goes_into_the_pull_request(self, forge, template, filler):
        forge.spec_dir()
        forge.gh.answer({"pr create": {"stdout": PR_URL}})

        assert forge.manager.create_pull_request(SPEC)["success"] is True
        assert filler.calls[0]["diff_summary"].startswith("cart.py | 2")


class TestSpecSummary:
    def test_the_first_paragraph_of_the_spec(self, forge):
        (forge.spec_dir(in_worktree=True) / "spec.md").write_text(
            "# Cart\n\n## Overview\nShoppers keep a cart.\nIt has a total.\n\n"
            "## Requirements\n- not in the summary\n",
            encoding="utf-8",
        )

        body = forge.manager._extract_spec_summary(SPEC)

        assert body.startswith(
            "## 🤖 Summary\n\nShoppers keep a cart.\nIt has a total."
        )
        assert "not in the summary" not in body
        assert "- [ ] Tests pass (if applicable)" in body

    def test_the_project_spec_and_a_ten_line_cap(self, forge):
        lines = "\n".join(f"line {n}" for n in range(1, 15))
        (forge.spec_dir() / "spec.md").write_text(lines, encoding="utf-8")

        body = forge.manager._extract_spec_summary(SPEC)

        assert "line 10" in body
        assert "line 11" not in body

    def test_no_spec_in_french(self, forge, monkeypatch):
        monkeypatch.setenv("APP_LANGUAGE", "fr")

        body = forge.manager._extract_spec_summary(SPEC)

        assert body.startswith("## 🤖 Résumé\n\nPR générée automatiquement")

    def test_an_unreadable_spec_falls_back(self, forge):
        (forge.spec_dir() / "spec.md").write_bytes(b"\xff\xfe\xfa not utf-8")

        body = forge.manager._extract_spec_summary(SPEC)

        assert "Auto-generated PR from WorkPilot AI build." in body


class TestPreviewPrBody:
    def test_preview_has_the_impact_block(self, forge):
        preview = forge.manager.preview_pr_body(SPEC)

        assert preview["rating"] == "N/A"
        assert "workpilot-impact-block" in preview["body"]
        assert "cart.py" in forge.impact_calls[0]["diff_summary"]

    def test_preview_without_the_block_uses_the_model_answer(self, forge, monkeypatch):
        from agents.impact_analyzer import ImpactAnalysis

        monkeypatch.setattr(
            importlib.import_module("agents.impact_analyzer"),
            "run_impact_analyzer_sync",
            lambda **_kw: ImpactAnalysis(rating="3", features="Panier"),
        )

        preview = forge.manager.preview_pr_body(SPEC, include_impact=False)

        assert (preview["rating"], preview["features"]) == ("3", "Panier")
        assert "workpilot-impact-block" not in preview["body"]

    def test_preview_of_a_missing_worktree(self, forge):
        preview = forge.manager.preview_pr_body("999-missing", target_branch="main")

        assert preview["rating"] == "N/A"
        assert forge.impact_calls[0]["diff_summary"] == ""

    def test_the_impact_analysis_finds_the_worktree_spec(self, forge):
        spec_dir = forge.spec_dir(in_worktree=True)

        forge.manager.preview_pr_body(SPEC)

        assert forge.impact_calls[0]["spec_dir"] == spec_dir

    def test_without_the_impact_module(self, forge, monkeypatch):
        monkeypatch.setitem(sys.modules, "agents.impact_analyzer", None)

        assert forge.manager._inject_impact_block(SPEC, "body", "", "") == "body"

    def test_a_large_diff_is_cut(self, forge):
        commit_file(forge.worktree, "big.txt", "x" * 40_000 + "\n", "big")

        diff, _log = forge.manager._gather_pr_context(SPEC, "main")

        assert diff.endswith("(... diff truncated due to size)")


class TestProvenanceInTheBody:
    def test_the_provenance_block_is_appended(self, forge):
        forge.spec_dir()

        body = forge.manager._with_attribution(SPEC, "Body")

        dossiers = list((forge.repo / ".workpilot" / "specs" / SPEC).rglob("*"))
        assert body.startswith("Body")
        assert dossiers, "the provenance dossier is kept in the project's spec"

    def test_no_spec_no_provenance(self, forge):
        assert forge.manager._with_attribution(SPEC, "Body") == "Body"

    def test_without_the_provenance_module(self, forge, monkeypatch):
        forge.spec_dir()
        monkeypatch.setitem(sys.modules, "provenance", None)

        assert forge.manager._with_attribution(SPEC, "Body") == "Body"

    def test_without_the_trace_module(self, forge, monkeypatch):
        monkeypatch.setitem(sys.modules, "agent_trace", None)

        assert forge.manager._with_attribution(SPEC, "Body") == "Body"


# ── The discard list ────────────────────────────────────────────────────


class TestDiscardList:
    def _discard(self, forge, *lines: str) -> None:
        (forge.worktree / ".workpilot-discard-list").write_text(
            "\n".join(lines) + "\n", encoding="utf-8"
        )

    def test_discarded_files_leave_the_branch(self, forge):
        commit_file(forge.worktree, "README.md", "# Changed by the task\n", "readme")
        commit_file(forge.worktree, "scratch.txt", "notes\n", "scratch")
        self._discard(forge, "# the person's choices", "README.md", "", "scratch.txt")

        reverted = forge.manager._apply_discard_list(SPEC, "main")

        assert reverted == ["README.md", "scratch.txt"]
        tracked = git(forge.worktree, "ls-files").stdout.split()
        assert "scratch.txt" not in tracked
        assert (forge.worktree / "README.md").read_text(encoding="utf-8") == (
            "# Test repo\n"
        )
        assert git(forge.worktree, "log", "-1", "--format=%s").stdout.strip() == (
            "workpilot: exclude 2 user-discarded file(s)"
        )
        assert (
            git(forge.worktree, "status", "--porcelain", "--", "cart.py").stdout == ""
        )

    def test_the_local_target_is_used_without_a_remote_ref(self, forge):
        git(forge.repo, "update-ref", "-d", "refs/remotes/origin/main")
        commit_file(forge.worktree, "README.md", "# Changed\n", "readme")
        self._discard(forge, "README.md")

        assert forge.manager._apply_discard_list(SPEC, "main") == ["README.md"]

    def test_an_unchanged_file_reverts_to_nothing_to_commit(self, forge):
        self._discard(forge, "README.md")
        before = forge.head()

        assert forge.manager._apply_discard_list(SPEC, "main") == ["README.md"]
        assert forge.head() == before

    def test_a_path_outside_the_repository_is_skipped(self, forge):
        self._discard(forge, "../outside.txt")

        assert forge.manager._apply_discard_list(SPEC, "main") == []

    def test_a_refused_commit_is_logged(self, forge, caplog):
        commit_file(forge.worktree, "README.md", "# Changed\n", "readme")
        self._discard(forge, "README.md")
        hooks = forge.root / "hooks"
        hooks.mkdir()
        refuse = hooks / "pre-commit"
        refuse.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8", newline="\n")
        refuse.chmod(refuse.stat().st_mode | stat.S_IEXEC)
        git(forge.repo, "config", "core.hooksPath", str(hooks))

        assert forge.manager._apply_discard_list(SPEC, "main") == ["README.md"]
        assert "Commit of discarded reverts failed" in caplog.text

    def test_nothing_to_apply(self, forge):
        assert forge.manager._apply_discard_list(SPEC, "main") == []
        assert forge.manager._apply_discard_list("999-missing", "main") == []
        self._discard(forge, "# only a comment")
        assert forge.manager._apply_discard_list(SPEC, "main") == []

    def test_an_unreadable_list(self, forge):
        (forge.worktree / ".workpilot-discard-list").mkdir()

        assert forge.manager._apply_discard_list(SPEC, "main") == []


# ── push_and_create_pr ──────────────────────────────────────────────────


def disagreeing_review(forge) -> None:
    from cross_review import tree_fingerprint

    (forge.spec_dir() / "cross_review.json").write_text(
        json.dumps(
            {
                "version": 1,
                "verdict": "disagree",
                "summary": "The total is wrong.",
                "findings": [
                    {"severity": "blocker", "file": "cart.py", "issue": "returns 0"}
                ],
                "note": "",
                "provider": "codex",
                "model": "m",
                "tree": tree_fingerprint(forge.worktree),
                "at": "2026-11-14T10:00:00Z",
            }
        ),
        encoding="utf-8",
    )


class TestPushAndCreatePr:
    def test_github_end_to_end(self, forge):
        forge.gh.answer({"pr create": {"stdout": PR_URL}})
        (forge.worktree / "cart.py").write_text("def total():\n    return 3\n", "utf-8")

        result = forge.manager.push_and_create_pr(SPEC, title="Cart", body="b")

        assert result["success"] is True
        assert result["provider"] == "github"
        assert result["pr_url"] == PR_URL
        assert result["pushed"] is True
        assert forge.origin_has(f"refs/heads/{BRANCH}") == forge.head()
        assert git(forge.worktree, "log", "-1", "--format=%s").stdout.strip() == "Cart"

    def test_gitlab_end_to_end(self, forge):
        forge.remote(GITLAB_URL)
        forge.glab.answer({"mr create": {"stdout": MR_URL}})

        result = forge.manager.push_and_create_pr(SPEC, body="b")

        assert (result["provider"], result["pr_url"]) == ("gitlab", MR_URL)

    def test_azure_end_to_end(self, forge, azure):
        result = forge.manager.push_and_create_pr(SPEC, body="b")

        assert (result["provider"], result["pr_url"]) == (
            "azure_devops",
            f"{AZURE_PR}/42",
        )

    def test_an_unknown_forge_still_pushes(self, forge):
        forge.remote("https://git.example.org/acme/shop.git")

        result = forge.manager.push_and_create_pr(SPEC, body="b")

        assert result["success"] is False
        assert result["pushed"] is True
        assert result["provider"] == "unknown"
        assert result["error"].startswith("Unable to determine git hosting provider")

    def test_an_empty_branch_is_refused_before_the_push(self, forge):
        git(forge.worktree, "reset", "--hard", "main")

        result = forge.manager.push_and_create_pr(SPEC, body="b")

        assert result["success"] is False
        assert result["error"].startswith("Aucun commit à pousser")
        assert forge.origin_has(f"refs/heads/{BRANCH}") is None

    def test_a_failed_push_stops_before_the_forge(self, forge):
        write_hook(forge.bare, 'echo "denied" >&2\nexit 1\n')

        result = forge.manager.push_and_create_pr(SPEC, body="b")

        assert result["success"] is False
        assert result["pushed"] is False
        assert result["error"].startswith("Failed to push branch:")
        assert forge.gh.calls() == []

    def test_discarded_files_and_workpilot_files_stay_out(self, forge):
        commit_file(forge.worktree, "scratch.txt", "notes\n", "scratch")
        commit_file(forge.worktree, ".workpilot-status", "done\n", "status")
        (forge.worktree / ".workpilot-discard-list").write_text(
            "scratch.txt\n", encoding="utf-8"
        )
        forge.gh.answer({"pr create": {"stdout": PR_URL}})

        result = forge.manager.push_and_create_pr(SPEC, body="b")

        assert result["success"] is True
        pushed = git(forge.bare, "ls-tree", "-r", "--name-only", BRANCH).stdout.split()
        assert "cart.py" in pushed
        assert "scratch.txt" not in pushed
        assert ".workpilot-status" not in pushed

    def test_a_disagreeing_cross_review_holds_the_pr(self, forge):
        disagreeing_review(forge)

        result = forge.manager.push_and_create_pr(SPEC, body="b")

        assert result["cross_review_blocked"] is True
        assert "cart.py: returns 0" in result["error"]
        assert forge.origin_has(f"refs/heads/{BRANCH}") is None

    def test_a_person_can_override_the_cross_review(self, forge):
        disagreeing_review(forge)
        forge.gh.answer({"pr create": {"stdout": PR_URL}})

        result = forge.manager.push_and_create_pr(
            SPEC, body="b", allow_cross_review_disagreement=True
        )

        assert result["success"] is True

    def test_a_split_part_is_marked_and_labelled(self, forge):
        specs = forge.repo / ".workpilot" / "specs"
        (specs / "000-shop").mkdir(parents=True)
        (specs / "000-shop" / "task_metadata.json").write_text(
            json.dumps({"splitGroup": {"children": [SPEC]}}), encoding="utf-8"
        )
        (forge.spec_dir() / "task_metadata.json").write_text(
            json.dumps(
                {
                    "splitGroup": {
                        "parent": "000-shop",
                        "index": 1,
                        "total": 2,
                        "title": "Shop",
                        "name": "Cart",
                    }
                }
            ),
            encoding="utf-8",
        )
        forge.gh.answer(
            {
                "pr create": {"stdout": PR_URL},
                "label create": {"stdout": ""},
                "pr edit": {"stdout": ""},
            }
        )

        result = forge.manager.push_and_create_pr(SPEC, body="b")

        assert result["success"] is True
        create = forge.gh.calls()[0]
        assert create[create.index("--title") + 1] == f"[Shop 1/2] feat: {SPEC}"
        assert forge.gh.calls()[-1] == [
            "pr",
            "edit",
            PR_URL,
            "--add-label",
            "groupe/000-shop",
        ]

    def test_a_stacked_task_whose_parent_cannot_be_pushed(self, forge):
        (forge.spec_dir() / "task_metadata.json").write_text(
            json.dumps({"stackParent": "000-base", "stackTrunk": "main"}),
            encoding="utf-8",
        )

        result = forge.manager.push_and_create_pr(
            SPEC, target_branch="workpilot/000-base", body="b"
        )

        assert result["success"] is False
        assert result["pushed"] is True
        assert result["error"].startswith(
            "Could not push the stack's parent workpilot/000-base"
        )
