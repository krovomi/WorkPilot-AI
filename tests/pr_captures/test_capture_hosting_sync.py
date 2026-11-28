"""The captures section written into the pull request on each forge."""

from __future__ import annotations

import io
import json
import subprocess
from pathlib import Path

import pytest
from core.capture_hosting import load_sync, sync_pr_captures
from core.capture_hosting.forges import AZURE_MAX_DESCRIPTION, body_for
from core.capture_hosting.refs import parse_pr_url
from PIL import Image
from pr_captures.section import START

GITHUB_PR = "https://github.com/acme/shop/pull/7"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def project(tmp_path: Path) -> Path:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True)
    work = tmp_path / "project"
    work.mkdir()
    _git(work, "init", "-q", "-b", "main")
    _git(work, "remote", "add", "origin", str(remote))
    return work


def _png(path: Path, colour=(10, 20, 30)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), colour).save(buffer, format="PNG")
    path.write_bytes(buffer.getvalue())


def _spec(project: Path, *, needed=True, protect=True) -> Path:
    spec = project / ".workpilot" / "specs" / "001-x"
    after = "captures/published/task/web--orders.png"
    before = "captures/published/base/web--orders.png"
    _png(spec / after)
    _png(spec / before, (40, 50, 60))
    item = {
        "key": "web|orders|",
        "label": "orders",
        "platform": "web",
        "variant": "",
        "route": "orders",
        "before": {"file": before, "signature": "b", "publishable": True},
        "after": {"file": after, "signature": "a", "publishable": True},
        "publishable": True,
    }
    payload = {
        "version": 1,
        "decision": {"needed": needed},
        "settings": {"publish": "auto", "protect": protect},
        "items": [item] if needed else [],
        "publishable": 1 if needed else 0,
        "withheld": 0,
    }
    (spec / "captures" / "publication.json").write_text(
        json.dumps(payload), encoding="utf-8"
    )
    return spec


class FakeGh:
    """`gh api` / `glab api` as the sync calls them: one JSON resource."""

    def __init__(self, field="body", body="## Summary\n"):
        self.field = field
        self.body = body
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str], cwd: Path) -> tuple[int, str]:
        self.calls.append(args)
        if "--input" in args:
            sent = json.loads(
                Path(args[args.index("--input") + 1]).read_text(encoding="utf-8")
            )
            self.body = sent[self.field]
            return 0, "{}"
        return 0, json.dumps({self.field: self.body})


def _sync(project: Path, spec: Path, **kwargs):
    options = {
        "project_dir": project,
        "spec_dir": spec,
        "spec_name": "001-x",
        "provider": "github",
        "pr_url": GITHUB_PR,
        "gh": "gh",
    }
    options.update(kwargs)
    return sync_pr_captures(**options)


def test_each_forge_s_pull_request_url_is_read():
    github = parse_pr_url("github", GITHUB_PR)
    assert (github.owner, github.repo, github.number) == ("acme", "shop", 7)
    assert github.image_url("workpilot-captures", "k/after/a b.png") == (
        "https://github.com/acme/shop/blob/workpilot-captures/k/after/a%20b.png?raw=1"
    )
    gitlab = parse_pr_url(
        "gitlab", "https://gitlab.example.com/g/sub/app/-/merge_requests/3"
    )
    assert (gitlab.owner, gitlab.repo, gitlab.number) == ("g/sub", "app", 3)
    assert (
        gitlab.image_url("b", "p.png")
        == "https://gitlab.example.com/g/sub/app/-/raw/b/p.png"
    )
    bitbucket = parse_pr_url(
        "bitbucket", "https://bitbucket.org/ws/app/pull-requests/9"
    )
    assert (
        bitbucket.image_url("b", "p.png") == "https://bitbucket.org/ws/app/raw/b/p.png"
    )
    azure = parse_pr_url(
        "azure_devops", "https://dev.azure.com/org/My%20Proj/_git/app/pullrequest/42"
    )
    assert (azure.owner, azure.repo, azure.number) == ("org/My%20Proj", "app", 42)
    for refused in (
        ("github", "http://github.com/acme/shop/pull/7"),
        ("github", "https://user@github.com/acme/shop/pull/7"),
        ("github", "https://github.com/acme/shop/issues/7"),
        ("github", "https://github.com/acme/../pull/7"),
        ("bitbucket", "https://evil.example/ws/app/pull-requests/9"),
        ("azure_devops", "https://dev.azure.com/org/p/_git/app/pullrequest/x"),
        ("unknown", GITHUB_PR),
        ("github", None),
    ):
        assert parse_pr_url(*refused) is None, refused


