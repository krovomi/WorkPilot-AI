"""Server mode: the PR dialog's edits reach the server's ``pr`` run.

The app opened a server card's PR with ``{"phase": "pr"}`` only: the title,
body, target branch and draft flag a person edited in the dialog were dropped,
and the server wrote its own. They now go with the run and become arguments
of ``run.py --create-pr``, the body through a file.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


def test_the_dialogs_edits_become_create_pr_arguments(tmp_path):
    from server.services.run_manager import build_command

    pr = {
        "title": "-x Add login",
        "body": "## Why\nUsers sign in.\n$(rm -rf /)",
        "draft": True,
        "target_branch": "develop",
        "ignore_cross_review": True,
    }
    cmd = build_command("pr", "001-login", str(tmp_path), None, tmp_path, pr)
    assert "--create-pr" in cmd
    # One token, so a title that starts with "-" is not read as an option.
    assert "--pr-title=-x Add login" in cmd
    body_file = Path(cmd[cmd.index("--pr-body-file") + 1])
    assert body_file.parent == tmp_path
    assert body_file.read_text(encoding="utf-8") == pr["body"]
    assert not any("rm -rf" in part for part in cmd)
    assert cmd[cmd.index("--pr-target") + 1] == "develop"
    assert "--pr-draft" in cmd
    assert "--pr-ignore-cross-review" in cmd


def test_without_edits_the_server_writes_its_own(tmp_path):
    from server.services.run_manager import build_command

    cmd = build_command("pr", "001-login", str(tmp_path), None, tmp_path)
    assert not [part for part in cmd if part.startswith("--pr-")]
    # An empty body is a body the person chose to leave empty.
    cmd = build_command("pr", "001-login", str(tmp_path), None, tmp_path, {"body": ""})
    assert "--pr-body-file" in cmd


def test_options_are_refused_on_other_phases_and_checked():
    from pydantic import ValidationError
    from server.schemas import StartRunRequest

    with pytest.raises(ValidationError):
        StartRunRequest(phase="build", pr={"title": "T"})
    with pytest.raises(ValidationError):
        StartRunRequest(phase="pr", pr={"title": "two\nlines"})
    with pytest.raises(ValidationError):
        StartRunRequest(phase="pr", pr={"target_branch": "--upload-pack=evil"})
    with pytest.raises(ValidationError):
        StartRunRequest(phase="pr", pr={"body": "x" * 70_000})
    ok = StartRunRequest(phase="pr", pr={"title": "  Add login ", "draft": True})
    assert ok.pr is not None and ok.pr.title == "Add login"


@pytest.mark.asyncio
async def test_the_route_hands_them_to_the_run(monkeypatch):
    from server.routers import specs
    from server.schemas import StartRunRequest

    seen: dict = {}

    class Manager:
        async def start_run(self, **kwargs):
            seen.update(kwargs)
            raise specs_error("stop here")

    from server.services import run_manager

    specs_error = run_manager.RunManagerError
    monkeypatch.setattr(run_manager, "get_run_manager", lambda: Manager())

    class Spec:
        claimed_by = "u-1"

    class Project:
        server_path = "/srv/p"
        org_id = "o-1"

    async def project_or_404(db, project_id):
        return Project()

    async def spec_or_404(db, project_id, spec_id):
        return Spec()

    monkeypatch.setattr(specs, "_get_project_or_404", project_or_404)
    monkeypatch.setattr(specs, "_get_spec_or_404", spec_or_404)
    monkeypatch.setattr(specs, "ensure_can_act_on_spec", lambda *a: None)

    from fastapi import HTTPException
    from server.auth.deps import CurrentUser
    from server.authz.principal import Principal
    from starlette.requests import Request

    request = Request({"type": "http", "method": "POST", "path": "/", "headers": []})
    request.state.principal = Principal(
        id="u-1",
        email="a@x",
        permissions=frozenset({"agent.execute", "vcs.pr.create"}),
    )
    user = CurrentUser(id="u-1", email="a@x", display_name="A", role="member")
    body = StartRunRequest(phase="pr", pr={"title": "Add login", "body": "B"})
    with pytest.raises(HTTPException) as exc:
        await specs.start_run("p", "s", body, request, user, None)
    assert exc.value.status_code == 409
    assert seen["pr"]["title"] == "Add login"
    assert seen["pr"]["body"] == "B"
