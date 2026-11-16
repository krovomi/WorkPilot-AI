"""``/projects``: registering, listing, reading and deleting a project, and
who is on it.

A registration clones a real repository, served over git's HTTP protocol on
the loopback, into the server's ``REPOS_ROOT``.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from tests.server_e2e.stack import make_origin_repo, serve_directory


@pytest.fixture
def origin(tmp_path) -> Iterator[str]:
    """The URL of a bare repository with a ``main`` branch."""
    make_origin_repo(tmp_path / "origin")
    with serve_directory(tmp_path / "origin") as base:
        yield f"{base}/origin.git"


async def ids(world, who: str, **kw) -> dict[str, str | None]:
    return {
        p["id"]: p["my_role"] for p in await world.ok(who, "GET", "/projects", **kw)
    }


class TestWhoSeesWhichProject:
    async def test_a_member_sees_their_project_with_their_role(self, world):
        a = world.projects["a"]
        assert await ids(world, "contributor_a") == {a: "member"}
        assert await ids(world, "viewer_a") == {a: "viewer"}
        assert await ids(world, "maintainer_a") == {a: "owner"}

    async def test_a_group_brings_its_project(self, world):
        assert await ids(world, "grouped_a") == {world.projects["a"]: "member"}

    async def test_a_group_raises_a_lower_own_role(self, world):
        """``viewer_a`` joins the group: its ``member`` wins over their ``viewer``."""
        await world.ok(
            "admin_a",
            "PUT",
            f"/admin/groups/{world.group}/members/{world.users['viewer_a']}",
        )
        assert await ids(world, "viewer_a") == {world.projects["a"]: "member"}

    async def test_an_organization_administrator_sees_every_project_of_it(self, world):
        assert await ids(world, "admin_a") == {world.projects["a"]: "owner"}
        assert await ids(world, "admin_b") == {world.projects["b"]: "owner"}

    async def test_a_person_of_the_organization_off_every_project_sees_none(
        self, world
    ):
        assert await ids(world, "stranger_a") == {}

    async def test_the_platform_administrator_out_of_any_org_sees_all(self, world):
        assert await ids(world, "platform") == {
            world.projects["a"]: "owner",
            world.projects["b"]: "owner",
        }

    async def test_the_platform_administrator_in_an_org_sees_that_org_s(self, world):
        listed = await ids(
            world, "platform", headers={"X-WorkPilot-Org": world.orgs["b"]}
        )
        assert listed == {world.projects["b"]: "owner"}

    async def test_reading_a_project_gives_the_caller_s_role(self, world):
        a = world.projects["a"]
        assert (await world.ok("viewer_a", "GET", f"/projects/{a}"))[
            "my_role"
        ] == "viewer"
        assert (await world.ok("grouped_a", "GET", f"/projects/{a}"))["my_role"] == (
            "member"
        )
        assert (await world.ok("admin_a", "GET", f"/projects/{a}"))[
            "my_role"
        ] == "owner"


class TestRegisteringAProject:
    async def test_a_contributor_registers_and_owns_it(self, world, origin):
        created = await world.call(
            "contributor_a",
            "POST",
            "/projects",
            json={"name": "Shop", "repo_url": origin},
        )
        assert created.status_code == 201, created.text
        project = created.json()
        assert project["my_role"] == "owner"
        assert project["org_id"] == world.orgs["a"]
        assert project["default_branch"] == "main"
        clone = Path(world.tmp / "repos" / project["id"])
        assert (clone / "README.md").read_text(encoding="utf-8").startswith("# Shared")
        members = await world.ok(
            "contributor_a", "GET", f"/projects/{project['id']}/members"
        )
        assert [(m["display_name"], m["role"]) for m in members] == [
            ("contributor_a", "owner")
        ]
        audit = await world.ok("admin_a", "GET", "/admin/audit")
        assert "project.created" in {row["action"] for row in audit}
        # The other organization does not see it.
        assert project["id"] not in await ids(world, "admin_b")

    async def test_a_viewer_cannot_register(self, world, origin):
        answer = await world.call(
            "viewer_a", "POST", "/projects", json={"name": "X", "repo_url": origin}
        )
        assert answer.status_code == 403
        assert answer.json()["detail"] == "Missing permission: task.write"

    async def test_a_project_needs_an_organization(self, world, origin):
        answer = await world.call(
            "platform", "POST", "/projects", json={"name": "X", "repo_url": origin}
        )
        assert answer.status_code == 400
        assert "No active organization" in answer.json()["detail"]

    @pytest.mark.parametrize(
        ("url", "detail"),
        [
            (
                "https://someone:pat@git.example.com/repo.git",
                "Credentials embedded in the repo URL are not allowed.",
            ),
            ("file:///etc", "Unsupported repo URL scheme: file:///etc"),
            ("/srv/git/other-tenant", "Unsupported repo URL scheme"),
        ],
    )
    async def test_a_repository_url_the_server_will_not_clone(self, world, url, detail):
        answer = await world.call(
            "contributor_a", "POST", "/projects", json={"name": "X", "repo_url": url}
        )
        assert answer.status_code == 400
        assert answer.json()["detail"].startswith(detail)
        assert await ids(world, "contributor_a") == {world.projects["a"]: "member"}

    async def test_a_clone_that_fails_registers_nothing(self, world, origin):
        answer = await world.call(
            "contributor_a",
            "POST",
            "/projects",
            json={"name": "X", "repo_url": origin, "default_branch": "no-such-branch"},
        )
        assert answer.status_code == 400
        assert answer.json()["detail"].startswith("git clone --branch failed")
        assert await ids(world, "contributor_a") == {world.projects["a"]: "member"}

    async def test_the_project_quota_is_held(self, world, origin):
        await world.ok("admin_a", "PUT", "/admin/quotas", json={"max_projects": 1})
        answer = await world.call(
            "contributor_a", "POST", "/projects", json={"name": "X", "repo_url": origin}
        )
        assert answer.status_code == 409
        assert answer.json()["detail"].startswith("Project quota reached (1)")


class TestDeletingAProject:
    async def test_its_owner_deletes_it_and_its_clone(self, world):
        a = world.projects["a"]
        clone = world.clone("a")
        assert clone.is_dir()
        assert await world.ok("owner_a", "DELETE", f"/projects/{a}") == {
            "deleted": True
        }
        assert not clone.exists()
        assert (await world.call("owner_a", "GET", f"/projects/{a}")).status_code == 404
        assert await ids(world, "contributor_a") == {}

    async def test_an_organization_administrator_deletes_it(self, world):
        a = world.projects["a"]
        assert await world.ok("admin_a", "DELETE", f"/projects/{a}") == {
            "deleted": True
        }

    async def test_a_member_cannot(self, world):
        answer = await world.call(
            "contributor_a", "DELETE", f"/projects/{world.projects['a']}"
        )
        assert answer.status_code == 403
        assert world.clone("a").is_dir()


class TestTheProjectMembers:
    async def test_the_list_names_each_member_and_role(self, world):
        members = await world.ok(
            "viewer_a", "GET", f"/projects/{world.projects['a']}/members"
        )
        roles = {m["display_name"]: m["role"] for m in members}
        assert roles["owner_a"] == "owner"
        assert roles["viewer_a"] == "viewer"
        assert "stranger_a" not in roles
        # Ordered by name, as a picker shows them.
        names = [m["display_name"] for m in members]
        assert names == sorted(names)

    async def test_an_owner_adds_changes_and_removes_a_member(self, world):
        a = world.projects["a"]
        stranger = world.users["stranger_a"]
        added = await world.call(
            "owner_a", "POST", f"/projects/{a}/members", json={"user_id": stranger}
        )
        assert added.status_code == 201, added.text
        assert added.json()["role"] == "member"
        assert world.projects["a"] in await ids(world, "stranger_a")

        changed = await world.ok(
            "owner_a",
            "POST",
            f"/projects/{a}/members",
            json={"user_id": stranger, "role": "viewer"},
        )
        assert changed["role"] == "viewer"
        assert (await ids(world, "stranger_a"))[a] == "viewer"

        assert await world.ok(
            "owner_a", "DELETE", f"/projects/{a}/members/{stranger}"
        ) == {"removed": True}
        assert await ids(world, "stranger_a") == {}
        again = await world.call(
            "owner_a", "DELETE", f"/projects/{a}/members/{stranger}"
        )
        assert again.status_code == 404
        actions = [
            row["action"] for row in await world.ok("admin_a", "GET", "/admin/audit")
        ]
        assert {"project.member.added", "project.member.removed"} <= set(actions)

    async def test_an_organization_administrator_manages_them(self, world):
        a = world.projects["a"]
        answer = await world.call(
            "admin_a",
            "POST",
            f"/projects/{a}/members",
            json={"user_id": world.users["stranger_a"], "role": "member"},
        )
        assert answer.status_code == 201, answer.text

    async def test_nobody_of_another_organization_joins(self, world):
        answer = await world.call(
            "owner_a",
            "POST",
            f"/projects/{world.projects['a']}/members",
            json={"user_id": world.users["member_b"]},
        )
        assert answer.status_code == 404
        assert answer.json()["detail"] == "User not found"

    async def test_an_unknown_or_deactivated_account_does_not_join(self, world):
        a = world.projects["a"]
        unknown = await world.call(
            "owner_a", "POST", f"/projects/{a}/members", json={"user_id": "no-one"}
        )
        assert unknown.status_code == 404
        await world.ok(
            "admin_a", "POST", f"/admin/users/{world.users['stranger_a']}/deactivate"
        )
        gone = await world.call(
            "owner_a",
            "POST",
            f"/projects/{a}/members",
            json={"user_id": world.users["stranger_a"]},
        )
        assert gone.status_code == 404

    async def test_a_role_that_does_not_exist_is_refused(self, world):
        answer = await world.call(
            "owner_a",
            "POST",
            f"/projects/{world.projects['a']}/members",
            json={"user_id": world.users["stranger_a"], "role": "superuser"},
        )
        assert answer.status_code == 400
        assert answer.json()["detail"] == "Invalid role: superuser"
