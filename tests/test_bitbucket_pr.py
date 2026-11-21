"""Bitbucket Cloud pull requests from a task's worktree (`core/bitbucket_pr.py`).

The repository comes from the pushed remote (or the project's settings), the
credentials only from the process environment; the REST API is the only host
called, the token stays in the Authorization header and never reaches a
message. `push_and_create_pr` routes a bitbucket.org remote here.
"""

from __future__ import annotations

import base64
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import core.bitbucket_pr as bitbucket_pr
import pytest
import requests
from core.bitbucket_pr import (
    auth_headers,
    create_bitbucket_pull_request,
    existing_bitbucket_pr_url,
    find_open_pull_request,
    repo_from_remote,
    repo_from_settings,
    resolve_repo,
)
from foundation.git_provider import _classify_hostname

TOKEN = "bb-test-0000"  # pragma: allowlist secret
API = "https://api.bitbucket.org/2.0/repositories/acme/web"


def _response(status: int, body: object | None = None, reason: str = "") -> MagicMock:
    resp = MagicMock(status_code=status, reason=reason)
    if isinstance(body, Exception):
        resp.json.side_effect = body
    else:
        resp.json.return_value = body if body is not None else {}
    return resp


class _Manager:
    """The part of `WorktreeManager` the module uses."""

    def __init__(
        self, project_dir: Path, branch: str | None = "workpilot/001-login"
    ) -> None:
        self.project_dir = project_dir
        self.base_branch = "develop"
        self._branch = branch
        self.ai_body: str | None = "AI body"
        self.context_error: Exception | None = None

    def get_worktree_info(self, spec_name: str):
        return SimpleNamespace(branch=self._branch) if self._branch else None

    def _gather_pr_context(self, spec_name: str, target: str) -> tuple[str, str]:
        if self.context_error:
            raise self.context_error
        return "diff", "log"

    def _try_ai_pr_body(self, **_kwargs) -> str | None:
        return self.ai_body

    def _extract_spec_summary(self, spec_name: str) -> str:
        return "Spec summary"

    def _inject_impact_block(
        self, *, spec_name: str, body: str, diff_summary: str, commit_log: str
    ) -> str:
        return f"{body}\n\nimpact"


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BITBUCKET_TOKEN", TOKEN)
    monkeypatch.setenv("BITBUCKET_USERNAME", "dev@example.com")
    for key in ("BITBUCKET_WORKSPACE", "BITBUCKET_REPO"):
        monkeypatch.delenv(key, raising=False)


@pytest.fixture
def remote(monkeypatch: pytest.MonkeyPatch):
    """The `git remote get-url` answer."""
    answer = SimpleNamespace(returncode=0, stdout="git@bitbucket.org:acme/web.git\n")
    monkeypatch.setattr(bitbucket_pr, "run_git", lambda *_a, **_k: answer)
    return answer


class TestDetection:
    @pytest.mark.parametrize(
        "host", ["bitbucket.org", "altssh.bitbucket.org", "git@bitbucket.org"]
    )
    def test_bitbucket_hosts(self, host: str) -> None:
        assert _classify_hostname(host) == "bitbucket"

    @pytest.mark.parametrize(
        "host", ["bitbucket.org.evil.example", "notbitbucket.org", "bitbucket.com"]
    )
    def test_spoofed_hosts(self, host: str) -> None:
        assert _classify_hostname(host) != "bitbucket"

    @pytest.mark.parametrize(
        "url",
        [
            "https://bitbucket.org/acme/web.git",
            "https://dev@bitbucket.org/acme/web",
            "git@bitbucket.org:acme/web.git",
            "ssh://git@altssh.bitbucket.org:443/acme/web.git",
            "https://bitbucket.org/acme/web/?x=1",
        ],
    )
    def test_repo_from_remote(self, url: str) -> None:
        assert repo_from_remote(url) == ("acme", "web")

    @pytest.mark.parametrize(
        "url",
        [
            "https://bitbucket.org.evil.example/acme/web",
            "https://evil.example/bitbucket.org/acme/web",
            "https://bitbucket.org/acme",
            "https://bitbucket.org/acme/../web",
            "https://bitbucket.org/acme/..",
            "https://bitbucket.org/acme/web/src",
            "not a url",
        ],
    )
    def test_repo_from_remote_refuses(self, url: str) -> None:
        assert repo_from_remote(url) is None

    def test_repo_from_settings(self) -> None:
        assert repo_from_settings("acme", "web") == ("acme", "web")
        assert repo_from_settings("", "acme/web.git") == ("acme", "web")
        assert repo_from_settings("x", "https://bitbucket.org/acme/web.git") == (
            "acme",
            "web",
        )
        assert repo_from_settings("acme", "a/b/c") is None
        assert repo_from_settings("", "web") is None
        assert repo_from_settings("-x", "web") is None


