"""Server mode: the AI review of a server project's pull requests.

The desktop app reviews a pull request by running the GitHub runner in the
project's folder; a server project's review runs on the server, as a job on
its clone. These tests hold the job to the runner, the project's own
repository and a pull request number, to the GitHub token of whoever starts
it, and its result to the runner's own file, read by every member.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48
_ADA_TOKEN = "ghp_" + "A" * 36  # pragma: allowlist secret

_FAKE_RUNNER = """
import os, pathlib, sys
args = sys.argv[1:]
project = pathlib.Path(args[args.index("--project") + 1])
print("args", " ".join(args[2:]), flush=True)
print("token", "ada" if os.environ.get("GITHUB_TOKEN", "").startswith("ghp_A") else "none", flush=True)
out = project / ".workpilot" / "github" / "pr"
out.mkdir(parents=True, exist_ok=True)
(out / f"review_{args[-1]}.json").write_text('{"pr_number": %s, "success": true}' % args[-1], encoding="utf-8")
print("done", flush=True)
"""


@pytest.fixture
async def server(monkeypatch, tmp_path):
    from cryptography.fernet import Fernet

    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv("WORKPILOT_SECRETS_MASTER_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path / "repos"))
    # Confinement is proven in test_run_isolation; here, what the job runs.
    monkeypatch.setenv("WORKPILOT_RUN_ISOLATION", "off")
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "review.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    from server.db import engine as db_engine
    from server.db.models import Organization, Project, User
    from server.services import project_jobs
    from server.services.secrets import set_user_secret

    monkeypatch.setattr(project_jobs, "_jobs", None)
    monkeypatch.setattr(project_jobs, "emit_board_event", lambda *a: None)
    backend = tmp_path / "backend"
    (backend / "runners" / "github").mkdir(parents=True)
    (backend / "runners" / "github" / "runner.py").write_text(
        _FAKE_RUNNER, encoding="utf-8"
    )
    monkeypatch.setattr(project_jobs, "BACKEND_DIR", backend)

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    clone = tmp_path / "repos" / "shop"
    clone.mkdir(parents=True)
    async with db_engine.get_session_factory()() as db:
        db.add_all(
            [
                User(id="u-ada", email="ada@x.test", display_name="Ada"),
                User(id="u-eve", email="eve@x.test", display_name="Eve"),
            ]
        )
        org = Organization(name="A", slug="org-a")
        db.add(org)
        await db.flush()
        projects = [
            Project(org_id=org.id, name=name, repo_url=url, server_path=str(clone))
            for name, url in (
                ("Shop", "https://github.com/acme/shop.git"),
                ("Lab", "https://gitlab.com/acme/lab.git"),
            )
        ]
        db.add_all(projects)
        await db.commit()
        await set_user_secret(db, "u-ada", "github_token", _ADA_TOKEN)
        ids = (projects[0].id, projects[1].id, org.id)
    yield {"ids": ids, "clone": clone}
    server_config.reset_settings_cache()


def _scope(server, role="member", which=0):
    from server.authz.scope import ProjectScope

    project_id, other_id, org_id = server["ids"]
    return ProjectScope([project_id, other_id][which], org_id, server["clone"], role)


def _request(user_id="u-ada"):
    from server.authz.principal import Principal
    from starlette.requests import Request

    request = Request({"type": "http", "method": "POST", "path": "/", "headers": []})
    request.state.principal = Principal(
        id=user_id, email=f"{user_id}@x.test", permissions=frozenset({"agent.execute"})
    )
    return request


async def _db():
    from server.db.engine import get_session_factory

    return get_session_factory()()


async def _wait_final(job_id: str):
    from server.db.models import ProjectJob

    for _ in range(300):
        async with await _db() as db:
            job = await db.get(ProjectJob, job_id)
            if job.status in {"succeeded", "failed", "cancelled"}:
                return job
        await asyncio.sleep(0.1)
    raise AssertionError("job did not finish")


def test_the_job_is_the_runner_on_the_project_s_repository():
    from shared_features.github_review import ReviewJob, review_args

    assert review_args("acme/shop", ReviewJob(pr_number=7)) == [
        "--repo",
        "acme/shop",
        "review-pr",
        "7",
    ]
    assert review_args(
        "acme/shop",
        ReviewJob(pr_number=7, followup=True, model="sonnet", thinking_level="high"),
    ) == [
        "--repo",
        "acme/shop",
        "--model",
        "sonnet",
        "--thinking-level",
        "high",
        "followup-review-pr",
        "7",
    ]
    for bad in (
        {"pr_number": 0},
        {"pr_number": "7 --auto-post"},
        {"pr_number": 7, "repo": "evil/repo"},
        {"pr_number": 7, "auto_post": True},
        {"pr_number": 7, "model": "--auto-post"},
        {"pr_number": 7, "thinking_level": "ultrathink"},
    ):
        with pytest.raises(ValueError):
            ReviewJob.model_validate(bad)


def test_a_runner_is_a_file_of_runners_or_of_one_of_its_packages():
    from server.services.project_jobs import RUNNER_NAME

    for name in ("roadmap_runner.py", "github/runner.py"):
        assert RUNNER_NAME.match(name), name
    for name in ("../runner.py", "/etc/runner.py", "a/b/runner.py", "github/../x.py"):
        assert not RUNNER_NAME.match(name), name


@pytest.mark.asyncio
async def test_a_member_reviews_a_pull_request_with_their_own_token(server):
    from shared_features.github_review import get_review_job, get_reviews, start_review

    async with await _db() as db:
        job = await start_review(
            _request(),
            {"pr_number": 7, "model": "sonnet"},
            _scope(server),
            db,
        )
    done = await _wait_final(job["id"])
    assert done.status == "succeeded", done.error
    async with await _db() as db:
        followed = await get_review_job(job["id"], 0, _scope(server), db)
    assert followed["lines"] == [
        "args --repo acme/shop --model sonnet review-pr 7",
        "token ada",
        "done",
    ]

    # Every member reads it, a viewer included; a PR never reviewed is null.
    reviews = await get_reviews("7,8,7", _scope(server, "viewer"))
    assert json.loads(reviews["reviews"]["7"]) == {"pr_number": 7, "success": True}
    assert reviews["reviews"]["8"] is None
    assert list(reviews["reviews"]) == ["7", "8"]


@pytest.mark.asyncio
async def test_refusals(server):
    from shared_features.github_review import (
        cancel_review_job,
        get_review_job,
        get_reviews,
        start_review,
    )

    cases = [
        # Eve has no GitHub token on the server: nothing starts.
        ("u-eve", {"pr_number": 7}, "member", 0, 412),
        ("u-ada", {"pr_number": 7}, "viewer", 0, 403),
        ("u-ada", {"pr_number": 7, "repo": "evil/repo"}, "member", 0, 422),
        ("u-ada", {"pr_number": 7}, "member", 1, 404),
    ]
    for user, body, role, which, status in cases:
        async with await _db() as db:
            with pytest.raises(HTTPException) as refused:
                await start_review(
                    _request(user), body, _scope(server, role, which), db
                )
        assert refused.value.status_code == status, (user, body, role, which)
    assert not (server["clone"] / ".workpilot" / "github").exists()

    for numbers in ("7/../x", "abc", "0", "7,", ",".join(["1"] * 51)):
        with pytest.raises(HTTPException) as refused:
            await get_reviews(numbers, _scope(server))
        assert refused.value.status_code == 422, numbers

    async with await _db() as db:
        with pytest.raises(HTTPException) as unknown:
            await get_review_job("no-such-job", 0, _scope(server), db)
        assert unknown.value.status_code == 404
        with pytest.raises(HTTPException) as unknown:
            await cancel_review_job("no-such-job", _request(), _scope(server), db)
        assert unknown.value.status_code == 404


@pytest.mark.asyncio
async def test_a_review_file_led_out_of_the_clone_is_not_served(server, tmp_path):
    from shared_features.github_review import get_reviews

    outside = tmp_path / "outside.json"
    outside.write_text('{"secret": true}', encoding="utf-8")
    directory = server["clone"] / ".workpilot" / "github" / "pr"
    directory.mkdir(parents=True)
    try:
        os.symlink(outside, directory / "review_9.json")
    except (OSError, NotImplementedError):
        pytest.skip("no symlinks here")
    reviews = await get_reviews("9", _scope(server))
    assert reviews["reviews"]["9"] is None


@pytest.mark.asyncio
async def test_a_strict_offline_project_starts_no_review(server):
    from shared_features.github_review import start_review

    policy = server["clone"] / ".workpilot" / "offline-mode.json"
    policy.parent.mkdir(parents=True)
    policy.write_text(json.dumps({"airgapStrict": True}), encoding="utf-8")
    async with await _db() as db:
        with pytest.raises(HTTPException) as refused:
            await start_review(_request(), {"pr_number": 7}, _scope(server), db)
    assert refused.value.status_code == 409


def test_starting_a_review_is_running_an_agent():
    from server.authz.mounting import permission_for

    base = "/api/features/forge/github/reviews"
    assert permission_for("POST", f"{base}/jobs", "vcs") == "agent.execute"
    assert permission_for("POST", f"{base}/jobs/{{job_id}}/cancel", "vcs") == (
        "agent.cancel"
    )
    assert permission_for("GET", f"{base}/jobs/{{job_id}}", "vcs") == "vcs.read"
    assert permission_for("GET", base, "vcs") == "vcs.read"


@pytest.mark.asyncio
async def test_what_a_member_posted_is_recorded_on_the_saved_review(server):
    from shared_features.github_review import Posted, get_reviews, mark_posted

    directory = server["clone"] / ".workpilot" / "github" / "pr"
    directory.mkdir(parents=True)
    (directory / "review_7.json").write_text(
        json.dumps({"pr_number": 7, "posted_finding_ids": ["F1"]}), encoding="utf-8"
    )
    answer = await mark_posted(
        7, _request(), Posted(finding_ids=["F2", "F1"], review_id=99), _scope(server)
    )
    assert answer == {"posted": True}
    saved = json.loads((await get_reviews("7", _scope(server)))["reviews"]["7"])
    assert saved["review_id"] == 99
    assert saved["has_posted_findings"] is True
    assert saved["posted_finding_ids"] == ["F1", "F2"]
    assert saved["posted_at"]

    for pr_number, body, role, status in (
        (8, Posted(), "member", 404),
        (7, Posted(), "viewer", 403),
        (7, Posted(finding_ids=["x" * 201]), "member", 422),
    ):
        with pytest.raises(HTTPException) as refused:
            await mark_posted(pr_number, _request(), body, _scope(server, role))
        assert refused.value.status_code == status
    with pytest.raises(ValueError):
        Posted.model_validate({"finding_ids": [], "path": "../x"})


def test_the_person_posts_a_review_through_the_relay():
    from shared_features.forge import api_call

    assert api_call("POST", "/repos/acme/shop/pulls/7/reviews", "acme/shop") is not None
    assert (
        api_call("POST", "/repos/acme/shop/pulls/7/reviews/3/events", "acme/shop")
        is None
    )
