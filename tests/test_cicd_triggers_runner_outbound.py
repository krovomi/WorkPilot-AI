"""CI/CD Triggers runner: where a request may go, and what it may carry.

Every call goes through `outbound_refusal` first: http(s) only, a credential
over https or to this machine, and under the project's strict offline mode
only a CI server on this machine or the local network. A redirect is answered
as it came. The values that end up in a provider's API path are checked.
"""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from runners import cicd_triggers_runner as runner

TOKEN = {"Authorization": "token placeholder"}


def _policy(project: Path, text: str) -> Path:
    (project / ".workpilot").mkdir(parents=True, exist_ok=True)
    (project / ".workpilot" / "offline-mode.json").write_text(text, encoding="utf-8")
    return project


@pytest.fixture
def strict(tmp_path: Path) -> Path:
    return _policy(tmp_path, json.dumps({"airgapStrict": True}))


@pytest.mark.parametrize(
    "url",
    ["file:///etc/hosts", "ftp://ci.example.test/x", "ci.example.test/job"],
)
def test_only_http_and_https_are_called(url: str) -> None:
    assert runner.outbound_refusal(url, {}, None) == runner.SCHEME_REFUSAL


@pytest.mark.parametrize(
    "url",
    ["http://ci.example.test/job", "http://192.168.1.20:8080/job", "HTTP://ci.test/"],
)
@pytest.mark.parametrize("header", ["Authorization", "PRIVATE-TOKEN", "private-token"])
def test_a_credential_needs_https_away_from_this_machine(url: str, header: str) -> None:
    assert (
        runner.outbound_refusal(url, {header: "placeholder"}, None)
        == runner.PLAIN_HTTP_REFUSAL
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://ci.example.test/job",
        "http://127.0.0.1:8080/job",
        "http://localhost:8080/job",
        "http://[::1]:8080/job",
    ],
)
def test_a_credential_goes_over_https_or_to_this_machine(url: str) -> None:
    assert runner.outbound_refusal(url, TOKEN, None) is None


def test_plain_http_without_a_credential_is_left_alone() -> None:
    assert runner.outbound_refusal("http://ci.example.test/job", {}, None) is None


def test_strict_offline_keeps_the_calls_on_this_machine_or_network(
    strict: Path,
) -> None:
    project = str(strict)
    assert (
        runner.outbound_refusal("https://api.github.com/x", TOKEN, project)
        == runner.STRICT_OFFLINE_REFUSAL
    )
    assert runner.outbound_refusal("http://127.0.0.1:9/x", TOKEN, project) is None
    assert runner.outbound_refusal("https://10.0.0.5/x", TOKEN, project) is None


def test_a_project_without_strict_offline_reaches_its_ci(tmp_path: Path) -> None:
    _policy(tmp_path, json.dumps({"airgapStrict": False}))
    assert (
        runner.outbound_refusal("https://api.github.com/x", TOKEN, str(tmp_path))
        is None
    )


@pytest.mark.parametrize("text", ["{not json", json.dumps({"airgapStrict": "yes"})])
def test_an_unreadable_policy_counts_as_strict(tmp_path: Path, text: str) -> None:
    _policy(tmp_path, text)
    assert (
        runner.outbound_refusal("https://gitlab.com/x", TOKEN, str(tmp_path))
        == runner.UNREADABLE_POLICY_REFUSAL
    )


def test_a_refused_request_never_leaves() -> None:
    assert runner.http_request("file:///etc/hosts") == {
        "status": 0,
        "error": runner.SCHEME_REFUSAL,
    }


def test_a_refusal_reaches_the_command_output(
    strict: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    monkeypatch.setenv("CICD_GITLAB_TOKEN", "placeholder")
    monkeypatch.setenv("CICD_GITLAB_PROJECT_ID", "42")
    monkeypatch.delenv("CICD_GITLAB_HOST", raising=False)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "runner",
            "--action",
            "trigger",
            "--project",
            str(strict),
            "--provider",
            "gitlab",
        ],
    )
    with pytest.raises(SystemExit) as stop:
        runner.main()
    assert stop.value.code == 1
    out = json.loads(capsys.readouterr().out)
    assert out["error"] == runner.STRICT_OFFLINE_REFUSAL
    assert out["status_code"] == 0


@pytest.mark.parametrize("action", ["status", "cancel"])
def test_status_and_cancel_ask_for_the_projects_policy(
    strict: Path, monkeypatch: pytest.MonkeyPatch, capsys, action: str
) -> None:
    seen: list[str | None] = []

    def http_request(url, method="GET", headers=None, body=None, *, project=None):
        seen.append(project)
        return {"status": 200, "body": {}}

    monkeypatch.setattr(runner, "http_request", http_request)
    monkeypatch.setenv("CICD_GITHUB_TOKEN", "placeholder")
    monkeypatch.setenv("CICD_GITHUB_REPO", "acme/shop")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "runner",
            "--action",
            action,
            "--project",
            str(strict),
            "--provider",
            "github",
            "--run-id",
            "7",
        ],
    )
    with pytest.raises(SystemExit):
        runner.main()
    capsys.readouterr()
    assert seen == [str(strict)]


# --- redirects -------------------------------------------------------------------


class _Redirecting:
    """A server that answers every request with a redirect to another path."""

    def __init__(self) -> None:
        self.paths: list[str] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                fake.paths.append(self.path)
                self.send_response(302)
                self.send_header("Location", "/elsewhere")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *_args) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def test_a_redirect_is_answered_as_it_came(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"):
        monkeypatch.delenv(name, raising=False)
    server = _Redirecting()
    try:
        answer = runner.http_request(server.url + "/job", method="POST", headers=TOKEN)
    finally:
        server.close()
    assert answer["status"] == 302
    assert server.paths == ["/job"]


# --- values that end up in an API path ---------------------------------------------


@pytest.mark.parametrize(
    ("pr_url", "repo"),
    [
        ("https://github.com/acme/shop/pull/3", "acme/shop"),
        ("https://github.com/acme/shop", "acme/shop"),
        ("https://example.test/acme/shop/pull/3", ""),
        ("http://github.com/acme/shop/pull/3", ""),
        ("https://github.com/acme", ""),
        ("https://github.com/../shop/pull/3", ""),
        ("https://github.com/acme/sh%2Fop/pull/3", ""),
    ],
)
def test_the_repo_comes_from_a_github_pull_request_url(pr_url: str, repo: str) -> None:
    assert runner._github_repo(pr_url) == repo


@pytest.fixture
def no_call(monkeypatch: pytest.MonkeyPatch):
    def http_request(*_args, **_kwargs):
        raise AssertionError("no request expected")

    monkeypatch.setattr(runner, "http_request", http_request)


@pytest.mark.parametrize("workflow", ["../../user/repos", "deploy yml", "..", "-x/y"])
def test_a_workflow_is_a_file_name(no_call, workflow: str) -> None:
    env = {"CICD_GITHUB_TOKEN": "placeholder", "CICD_GITHUB_REPO": "acme/shop"}
    result = runner.trigger_github(env, "main", workflow)
    assert result == {
        "error": "The GitHub workflow must be a file name such as 'deploy.yml'"
    }


@pytest.mark.parametrize("run_id", ["", "5/../../user", "abc", "1" * 21])
@pytest.mark.parametrize("action", [runner.action_status, runner.action_cancel])
def test_a_run_id_is_a_number(no_call, action, run_id: str) -> None:
    env = {"CICD_GITHUB_TOKEN": "placeholder", "CICD_GITHUB_REPO": "acme/shop"}
    assert action(env, "github", run_id) == {"error": "A run id is a number"}