class TestCredentials:
    def test_basic_with_a_username(self) -> None:
        headers = auth_headers({"BITBUCKET_TOKEN": TOKEN, "BITBUCKET_USERNAME": "dev"})
        assert headers is not None
        expected = base64.b64encode(f"dev:{TOKEN}".encode()).decode()
        assert headers["Authorization"] == f"Basic {expected}"

    def test_bearer_without(self) -> None:
        assert auth_headers({"BITBUCKET_TOKEN": f" {TOKEN}\n"}) == {
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/json",
        }

    @pytest.mark.parametrize("token", ["", "\x01\x02", "x" * 2000])
    def test_none_without_a_usable_token(self, token: str) -> None:
        assert auth_headers({"BITBUCKET_TOKEN": token}) is None

    def test_reads_the_process_environment(self, env: None) -> None:
        assert auth_headers() is not None


class TestResolveRepo:
    def test_from_the_remote(self, tmp_path: Path, remote: SimpleNamespace) -> None:
        assert resolve_repo(tmp_path, "origin") == ("acme", "web")

    def test_falls_back_to_the_settings(
        self, tmp_path: Path, remote: SimpleNamespace
    ) -> None:
        remote.returncode = 1
        env = {"BITBUCKET_WORKSPACE": "team", "BITBUCKET_REPO": "api"}
        assert resolve_repo(tmp_path, env=env) == ("team", "api")
        remote.returncode = 0
        remote.stdout = "https://github.com/acme/web.git"
        assert resolve_repo(tmp_path, env={}) is None


