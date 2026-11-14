"""The CI/CD triggers runner against real HTTP, as the desktop app starts it.

GitLab and Jenkins take their host from the settings, so the subprocess tests
point them at a local server and check the request the CI receives. GitHub
and Azure DevOps have fixed hosts: those tests swap `http_request` and check
the request the runner builds. The tokens are placeholders, not secrets.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from runners import cicd_triggers_runner as runner

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "cicd_triggers_runner.py"
PROXY_VARS = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy")


class FakeCi:
    """A local HTTP server: one answer per path, every request kept."""

    def __init__(self) -> None:
        self.answers: dict[str, tuple[int, str]] = {}
        self.requests: list[dict] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                path = urlsplit(self.path).path
                fake.requests.append(
                    {
                        "method": self.command,
                        "path": path,
                        "query": parse_qs(urlsplit(self.path).query),
                        "headers": {k.lower(): v for k, v in self.headers.items()},
                        "body": self.rfile.read(length).decode("utf-8"),
                    }
                )
                status, body = fake.answers.get(path, (404, "no such path"))
                payload = body.encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = _answer

            def log_message(self, *_args) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def ci(monkeypatch: pytest.MonkeyPatch):
    for name in PROXY_VARS:
        monkeypatch.delenv(name, raising=False)
    fake = FakeCi()
    yield fake
    fake.close()


def _run(project: Path, env: dict[str, str], *args: str) -> tuple[int, dict, str]:
    base = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith("CICD_") and k not in PROXY_VARS
    }
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project", str(project), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**base, "NO_PROXY": "127.0.0.1", **env},
        timeout=60,
        check=False,
    )
    out = json.loads(done.stdout) if done.stdout.strip() else {}
    return done.returncode, out, done.stderr


# --- GitLab and Jenkins, through the real command ------------------------------


def test_gitlab_starts_a_pipeline_on_the_branch(ci: FakeCi, tmp_path: Path) -> None:
    ci.answers["/api/v4/projects/42/pipeline"] = (
        201,
        json.dumps({"id": 7, "web_url": "https://gitlab.example.test/p/7"}),
    )
    env = {
        "CICD_GITLAB_HOST": ci.url,
        "CICD_GITLAB_TOKEN": "placeholder-token",
        "CICD_GITLAB_PROJECT_ID": "42",
    }
    code, out, _ = _run(
        tmp_path,
        env,
        "--action",
        "trigger",
        "--provider",
        "GitLab",
        "--branch",
        "feature/login",
    )
    assert code == 0
    assert out == {
        "provider": "gitlab",
        "status": "triggered",
        "pipeline_id": 7,
        "ref": "feature/login",
        "web_url": "https://gitlab.example.test/p/7",
    }
    [sent] = ci.requests
    assert sent["method"] == "POST"
    assert sent["headers"]["private-token"] == "placeholder-token"
    assert json.loads(sent["body"]) == {"ref": "feature/login"}


def test_gitlab_settings_can_come_from_the_project_env(
    ci: FakeCi, tmp_path: Path
) -> None:
    ci.answers["/api/v4/projects/9/pipeline"] = (200, "accepted")
    (tmp_path / ".env").write_text(
        "# CI settings\n"
        "\n"
        "not a setting\n"
        f'CICD_GITLAB_HOST="{ci.url}"\n'
        "CICD_GITLAB_TOKEN='placeholder-token'\n"
        "CICD_GITLAB_PROJECT_ID=9\n"
        "CICD_GITLAB_REF=release\n"
        "CICD_PROVIDER=gitlab_ci\n",
        encoding="utf-8",
    )
    code, out, _ = _run(tmp_path, {}, "--action", "trigger")
    assert code == 0
    # A text answer has no pipeline fields.
    assert out["ref"] == "release" and out["pipeline_id"] is None
    assert out["web_url"] is None


def test_a_refused_gitlab_pipeline_reports_the_ci_answer(
    ci: FakeCi, tmp_path: Path
) -> None:
    ci.answers["/api/v4/projects/42/pipeline"] = (403, '{"message":"forbidden"}')
    env = {
        "CICD_GITLAB_HOST": ci.url,
        "CICD_GITLAB_TOKEN": "placeholder-token",
        "CICD_GITLAB_PROJECT_ID": "42",
    }
    code, out, _ = _run(tmp_path, env, "--action", "trigger", "--provider", "gitlab")
    assert code == 1
    assert out == {
        "provider": "gitlab",
        "error": '{"message":"forbidden"}',
        "status_code": 403,
    }


@pytest.mark.parametrize(
    ("env", "message"),
    [
        ({}, "CICD_GITLAB_TOKEN not configured"),
        ({"CICD_GITLAB_TOKEN": "t"}, "CICD_GITLAB_PROJECT_ID not configured"),
    ],
)
def test_gitlab_needs_its_settings(tmp_path: Path, env: dict, message: str) -> None:
    code, out, _ = _run(tmp_path, env, "--action", "trigger", "--provider", "gitlab")
    assert code == 1 and out == {"error": message}


def test_jenkins_builds_with_the_branch_and_pr_as_parameters(
    ci: FakeCi, tmp_path: Path
) -> None:
    ci.answers["/job/web%20app/buildWithParameters"] = (201, "")
    pr = "https://github.com/acme/shop/pull/12?tab=files&x=1"
    env = {
        "CICD_JENKINS_URL": ci.url + "/",
        "CICD_JENKINS_JOB": "web app",
        "CICD_JENKINS_USER": "bot",
        "CICD_JENKINS_TOKEN": "placeholder-token",
    }
    code, out, _ = _run(
        tmp_path,
        env,
        "--action",
        "trigger",
        "--provider",
        "jenkins",
        "--branch",
        "fix/a&b",
        "--pr-url",
        pr,
    )
    assert code == 0, out
    assert out == {
        "provider": "jenkins",
        "status": "triggered",
        "job": "web app",
        "branch": "fix/a&b",
    }
    [sent] = ci.requests
    # Both values arrive whole, `&` included.
    assert sent["query"] == {"BRANCH": ["fix/a&b"], "PR_URL": [pr]}
    expected = base64.b64encode(b"bot:placeholder-token").decode()
    assert sent["headers"]["authorization"] == f"Basic {expected}"


def test_jenkins_with_a_token_alone_sends_a_bearer(ci: FakeCi, tmp_path: Path):
    ci.answers["/job/api/buildWithParameters"] = (200, "")
    env = {
        "CICD_JENKINS_URL": ci.url,
        "CICD_JENKINS_JOB": "api",
        "CICD_JENKINS_TOKEN": "placeholder-token",
    }
    code, _, _ = _run(tmp_path, env, "--action", "trigger", "--provider", "jenkins")
    assert code == 0
    [sent] = ci.requests
    assert sent["headers"]["authorization"] == "Bearer placeholder-token"
    assert sent["query"] == {"BRANCH": ["main"]}


def test_a_failed_jenkins_build_and_an_unreachable_one(
    ci: FakeCi, tmp_path: Path
) -> None:
    env = {"CICD_JENKINS_URL": ci.url, "CICD_JENKINS_JOB": "missing"}
    code, out, _ = _run(tmp_path, env, "--action", "trigger", "--provider", "jenkins")
    assert code == 1
    assert out == {"provider": "jenkins", "error": "no such path", "status_code": 404}
    assert "authorization" not in ci.requests[0]["headers"]

    ci.close()
    code, out, _ = _run(tmp_path, env, "--action", "trigger", "--provider", "jenkins")
    assert code == 1 and out["status_code"] == 0 and out["error"]


def test_jenkins_needs_its_url_and_job(tmp_path: Path) -> None:
    code, out, _ = _run(tmp_path, {}, "--action", "trigger", "--provider", "jenkins")
    assert code == 1
    assert out["error"].startswith("Jenkins config incomplete")


def test_an_unknown_provider_is_named(tmp_path: Path) -> None:
    code, out, _ = _run(tmp_path, {}, "--action", "trigger", "--provider", "drone")
    assert code == 1
    assert out["error"].startswith("Unknown CI/CD provider: drone.")


@pytest.mark.parametrize("action", ["status", "cancel"])
def test_status_and_cancel_only_exist_for_github(tmp_path: Path, action: str):
    code, out, _ = _run(
        tmp_path, {}, "--action", action, "--provider", "gitlab", "--run-id", "1"
    )
    assert code == 0
    assert out["note"].endswith("provider: gitlab")


# --- http_request against the local server ------------------------------------


def test_http_request_reads_json_text_and_http_errors(ci: FakeCi) -> None:
    ci.answers["/json"] = (200, '{"ok": true}')
    ci.answers["/text"] = (200, "plain")
    ci.answers["/bad"] = (500, "boom")
    assert runner.http_request(ci.url + "/json") == {
        "status": 200,
        "body": {"ok": True},
    }
    assert runner.http_request(ci.url + "/text") == {"status": 200, "body": "plain"}
    assert runner.http_request(ci.url + "/bad", method="POST", body=b"x") == {
        "status": 500,
        "error": "boom",
    }
    assert ci.requests[-1]["body"] == "x"


# --- GitHub Actions and Azure DevOps: the request the runner builds ------------


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch):
    calls: list[dict] = []
    answers: list[dict] = []

    def http_request(url, method="GET", headers=None, body=None):
        calls.append({"url": url, "method": method, "headers": headers, "body": body})
        return answers.pop(0)

    monkeypatch.setattr(runner, "http_request", http_request)
    return calls, answers


def test_github_dispatches_the_workflow_of_the_pr_repo(sent) -> None:
    calls, answers = sent
    answers.append({"status": 204, "body": ""})
    env = {"CICD_GITHUB_TOKEN": "placeholder-token"}
    result = runner.action_trigger(
        env,
        "GitHub",
        "feature/x",
        "deploy.yml",
        "https://github.com/acme/shop/pull/12",
    )
    assert result == {
        "provider": "github",
        "status": "triggered",
        "workflow": "deploy.yml",
        "ref": "feature/x",
        "repo": "acme/shop",
    }
    [call] = calls
    assert call["url"] == (
        "https://api.github.com/repos/acme/shop/actions/workflows/deploy.yml/dispatches"
    )
    assert call["headers"]["Authorization"] == "token placeholder-token"
    assert json.loads(call["body"]) == {
        "ref": "feature/x",
        "inputs": {
            "pr_url": "https://github.com/acme/shop/pull/12",
            "branch": "feature/x",
        },
    }


def test_github_reports_a_refused_dispatch(sent) -> None:
    _, answers = sent
    answers.append({"status": 422, "body": {"message": "no workflow_dispatch"}})
    env = {
        "CICD_GITHUB_TOKEN": "t",
        "CICD_GITHUB_REPO": "acme/shop",
        "CICD_GITHUB_WORKFLOW": "ci.yml",
    }
    result = runner.action_trigger(env, "github_actions", "", None, None)
    assert result == {
        "provider": "github",
        "error": "{'message': 'no workflow_dispatch'}",
        "status_code": 422,
    }


@pytest.mark.parametrize(
    ("env", "pr_url", "message"),
    [
        ({}, None, "CICD_GITHUB_TOKEN not configured"),
        ({"CICD_GITHUB_TOKEN": "t"}, "https://github.com/acme", "Could not determine"),
        (
            {"CICD_GITHUB_TOKEN": "t", "CICD_GITHUB_REPO": "a/b"},
            None,
            "CICD_GITHUB_WORKFLOW",
        ),
    ],
)
def test_github_needs_a_token_a_repo_and_a_workflow(env, pr_url, message) -> None:
    result = runner.action_trigger(env, "github", "main", None, pr_url)
    assert result["error"].startswith(message)


def test_github_run_status_and_cancel(sent) -> None:
    calls, answers = sent
    env = {"CICD_GITHUB_TOKEN": "placeholder-token", "CICD_GITHUB_REPO": "acme/shop"}
    answers.append(
        {
            "status": 200,
            "body": {
                "status": "completed",
                "conclusion": "success",
                "html_url": "https://github.com/acme/shop/actions/runs/5",
            },
        }
    )
    # The alias the trigger accepts reads the same token.
    assert runner.action_status(env, "github_actions", "5") == {
        "run_id": "5",
        "status": "completed",
        "conclusion": "success",
        "url": "https://github.com/acme/shop/actions/runs/5",
    }
    answers.append({"status": 404, "error": "Not Found"})
    assert runner.action_status(env, "github", "6") == {"error": "Not Found"}
    answers.append({"status": 202, "body": ""})
    assert runner.action_cancel(env, "github_actions", "5") == {"cancelled": True}
    answers.append({"status": 409, "error": "done already"})
    assert runner.action_cancel(env, "github", "5") == {"cancelled": False}
    assert [c["url"].rsplit("/", 2)[-2:] for c in calls] == [
        ["runs", "5"],
        ["runs", "6"],
        ["5", "cancel"],
        ["5", "cancel"],
    ]
    assert calls[2]["method"] == "POST"


@pytest.mark.parametrize("action", [runner.action_status, runner.action_cancel])
def test_github_status_and_cancel_need_the_repo_and_token(action) -> None:
    assert action({}, "github", "5") == {
        "error": "Missing CICD_GITHUB_REPO or CICD_GITHUB_TOKEN"
    }


AZURE = {
    "CICD_AZURE_TOKEN": "placeholder-token",
    "CICD_AZURE_ORG": "acme",
    "CICD_AZURE_PROJECT": "shop",
    "CICD_AZURE_PIPELINE_ID": "3",
}


def test_azure_runs_the_pipeline_on_the_branch(sent) -> None:
    calls, answers = sent
    answers.append(
        {
            "status": 200,
            "body": {
                "id": 88,
                "_links": {"web": {"href": "https://dev.azure.com/r/88"}},
            },
        }
    )
    result = runner.action_trigger(AZURE, "azure_devops", "hotfix", None, None)
    assert result == {
        "provider": "azure",
        "status": "triggered",
        "run_id": 88,
        "pipeline_id": "3",
        "web_url": "https://dev.azure.com/r/88",
    }
    [call] = calls
    assert call["url"] == (
        "https://dev.azure.com/acme/shop/_apis/pipelines/3/runs?api-version=7.0"
    )
    expected = base64.b64encode(b":placeholder-token").decode()
    assert call["headers"]["Authorization"] == f"Basic {expected}"
    assert json.loads(call["body"]) == {
        "resources": {"repositories": {"self": {"refName": "refs/heads/hotfix"}}}
    }


def test_azure_text_answers_and_refusals(sent) -> None:
    _, answers = sent
    answers.append({"status": 201, "body": "queued"})
    result = runner.action_trigger(AZURE, "azuredevops", "", None, None)
    assert result["run_id"] is None and result["web_url"] is None
    answers.append({"status": 401, "error": "unauthorized"})
    assert runner.action_trigger(AZURE, "azure", "", None, None) == {
        "provider": "azure",
        "error": "unauthorized",
        "status_code": 401,
    }
    assert runner.action_trigger({}, "azure", "", None, None)["error"].startswith(
        "Azure DevOps config incomplete"
    )


def test_an_unexpected_answer_ends_with_an_error_on_stderr(
    sent, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    _, answers = sent
    answers.append({"status": 200, "body": "not a run"})
    monkeypatch.setenv("CICD_GITHUB_TOKEN", "t")
    monkeypatch.setenv("CICD_GITHUB_REPO", "acme/shop")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "runner",
            "--action",
            "status",
            "--project",
            str(tmp_path),
            "--provider",
            "github",
            "--run-id",
            "5",
        ],
    )
    with pytest.raises(SystemExit) as stop:
        runner.main()
    assert stop.value.code == 1
    err = json.loads(capsys.readouterr().err)
    assert "has no attribute 'get'" in err["error"]
