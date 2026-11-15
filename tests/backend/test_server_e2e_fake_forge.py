"""The fake forges of the apps' server E2E (``tests/server_e2e/fake_forge.py``).

The relay calls the real names (``https://api.github.com``…); these tests
check that, with the environment the fake forge gives the server, the same
calls reach it over TLS, that only its two hosts are tunnelled, that what it
records of a token is a tag, and that a clone of the GitHub URL reads the
local repository.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import httpx
import pytest

from tests.server_e2e import stack
from tests.server_e2e.fake_forge import (
    GITHUB_CLONE_URL,
    GITHUB_REPO,
    GITLAB_HOST,
    GITLAB_PROJECT,
    FakeForge,
    token_tag,
)

pytestmark = pytest.mark.integration

TOKEN = "ghp_e2e_0000000000000000000000000000"  # pragma: allowlist secret


@pytest.fixture
def forge(tmp_path: Path):
    with FakeForge(tmp_path / "certs") as running:
        yield running


def _client(forge: FakeForge) -> httpx.Client:
    return httpx.Client(
        proxy=forge.url, verify=str(forge.ca_file), timeout=10, trust_env=False
    )


def test_the_relay_s_github_calls_reach_it_over_tls(forge: FakeForge) -> None:
    with _client(forge) as client:
        issues = client.get(
            f"https://api.github.com/repos/{GITHUB_REPO}/issues",
            params={"state": "open"},
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
        pulls = client.post(
            "https://api.github.com/graphql",
            json={"query": "{}"},
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
        past_the_end = client.get(
            f"https://api.github.com/repos/{GITHUB_REPO}/issues",
            params={"state": "open", "page": "2"},
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
    assert issues.status_code == 200
    assert [i["number"] for i in issues.json()] == [7, 8]
    # A later page is empty, or the app's paging would never end.
    assert past_the_end.json() == []
    nodes = pulls.json()["data"]["repository"]["pullRequests"]["nodes"]
    assert [n["number"] for n in nodes] == [12]
    calls = httpx.get(f"{forge.url}/calls", trust_env=False).json()
    assert [(c["host"], c["method"], c["path"]) for c in calls] == [
        ("api.github.com", "GET", f"/repos/{GITHUB_REPO}/issues"),
        ("api.github.com", "POST", "/graphql"),
        ("api.github.com", "GET", f"/repos/{GITHUB_REPO}/issues"),
    ]
    # What it keeps of the token says whose it was, and is not the token.
    assert {c["token"] for c in calls} == {token_tag(TOKEN)}
    assert TOKEN not in json.dumps(calls)


def test_gitlab_answers_with_its_total_and_wants_a_token(forge: FakeForge) -> None:
    path = GITLAB_PROJECT.replace("/", "%2F")
    with _client(forge) as client:
        listed = client.get(
            f"https://{GITLAB_HOST}/api/v4/projects/{path}/issues",
            headers={"PRIVATE-TOKEN": TOKEN},
        )
        anonymous = client.get(f"https://{GITLAB_HOST}/api/v4/projects/{path}/issues")
    assert listed.status_code == 200
    assert listed.headers["X-Total"] == "1"
    assert [i["iid"] for i in listed.json()] == [3]
    assert anonymous.status_code == 401


def test_only_the_two_forges_are_tunnelled(forge: FakeForge) -> None:
    with _client(forge) as client, pytest.raises(httpx.ProxyError):
        client.get("https://example.com/")
    # A plain request through the proxy is not forwarded either.
    refused = httpx.get(
        "http://example.com/", proxy=forge.url, trust_env=False, timeout=10
    )
    assert refused.status_code == 403
    assert httpx.get(f"{forge.url}/calls", trust_env=False).json() == []


def test_a_clone_of_the_github_url_reads_the_local_repository(
    forge: FakeForge, tmp_path: Path
) -> None:
    origin = stack.make_origin_repo(tmp_path / "origin")
    with stack.serve_directory(origin.parent) as served:
        env = {
            **stack.server_env("sqlite://", tmp_path / "repos"),
            **forge.env(f"{served}/origin.git"),
        }
        subprocess.run(
            ["git", "clone", "-q", GITHUB_CLONE_URL, str(tmp_path / "clone")],
            env=env,
            check=True,
            capture_output=True,
            timeout=60,
        )
    assert (tmp_path / "clone" / "app.py").is_file()
