"""Two organizations on one real server: each one works, neither sees the other.

The other server-mode tests call the routes as functions, one at a time. This
one starts the server as ``deploy/`` does (migrations, then the streaming
server and ``provider_api:app`` under uvicorn) against a real database, and
goes through it over HTTP and WebSocket only, as the desktop app would:

- an operator creates the platform administrator with the image's script and
  two organizations, invites each one's people into it (an invitation makes
  its account a member of the organization it was issued in) and makes one of
  them its administrator, who registers a project, which the server clones
  from a small repository it reaches over HTTP, and gives the others their
  project roles (a member each, and a viewer in the first);
- each member creates, edits and deletes a card on their board, and their
  live stream (``project:<id>``) says so; the other organization's member gets
  404 on each of those routes, cannot open that stream nor switch to it;
- a viewer reads the board and is refused (403) every write;
- a run starts on a card with a fake agent in place of the model
  (``tests/server_e2e/fake_backend``): it is confined to its project, streams
  on ``run:<id>``, writes the spec and ends; its stream and its history are
  closed to the other organization;
- a project job (the context index, a real runner without a model) runs and
  is closed to the other organization the same way;
- every route that takes a ``project_id`` answers the other organization's
  administrator and member, on the first organization's project, exactly as it
  answers for a project that does not exist.

It needs a database: ``WORKPILOT_E2E_DATABASE_URL`` (PostgreSQL in CI, e.g.
``postgresql+asyncpg://workpilot:<password>@127.0.0.1:5432/workpilot``; a
SQLite URL works too), and Linux with Landlock, which every run requires. Without
the URL the module is skipped, unless ``WORKPILOT_EXPECT_SERVER_E2E`` is set,
as in the CI job that runs it (``ci.yml``, ``server-e2e``), where it fails
instead. It takes port 8765, the streaming server's fixed port, and refuses to
start when something else holds it.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from tests.server_e2e import stack as e2e
from tests.server_e2e.fake_backend.fake_agent import RELEASE_FILE, REPORT_FILE

DB_URL = os.environ.get("WORKPILOT_E2E_DATABASE_URL", "")
EXPECTED = os.environ.get("WORKPILOT_EXPECT_SERVER_E2E", "")

pytestmark = [
    pytest.mark.e2e,
    pytest.mark.skipif(
        not DB_URL and not EXPECTED,
        reason="WORKPILOT_E2E_DATABASE_URL is not set (the server e2e needs a database)",
    ),
]

#: Close codes of the streaming server (``streaming/websocket_server.py``).
WS_UNAUTHORIZED = 4401
WS_FORBIDDEN = 4403

#: The organization role each person ends up with: by invitation, and the
#: administrator by the operator's promotion.
ORG_ROLES = {"admin": "admin", "member": "contributor", "viewer": "viewer"}

PEOPLE = ("platform", "admin_a", "member_a", "viewer_a", "admin_b", "member_b")


@dataclass
class World:
    stack: e2e.Stack
    people: dict[str, e2e.Person]
    orgs: dict[str, str]
    projects: dict[str, str]
    repos_root: Path

    def p(self, key: str) -> e2e.Person:
        return self.people[key]

    def clone(self, side: str) -> Path:
        return self.repos_root / self.projects[side]


def _seed(
    st: e2e.Stack, people: dict[str, e2e.Person], run: str, repo_url: str
) -> tuple[dict[str, str], dict[str, str]]:
    platform = people["platform"]
    st.login(platform)
    orgs = {
        side: st.ok(
            platform,
            "POST",
            "/admin/orgs",
            json={"name": f"E2E {side.upper()} {run}", "slug": f"e2e-{side}-{run}"},
        )["id"]
        for side in ("a", "b")
    }
    # The operator invites each organization's people into it: accepting
    # makes them members, with the organization role the invitation names
    # (`member` → contributor, `viewer` → viewer)...
    team = {
        "a": (
            ("admin_a", "member", "owner"),
            ("member_a", "member", "member"),
            ("viewer_a", "viewer", "viewer"),
        ),
        "b": (("admin_b", "member", "owner"), ("member_b", "member", "member")),
    }
    for side, members in team.items():
        for key, role, _ in members:
            st.invite(platform, people[key], orgs[side], role)
            st.login(people[key])
        # ...makes one of them the organization's administrator...
        st.ok(
            platform,
            "PATCH",
            f"/admin/members/{people[f'admin_{side}'].user_id}",
            org=orgs[side],
            json={"role_slug": "admin"},
        )
    # ...who registers the project and gives their team its roles on it.
    projects: dict[str, str] = {}
    for side, members in team.items():
        admin = people[f"admin_{side}"]
        projects[side] = st.ok(
            admin,
            "POST",
            "/projects",
            json={"name": f"Project {side.upper()}", "repo_url": repo_url},
        )["id"]
        for key, _, project_role in members[1:]:
            st.ok(
                admin,
                "POST",
                f"/projects/{projects[side]}/members",
                json={"user_id": people[key].user_id, "role": project_role},
            )
    return orgs, projects


@pytest.fixture(scope="module")
def world(tmp_path_factory: pytest.TempPathFactory) -> Iterator[World]:
    if not DB_URL:
        pytest.fail(
            "WORKPILOT_EXPECT_SERVER_E2E is set but WORKPILOT_E2E_DATABASE_URL is not"
        )
    if e2e.port_in_use(e2e.WS_PORT):
        pytest.fail(
            f"Port {e2e.WS_PORT} is taken (a local backend?): the streaming server "
            "needs it. Stop it and run again."
        )
    root = tmp_path_factory.mktemp("server-e2e")
    forge = root / "forge"
    e2e.make_origin_repo(forge)
    repos_root = root / "repos"
    env = e2e.server_env(DB_URL, repos_root)
    e2e.migrate(env)
    run = e2e.run_suffix()
    people = {key: e2e.new_person(key, run) for key in PEOPLE}
    e2e.create_platform_admin(env, people["platform"])

    with e2e.serve_directory(forge) as forge_url:
        st = e2e.Stack(env, root)
        try:
            st.start()
            orgs, projects = _seed(st, people, run, f"{forge_url}/origin.git")
            yield World(st, people, orgs, projects, repos_root)
        finally:
            st.stop()


# -- WebSocket helpers ---------------------------------------------------------


async def _open(who: e2e.Person, channel: str) -> Any:
    """A stream on `channel`, opened as the app opens it; the welcome is read."""
    from websockets.asyncio.client import connect

    ws = await connect(
        f"{e2e.WS_URL}/stream/{channel}", additional_headers=e2e.ws_headers(who)
    )
    welcome = e2e.event_of(await asyncio.wait_for(ws.recv(), timeout=10))
    assert welcome.get("event_type") == "session_start", welcome
    return ws


async def _refused_with(who: e2e.Person | None, channel: str) -> int | None:
    """The close code the server answers `who` with on `channel`."""
    from websockets.asyncio.client import connect
    from websockets.exceptions import ConnectionClosed

    headers = e2e.ws_headers(who) if who else {}
    async with connect(
        f"{e2e.WS_URL}/stream/{channel}", additional_headers=headers
    ) as ws:
        try:
            message = await asyncio.wait_for(ws.recv(), timeout=10)
        except ConnectionClosed as closed:
            return closed.rcvd.code if closed.rcvd else None
    raise AssertionError(f"{channel} was opened: {message!r}")


async def _wait_for(ws: Any, match: Any, timeout: float = 20.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            raise AssertionError("event not received in time")
        event = e2e.event_of(await asyncio.wait_for(ws.recv(), timeout=left))
        if match(event):
            return event


async def _drain(ws: Any, seconds: float) -> list[dict[str, Any]]:
    """Everything `ws` receives during `seconds`."""
    got: list[dict[str, Any]] = []
    deadline = time.monotonic() + seconds
    while (left := deadline - time.monotonic()) > 0:
        try:
            got.append(e2e.event_of(await asyncio.wait_for(ws.recv(), timeout=left)))
        except TimeoutError:
            break
    return got


def _is(event_type: str, **data: Any):
    def match(event: dict[str, Any]) -> bool:
        payload = event.get("data") or {}
        return event.get("event_type") == event_type and all(
            payload.get(k) == v for k, v in data.items()
        )

    return match


# -- People and projects ---------------------------------------------------------


def test_each_person_sees_their_own_organization_and_project_only(world: World) -> None:
    st = world.stack
    for key, side in (
        ("admin_a", "a"),
        ("member_a", "a"),
        ("viewer_a", "a"),
        ("admin_b", "b"),
        ("member_b", "b"),
    ):
        listed = [p["id"] for p in st.ok(world.p(key), "GET", "/projects")]
        assert listed == [world.projects[side]], key
        mine = st.ok(world.p(key), "GET", "/auth/me/permissions")
        assert [o["id"] for o in mine["organizations"]] == [world.orgs[side]], key
        assert mine["org_role"] == ORG_ROLES[key.split("_")[0]], key

    # The server cloned each project from the forge, each in its own directory.
    for side in ("a", "b"):
        assert (world.clone(side) / "README.md").is_file()


# -- Cards, the board stream, and the other organization ---------------------


@pytest.mark.parametrize(("mine", "theirs"), [("a", "b"), ("b", "a")])
async def test_a_member_works_on_their_board_and_the_other_org_gets_404(
    world: World, mine: str, theirs: str
) -> None:
    st = world.stack
    me, other = world.p(f"member_{mine}"), world.p(f"member_{theirs}")
    my_project, their_project = world.projects[mine], world.projects[theirs]
    in_mine = {"project_id": my_project}

    my_stream = await _open(me, f"project:{my_project}")
    # The other member, on their own board, tries to switch to mine.
    their_stream = await _open(other, f"project:{their_project}")
    await their_stream.send(
        json.dumps({"type": "init_session", "session_id": f"project:{my_project}"})
    )
    try:
        assert await _refused_with(other, f"project:{my_project}") == WS_FORBIDDEN
        assert await _refused_with(None, f"project:{my_project}") == WS_UNAUTHORIZED

        card = st.ok(
            me,
            "POST",
            "/api/board/cards",
            params=in_mine,
            json={"title": f"Card of {mine.upper()}", "description": "Sign in."},
        )
        card_id = card["id"]
        await _wait_for(my_stream, _is("spec_created", spec=card_id))

        path = f"/api/board/cards/{card_id}"
        attempts = [
            ("GET", path, None),
            ("PATCH", path, {"description": "hijacked"}),
            ("DELETE", path, None),
            ("GET", f"{path}/changes", None),
            ("GET", "/api/board/snapshot", None),
            ("GET", f"/projects/{my_project}/specs", None),
            ("GET", f"/projects/{my_project}", None),
        ]
        for method, route, body in attempts:
            response = st.call(other, method, route, params=in_mine, json=body)
            assert response.status_code == 404, (method, route, response.text)
        # The card's spec id is a uuid: named under the other's own project,
        # it is not found either.
        response = st.call(
            other,
            "POST",
            f"/projects/{their_project}/specs/{card['specId']}/runs",
            json={"phase": "spec"},
        )
        assert response.status_code == 404, response.text

        st.ok(
            me, "PATCH", path, params=in_mine, json={"description": "Sign in with SSO."}
        )
        await _wait_for(my_stream, _is("spec_updated", spec=card_id))
        assert (
            st.ok(me, "GET", path, params=in_mine)["description"] == "Sign in with SSO."
        )

        st.ok(me, "DELETE", path, params=in_mine)
        await _wait_for(my_stream, _is("spec_deleted", spec=card_id))
        assert st.call(me, "GET", path, params=in_mine).status_code == 404

        # Nothing of all that reached the other organization's stream, and
        # its switch to my channel was never confirmed.
        leaked = [
            e
            for e in await _drain(their_stream, 1.5)
            if e.get("event_type") != "session_start"
        ]
        assert leaked == []
    finally:
        await my_stream.close()
        await their_stream.close()


# -- A viewer --------------------------------------------------------------------


async def test_a_viewer_reads_the_board_and_every_write_is_refused(
    world: World,
) -> None:
    st = world.stack
    member, viewer = world.p("member_a"), world.p("viewer_a")
    project = world.projects["a"]
    in_a = {"project_id": project}
    card = st.ok(
        member,
        "POST",
        "/api/board/cards",
        params=in_a,
        json={"title": "Viewer target", "description": "Read me."},
    )
    path = f"/api/board/cards/{card['id']}"

    assert st.ok(viewer, "GET", path, params=in_a)["description"] == "Read me."
    assert card["id"] in [
        s["spec_name"] for s in st.ok(viewer, "GET", f"/projects/{project}/specs")
    ]
    stream = await _open(viewer, f"project:{project}")
    await stream.close()

    writes = [
        ("POST", "/api/board/cards", {"title": "Not mine to add"}),
        ("PATCH", path, {"description": "changed"}),
        ("DELETE", path, None),
        ("POST", f"{path}/approve", None),
        ("POST", f"/projects/{project}/specs/{card['specId']}/claim", {}),
        ("POST", f"/projects/{project}/specs/{card['specId']}/runs", {"phase": "spec"}),
        ("POST", "/api/features/context/jobs", {}),
        (
            "PUT",
            "/api/features/roadmap/files/roadmap.json",
            {"content": "{}", "base_sha256": None},
        ),
        ("POST", "/api/features/insights/sessions", {}),
    ]
    for method, route, body in writes:
        response = st.call(viewer, method, route, params=in_a, json=body)
        assert response.status_code == 403, (method, route, response.text)
    assert st.ok(member, "GET", path, params=in_a)["description"] == "Read me."


# -- A run with the fake agent ---------------------------------------------------


@pytest.fixture(scope="module")
def a_run(world: World) -> dict[str, Any]:
    """A `spec` run on a card of A, watched from both organizations."""
    st = world.stack
    member_a, member_b = world.p("member_a"), world.p("member_b")
    project = world.projects["a"]
    clone_a = world.clone("a")
    probes = {
        "own clone": f"probe-read {clone_a / 'README.md'}",
        "other org's clone": f"probe-read {world.clone('b') / 'README.md'}",
        "every clone": f"probe-list {world.repos_root}",
        "server log": f"probe-read {e2e.BACKEND / 'websocket_server.log'}",
    }
    # The card's description is the agent's task: here, a hostile one.
    card = st.ok(
        member_a,
        "POST",
        "/api/board/cards",
        params={"project_id": project},
        json={
            "title": "Run me",
            "description": "Write the spec.\n" + "\n".join(probes.values()) + "\n",
            "require_review": True,
        },
    )
    spec_id, card_id = card["specId"], card["id"]
    runs_path = f"/projects/{project}/specs/{spec_id}/runs"

    async def scenario() -> dict[str, Any]:
        seen: dict[str, Any] = {"card": card_id, "spec_id": spec_id}
        board = await _open(member_a, f"project:{project}")
        try:
            run = st.call(member_a, "POST", runs_path, json={"phase": "spec"})
            assert run.status_code == 202, run.text
            run_id = run.json()["id"]
            seen["run_id"] = run_id

            live = await _open(member_a, f"run:{run_id}")
            seen["agent_event"] = await _wait_for(
                live, _is("progress_update"), timeout=90
            )
            seen["b_run_stream"] = await _refused_with(member_b, f"run:{run_id}")
            seen["b_runs"] = st.call(member_b, "GET", runs_path).status_code
            seen["b_cancel"] = st.call(
                member_b, "POST", f"{runs_path}/{run_id}/cancel"
            ).status_code
            seen["b_cancel_own"] = st.call(
                member_b,
                "POST",
                f"/projects/{world.projects['b']}/specs/{spec_id}/runs/{run_id}/cancel",
            ).status_code
            await live.close()

            (clone_a / ".workpilot" / "specs" / card_id / RELEASE_FILE).touch()
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                row = next(
                    r for r in st.ok(member_a, "GET", runs_path) if r["id"] == run_id
                )
                if row["status"] in ("succeeded", "failed", "cancelled"):
                    break
                await asyncio.sleep(0.5)
            seen["run"] = row
            seen["board_event"] = await _wait_for(
                board,
                _is("spec_status_changed", run_id=run_id, run_status=row["status"]),
            )
        finally:
            await board.close()
        return seen

    seen = asyncio.run(scenario())
    report = clone_a / ".workpilot" / "specs" / card_id / REPORT_FILE
    seen["report"] = json.loads(report.read_text(encoding="utf-8"))
    seen["probes"] = {
        name: seen["report"]["probes"][line] for name, line in probes.items()
    }
    return seen


def test_a_run_with_the_fake_agent_finishes_and_only_its_org_follows_it(
    world: World, a_run: dict[str, Any]
) -> None:
    st = world.stack
    assert a_run["run"]["status"] == "succeeded", a_run["run"]
    assert a_run["agent_event"]["data"]["message"] == "fake agent working"
    # The other organization: no stream, no history, no cancel.
    assert a_run["b_run_stream"] == WS_FORBIDDEN
    assert a_run["b_runs"] == 404
    assert a_run["b_cancel"] == 404
    assert a_run["b_cancel_own"] == 404

    # The agent ran confined to its project, without the server's secrets.
    assert a_run["probes"] == {
        "own clone": "allowed",
        "other org's clone": "denied",
        "every clone": "denied",
        "server log": "denied",
    }
    assert a_run["report"]["has_database_url"] is False
    assert a_run["report"]["has_jwt_secret"] is False

    # Its spec is on A's card, for A only.
    path = f"/api/board/cards/{a_run['card']}"
    in_a = {"project_id": world.projects["a"]}
    assert "Spec written by the fake agent" in (
        st.ok(world.p("member_a"), "GET", path, params=in_a)["spec"] or ""
    )
    assert st.call(world.p("member_b"), "GET", path, params=in_a).status_code == 404


# -- A project job ---------------------------------------------------------------


@pytest.fixture(scope="module")
def a_job(world: World) -> dict[str, Any]:
    """The context index of A, rebuilt by its real runner as a project job."""
    st = world.stack
    member_a = world.p("member_a")
    in_a = {"project_id": world.projects["a"]}
    job = st.ok(member_a, "POST", "/api/features/context/jobs", params=in_a, json={})
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        job = st.ok(
            member_a, "GET", f"/api/features/context/jobs/{job['id']}", params=in_a
        )
        if job["status"] in ("succeeded", "failed", "cancelled"):
            break
        time.sleep(0.5)
    return job


def test_a_project_job_runs_and_the_other_org_cannot_follow_it(
    world: World, a_job: dict[str, Any]
) -> None:
    st = world.stack
    assert a_job["status"] == "succeeded", a_job
    in_a = {"project_id": world.projects["a"]}
    snapshot = st.ok(
        world.p("member_a"), "GET", "/api/features/context/snapshot", params=in_a
    )
    assert snapshot["files"], snapshot

    member_b = world.p("member_b")
    in_b = {"project_id": world.projects["b"]}
    job_path = f"/api/features/context/jobs/{a_job['id']}"
    for params in (in_a, in_b):
        assert st.call(member_b, "GET", job_path, params=params).status_code == 404
        assert (
            st.call(member_b, "POST", f"{job_path}/cancel", params=params).status_code
            == 404
        )
    assert (
        st.call(
            member_b, "GET", "/api/features/context/snapshot", params=in_a
        ).status_code
        == 404
    )


# -- Every route that names a project ------------------------------------------


def _path_values(
    world: World, run: dict[str, Any], job: dict[str, Any]
) -> dict[str, str]:
    """Real ids of A for every path parameter: what an attacker who learned
    them would send."""
    return {
        "card_id": run["card"],
        "spec_id": run["spec_id"],
        "run_id": run["run_id"],
        "job_id": job["id"],
        "member_user_id": world.p("member_a").user_id,
        "group_id": str(uuid.uuid4()),
        "session_id": str(uuid.uuid4()),
        "feature_id": "feature-1",
        "idea_id": "idea-1",
        "number": "1",
        "kind": "i18n",
        "name": "roadmap.json",
    }


#: The routes of the server's projects: their board, runs and shared features.
PROJECT_SURFACE = ("/projects/", "/api/board/", "/api/features/")


def _missing(response: Any) -> bool:
    """404, or a permission the caller lacks whatever the project: both are
    decided without saying whether the project exists."""
    if response.status_code == 404:
        return True
    detail = str(response.json().get("detail", ""))
    return response.status_code == 403 and detail.startswith("Missing permission:")


def _call_route(
    st: e2e.Stack,
    who: e2e.Person,
    method: str,
    route: str,
    params: dict[str, str],
    values: dict[str, str],
) -> Any:
    """One operation of the API, its path filled from `values`, the project
    in the query when it takes it there, an empty body when it takes one."""
    url = route.format(
        **{n: values[n] for n, where in params.items() if where == "path"}
    )
    query = (
        {"project_id": values["project_id"]}
        if params["project_id"] == "query"
        else None
    )
    body = {} if method in ("post", "put", "patch") else None
    return st.call(who, method.upper(), url, params=query, json=body)


@pytest.mark.parametrize("attacker", ["admin_b", "member_b"])
def test_every_project_route_answers_the_other_org_as_if_the_project_did_not_exist(
    world: World, a_run: dict[str, Any], a_job: dict[str, Any], attacker: str
) -> None:
    st = world.stack
    who = world.p(attacker)
    spec = st.http.get("/openapi.json").json()
    values = _path_values(world, a_run, a_job)
    real, unknown = world.projects["a"], str(uuid.uuid4())
    checked = 0
    problems: list[str] = []
    for route, operations in spec["paths"].items():
        for method, operation in operations.items():
            params = {p["name"]: p["in"] for p in operation.get("parameters", [])}
            if "project_id" not in params:
                continue
            missing = [
                n
                for n, where in params.items()
                if where == "path" and n != "project_id" and n not in values
            ]
            assert not missing, (route, missing)

            on_real, on_unknown = (
                _call_route(st, who, method, route, params, {**values, "project_id": p})
                for p in (real, unknown)
            )
            seen = (on_real.status_code, on_real.text)
            if seen != (on_unknown.status_code, on_unknown.text):
                problems.append(f"{method} {route}: {seen} vs {on_unknown.status_code}")
            elif route.startswith(PROJECT_SURFACE) and not _missing(on_real):
                problems.append(f"{method} {route}: {seen}")
            checked += 1
    assert problems == []
    # A server mounts only the features of a project (server.authz.catalog.
    # SERVER_FEATURES): the operations that name one are those of its board,
    # runs and shared features, plus a group's projects; 69 when written.
    assert checked >= 69