def test_github_gets_the_images_on_the_branch_and_the_section_in_the_body(project):
    spec = _spec(project)
    gh = FakeGh()
    result = _sync(project, spec, run=gh)
    assert result["status"] == "published" and result["hosted"] == 2
    assert gh.body.startswith("## Summary")
    assert gh.body.count(START) == 1
    assert (
        "https://github.com/acme/shop/blob/workpilot-captures/001-x-pr7/after/"
        in gh.body
    )
    assert "/before/" in gh.body
    files = _git(
        project.parent / "remote.git",
        "ls-tree",
        "-r",
        "--name-only",
        "workpilot-captures",
    )
    assert "001-x-pr7/after/" in files
    assert load_sync(spec)["section"] is True
    # A second sync updates the section in place.
    _sync(project, spec, run=gh)
    assert gh.body.count(START) == 1


def test_gitlab_writes_the_description_through_glab(project):
    spec = _spec(project)
    glab = FakeGh(field="description", body="MR")
    result = _sync(
        project,
        spec,
        provider="gitlab",
        pr_url="https://gitlab.com/g/app/-/merge_requests/3",
        gh=None,
        glab="glab",
        run=glab,
    )
    assert result["status"] == "published"
    assert "https://gitlab.com/g/app/-/raw/workpilot-captures/001-x-pr3/" in glab.body
    write = next(call for call in glab.calls if "--input" in call)
    assert write[:4] == ["glab", "api", "--method", "PUT"]
    assert "projects/g%2Fapp/merge_requests/3" in write


def test_a_team_that_turned_publishing_off_or_reviews_first(project, monkeypatch):
    spec = _spec(project)
    gh = FakeGh()
    _sync(project, spec, run=gh)
    assert START in gh.body
    monkeypatch.setenv("CAPTURES_PUBLISH", "review")
    waiting = _sync(project, spec, run=gh)
    assert waiting["status"] == "waiting-review"
    assert START not in gh.body  # the earlier section and images are withdrawn
    files = _git(
        project.parent / "remote.git",
        "ls-tree",
        "-r",
        "--name-only",
        "workpilot-captures",
    )
    assert "001-x-pr7/" not in files
    from pr_captures.approval import approve

    approve(spec)
    assert _sync(project, spec, run=gh)["status"] == "published"
    monkeypatch.setenv("CAPTURES_PUBLISH", "never")
    assert _sync(project, spec, run=gh)["status"] == "off"
    assert START not in gh.body


def test_nothing_to_show_makes_no_call_to_the_forge(project):
    spec = _spec(project, needed=False)
    gh = FakeGh()
    result = _sync(project, spec, run=gh)
    assert result["status"] == "nothing" and gh.calls == []


def test_a_copy_outside_the_published_folder_is_never_sent(project, tmp_path):
    spec = _spec(project)
    publication = json.loads(
        (spec / "captures" / "publication.json").read_text(encoding="utf-8")
    )
    secret = tmp_path / "secret.png"
    _png(secret)
    publication["items"][0]["after"]["file"] = "../../../../secret.png"
    publication["items"][0]["before"]["file"] = "captures/task/web--orders.png"
    _png(spec / "captures" / "task" / "web--orders.png")
    (spec / "captures" / "publication.json").write_text(
        json.dumps(publication), encoding="utf-8"
    )
    gh = FakeGh()
    result = _sync(project, spec, run=gh)
    assert result["hosted"] == 0 and gh.calls == []


def test_without_credentials_or_with_an_odd_url_nothing_happens(project):
    spec = _spec(project)
    assert _sync(project, spec, gh=None)["reason"] == "no-credentials"
    assert (
        _sync(project, spec, pr_url="https://github.com/a")["status"] == "unsupported"
    )
    unreadable = _sync(project, spec, run=lambda args, cwd: (1, ""))
    assert unreadable["reason"] == "pr-unreadable"


class FakeResponse:
    def __init__(self, status: int, data: object = None):
        self.status_code = status
        self._data = data

    def json(self):
        return self._data


class FakeAzure:
    def __init__(self):
        self.description = "PR"
        self.attachments: dict[str, bytes] = {
            "wp-capture-old-after-x.png": b"",
            "keep.pdf": b"",
        }
        self.redirects: list[bool] = []

    def request(self, method, url, **kwargs):
        self.redirects.append(kwargs.get("allow_redirects"))
        if method == "GET":
            return FakeResponse(200, {"description": self.description})
        self.description = kwargs["json"]["description"]
        return FakeResponse(200, {})

    def get(self, url, **kwargs):
        self.redirects.append(kwargs.get("allow_redirects"))
        rows = [{"displayName": name} for name in self.attachments]
        return FakeResponse(200, {"value": rows})

    def post(self, url, data=None, **kwargs):
        name = url.split("/attachments/")[1].split("?")[0]
        self.attachments[name] = data
        return FakeResponse(201, {"url": f"https://dev.azure.com/org/p/att/{name}"})

    def delete(self, url, **kwargs):
        name = url.split("/attachments/")[1].split("?")[0]
        self.attachments.pop(name, None)
        return FakeResponse(204)