class TestCreate:
    def _post(
        self, monkeypatch: pytest.MonkeyPatch, get: MagicMock, post: MagicMock
    ) -> None:
        monkeypatch.setattr(requests, "get", get)
        monkeypatch.setattr(requests, "post", post)

    def test_creates_the_pull_request(
        self,
        tmp_path: Path,
        env: None,
        remote: SimpleNamespace,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        get = MagicMock(return_value=_response(200, {"values": []}))
        post = MagicMock(
            return_value=_response(
                201,
                {
                    "links": {
                        "html": {
                            "href": "https://bitbucket.org/acme/web/pull-requests/7"
                        }
                    }
                },
            )
        )
        self._post(monkeypatch, get, post)
        manager = _Manager(tmp_path)
        result = create_bitbucket_pull_request(
            manager, "001-login", None, "Add login", True, None, "\n\ngroup"
        )
        assert result == {
            "success": True,
            "pr_url": "https://bitbucket.org/acme/web/pull-requests/7",
            "already_exists": False,
        }
        url = post.call_args.args[0]
        assert url == f"{API}/pullrequests"
        payload = post.call_args.kwargs["json"]
        assert payload["source"] == {"branch": {"name": "workpilot/001-login"}}
        assert payload["destination"] == {"branch": {"name": "develop"}}
        assert payload["draft"] is True
        assert payload["description"].startswith("AI body\n\nimpact")
        assert "group" in payload["description"]
        assert post.call_args.kwargs["allow_redirects"] is False
        assert TOKEN not in url
        query = get.call_args.kwargs["params"]["q"]
        assert 'source.branch.name="workpilot/001-login"' in query

    def test_uses_the_callers_body_and_the_spec_summary_fallback(
        self,
        tmp_path: Path,
        env: None,
        remote: SimpleNamespace,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        post = MagicMock(return_value=_response(201, {}))
        self._post(monkeypatch, MagicMock(return_value=_response(500)), post)
        manager = _Manager(tmp_path)
        result = create_bitbucket_pull_request(
            manager, "001-login", "main", None, False, "Mine"
        )
        assert result["pr_url"] is None
        assert post.call_args.kwargs["json"]["description"] == "Mine"
        assert post.call_args.kwargs["json"]["title"] == "feat: 001-login"

        manager.ai_body = None
        manager.context_error = RuntimeError("no git")
        create_bitbucket_pull_request(manager, "001-login")
        assert post.call_args.kwargs["json"]["description"] == "Spec summary\n\nimpact"

    def test_answers_the_open_pull_request(
        self,
        tmp_path: Path,
        env: None,
        remote: SimpleNamespace,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        existing = {
            "values": [
                {
                    "links": {
                        "html": {
                            "href": "https://bitbucket.org/acme/web/pull-requests/3"
                        }
                    }
                }
            ]
        }
        post = MagicMock()
        self._post(monkeypatch, MagicMock(return_value=_response(200, existing)), post)
        result = create_bitbucket_pull_request(_Manager(tmp_path), "001-login")
        assert result == {
            "success": True,
            "pr_url": "https://bitbucket.org/acme/web/pull-requests/3",
            "already_exists": True,
        }
        post.assert_not_called()

    @pytest.mark.parametrize(
        ("status", "body", "message"),
        [
            (401, {}, "refused the credentials (HTTP 401)"),
            (
                400,
                {"error": {"message": "branch not found"}},
                "HTTP 400): branch not found",
            ),
            (500, ValueError("not json"), "HTTP 500): Server Error"),
        ],
    )
    def test_says_why_it_failed_without_the_token(
        self,
        tmp_path: Path,
        env: None,
        remote: SimpleNamespace,
        monkeypatch: pytest.MonkeyPatch,
        status: int,
        body: object,
        message: str,
    ) -> None:
        self._post(
            monkeypatch,
            MagicMock(return_value=_response(200, {"values": []})),
            MagicMock(return_value=_response(status, body, reason="Server Error")),
        )
        result = create_bitbucket_pull_request(_Manager(tmp_path), "001-login")
        assert result["success"] is False
        assert message in result["error"]
        assert TOKEN not in result["error"]

    def test_network_failure(
        self,
        tmp_path: Path,
        env: None,
        remote: SimpleNamespace,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        self._post(
            monkeypatch,
            MagicMock(side_effect=requests.ConnectionError(TOKEN)),
            MagicMock(),
        )
        result = create_bitbucket_pull_request(_Manager(tmp_path), "001-login")
        assert result == {"success": False, "error": "Bitbucket API unreachable"}

    def test_refusals_before_any_request(
        self,
        tmp_path: Path,
        env: None,
        remote: SimpleNamespace,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        get = MagicMock()
        self._post(monkeypatch, get, MagicMock())
        assert (
            "No worktree"
            in create_bitbucket_pull_request(_Manager(tmp_path, None), "x")["error"]
        )
        bad = _Manager(tmp_path, 'evil" OR state="MERGED')
        assert "Invalid branch" in create_bitbucket_pull_request(bad, "x")["error"]
        remote.stdout = "https://github.com/acme/web.git"
        assert (
            "workspace and repository"
            in create_bitbucket_pull_request(_Manager(tmp_path), "x")["error"]
        )
        remote.stdout = "git@bitbucket.org:acme/web.git"
        monkeypatch.delenv("BITBUCKET_TOKEN")
        assert (
            "No Bitbucket credentials"
            in create_bitbucket_pull_request(_Manager(tmp_path), "x")["error"]
        )
        get.assert_not_called()


class TestExisting:
    def test_finds_it_or_answers_none(
        self,
        tmp_path: Path,
        env: None,
        remote: SimpleNamespace,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        href = "https://bitbucket.org/acme/web/pull-requests/3"
        get = MagicMock(
            return_value=_response(
                200, {"values": [{"links": {"html": {"href": href}}}]}
            )
        )
        monkeypatch.setattr(requests, "get", get)
        assert existing_bitbucket_pr_url(_Manager(tmp_path), "001-login") == href
        assert existing_bitbucket_pr_url(_Manager(tmp_path, None), "001-login") is None
        assert existing_bitbucket_pr_url(_Manager(tmp_path, 'a"b'), "001-login") is None
        get.side_effect = requests.Timeout()
        assert existing_bitbucket_pr_url(_Manager(tmp_path), "001-login") is None

    def test_a_foreign_link_is_not_kept(self, monkeypatch: pytest.MonkeyPatch) -> None:
        answer = {
            "values": [{"links": {"html": {"href": "https://evil.example/pr/1"}}}]
        }
        monkeypatch.setattr(
            requests, "get", MagicMock(return_value=_response(200, answer))
        )
        assert find_open_pull_request("acme", "web", "a", "b", {}) is None
        monkeypatch.setattr(requests, "get", MagicMock(return_value=_response(404)))
        assert find_open_pull_request("acme", "web", "a", "b", {}) is None


class TestRouting:
    def test_push_and_create_pr_routes_bitbucket(
        self, worktree_manager, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import core.worktree_pr as worktree_module

        result_pr = {
            "success": True,
            "pr_url": "https://bitbucket.org/acme/web/pull-requests/1",
        }
        calls: list[tuple] = []

        def fake_create(manager, *args, **kwargs):
            calls.append((args, kwargs))
            return result_pr

        monkeypatch.setattr(bitbucket_pr, "create_bitbucket_pull_request", fake_create)
        with (
            patch.object(
                worktree_manager,
                "push_branch",
                return_value={
                    "success": True,
                    "remote": "origin",
                    "branch": "workpilot/x",
                },
            ),
            patch.object(
                worktree_module, "detect_git_provider", return_value="bitbucket"
            ),
        ):
            result = worktree_manager.push_and_create_pr(
                spec_name="x", target_branch="main", title="T"
            )
        assert result["provider"] == "bitbucket"
        assert result["pr_url"] == result_pr["pr_url"]
        assert calls == [(("x", "main", "T", False, None), {"remote": "origin"})]

    def test_a_split_part_keeps_its_marks_but_gets_no_label(
        self, worktree_manager, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import core.pr_group as pr_group
        import core.worktree_pr as worktree_module

        class Marks:
            group = "g"
            section = "## Group"

            def title(self, title: str) -> str:
                return f"[g] {title}"

        calls: list[tuple] = []
        labels: list[tuple] = []
        monkeypatch.setattr(pr_group, "decoration_for", lambda _d: Marks())
        monkeypatch.setattr(pr_group, "apply_group_label", lambda *a: labels.append(a))
        monkeypatch.setattr(
            bitbucket_pr,
            "create_bitbucket_pull_request",
            lambda _m, *a, **k: (
                calls.append((a, k)) or {"success": True, "pr_url": "u"}
            ),
        )
        with (
            patch.object(
                worktree_manager,
                "push_branch",
                return_value={"success": True, "remote": "origin", "branch": "b"},
            ),
            patch.object(
                worktree_module, "detect_git_provider", return_value="bitbucket"
            ),
        ):
            result = worktree_manager.push_and_create_pr(
                spec_name="x", target_branch="main", title="T"
            )
        assert result["success"] is True
        assert calls == [
            (
                ("x", "main", "[g] T", False, None),
                {"remote": "origin", "body_suffix": "## Group"},
            )
        ]
        assert labels == []

    def test_a_split_part_on_github_still_gets_its_label(
        self, worktree_manager, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import core.pr_group as pr_group
        import core.worktree_pr as worktree_module

        class Marks:
            group = "g"
            section = "## Group"

            def title(self, title: str) -> str:
                return title

        labels: list[tuple] = []
        monkeypatch.setattr(pr_group, "decoration_for", lambda _d: Marks())
        monkeypatch.setattr(pr_group, "apply_group_label", lambda *a: labels.append(a))
        with (
            patch.object(
                worktree_manager,
                "push_branch",
                return_value={"success": True, "remote": "origin", "branch": "b"},
            ),
            patch.object(
                worktree_manager,
                "create_pull_request",
                return_value={"success": True, "pr_url": "gh-url"},
            ),
            patch.object(worktree_module, "detect_git_provider", return_value="github"),
        ):
            worktree_manager.push_and_create_pr(spec_name="x", target_branch="main")
        assert [(a[0], a[3], a[4]) for a in labels] == [("github", "gh-url", "g")]

    def test_find_existing_pr_url_still_defaults_to_github(
        self, worktree_manager
    ) -> None:
        import core.worktree_pr as worktree_module

        with (
            patch.object(worktree_module, "detect_git_provider", return_value="github"),
            patch.object(
                worktree_manager, "_get_existing_pr_url", return_value="gh-url"
            ),
        ):
            assert worktree_manager.find_existing_pr_url("x") == "gh-url"

    def test_find_existing_pr_url_routes_bitbucket(
        self, worktree_manager, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import core.worktree_pr as worktree_module

        monkeypatch.setattr(
            bitbucket_pr,
            "existing_bitbucket_pr_url",
            lambda *_a: "https://bitbucket.org/a/b/pull-requests/2",
        )
        with patch.object(
            worktree_module, "detect_git_provider", return_value="bitbucket"
        ):
            assert (
                worktree_manager.find_existing_pr_url("x")
                == "https://bitbucket.org/a/b/pull-requests/2"
            )