def test_azure_devops_gets_attachments_and_a_bounded_description(project):
    spec = _spec(project)
    azure = FakeAzure()
    result = _sync(
        project,
        spec,
        provider="azure_devops",
        pr_url="https://dev.azure.com/org/p/_git/app/pullrequest/42",
        gh=None,
        azure_auth=("", "pat"),
        session=azure,
    )
    assert result["status"] == "published" and result["hosted"] == 2
    assert "https://dev.azure.com/org/p/att/wp-capture-" in azure.description
    assert "wp-capture-old-after-x.png" not in azure.attachments  # our stale one
    assert "keep.pdf" in azure.attachments  # someone else's
    assert all(flag is False for flag in azure.redirects)
    assert len(azure.description) <= AZURE_MAX_DESCRIPTION
    assert (
        body_for(
            parse_pr_url(
                "azure_devops", "https://dev.azure.com/org/p/_git/app/pullrequest/42"
            ),
            project,
            azure_auth=("", "pat"),
            session=azure,
        ).max_chars
        == AZURE_MAX_DESCRIPTION
    )


class FakeBitbucket:
    def __init__(self):
        self.sent: dict = {}

    def request(self, method, url, **kwargs):
        if method == "GET":
            return FakeResponse(200, {"title": "feat: x", "description": "Body"})
        self.sent = kwargs["json"]
        return FakeResponse(200, {})


def test_bitbucket_keeps_the_title_when_it_writes_the_description(project):
    spec = _spec(project)
    bitbucket = FakeBitbucket()
    result = _sync(
        project,
        spec,
        provider="bitbucket",
        pr_url="https://bitbucket.org/ws/app/pull-requests/9",
        gh=None,
        bitbucket_headers={"Authorization": "Bearer t"},
        session=bitbucket,
    )
    assert result["status"] == "published"
    assert bitbucket.sent["title"] == "feat: x"
    assert (
        "https://bitbucket.org/ws/app/raw/workpilot-captures/001-x-pr9/"
        in (bitbucket.sent["description"])
    )


def test_a_refused_branch_push_leaves_the_body_alone(project):
    spec = _spec(project)
    _git(project, "remote", "set-url", "origin", str(project.parent / "missing.git"))
    gh = FakeGh()
    result = _sync(project, spec, run=gh)
    assert (result["status"], result["reason"]) == ("failed", "remote-unreachable")
    assert gh.body == "## Summary\n"


def test_the_pull_request_creation_syncs_once_the_pr_exists(
    worktree_manager, monkeypatch
):
    from unittest.mock import patch

    import core.capture_hosting as hosting
    import core.worktree_pr as worktree_module

    seen: list[tuple] = []
    monkeypatch.setattr(
        hosting, "sync_after_pr", lambda *args: seen.append(args[1:]) or {}
    )
    created = {"success": True, "pr_url": GITHUB_PR}
    with (
        patch.object(
            worktree_manager,
            "push_branch",
            return_value={"success": True, "remote": "origin", "branch": "b"},
        ),
        patch.object(worktree_module, "detect_git_provider", return_value="github"),
        patch.object(worktree_manager, "create_pull_request", return_value=created),
        patch.object(worktree_manager, "_count_commits_ahead", return_value=1),
    ):
        result = worktree_manager.push_and_create_pr(spec_name="x", title="T")
    assert result["pr_url"] == GITHUB_PR
    assert seen == [("x", "github", GITHUB_PR, "origin")]
    seen.clear()
    with (
        patch.object(
            worktree_manager,
            "push_branch",
            return_value={"success": True, "remote": "origin", "branch": "b"},
        ),
        patch.object(worktree_module, "detect_git_provider", return_value="github"),
        patch.object(
            worktree_manager,
            "create_pull_request",
            return_value={"success": False, "error": "no"},
        ),
        patch.object(worktree_manager, "_count_commits_ahead", return_value=1),
    ):
        worktree_manager.push_and_create_pr(spec_name="x", title="T")
    assert seen == []


def test_the_runner_names_no_pull_request_itself(tmp_path, monkeypatch, capsys):
    import runners.pr_captures_runner as runner

    assert (
        runner.main(["sync", "--project-dir", str(tmp_path), "--spec-name", "../x"])
        == 1
    )
    assert "invalid spec name" in capsys.readouterr().out
    code = runner.main(
        [
            "sync",
            "--project-dir",
            str(tmp_path),
            "--spec-name",
            "001-x",
            "--target-branch",
            "../main",
        ]
    )
    assert code == 1 and "invalid target branch" in capsys.readouterr().out
    import core.worktree as worktree

    monkeypatch.setattr(
        worktree.WorktreeManager, "find_existing_pr_url", lambda self, *a: None
    )
    monkeypatch.setattr(
        worktree.WorktreeManager, "_detect_base_branch", lambda self: "main"
    )
    assert (
        runner.main(
            ["sync", "--project-dir", str(tmp_path / "gone"), "--spec-name", "x"]
        )
        == 1
    )
    capsys.readouterr()
    assert (
        runner.main(["approve", "--project-dir", str(tmp_path), "--spec-name", "001-x"])
        == 0
    )
    assert json.loads(capsys.readouterr().out) == {"result": {"status": "no-pr"}}
