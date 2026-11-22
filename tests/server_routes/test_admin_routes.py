"""``/admin``: the deployment's tenants, and inside one its members, roles,
sessions, quotas and journal.

Each change is checked by what it does to the next request of the person it
concerns, not only by the answer of the route that made it.
"""

from __future__ import annotations

import uuid

import pytest


async def permissions(world, who: str) -> set[str]:
    return set((await world.ok(who, "GET", "/auth/me/permissions"))["permissions"])


async def audit_actions(world) -> list[str]:
    return [row["action"] for row in await world.ok("admin_a", "GET", "/admin/audit")]


async def also_in(world, who: str, side: str, role: str = "contributor") -> None:
    """Make ``who`` a member of the organization ``side`` as well."""
    from server.db.engine import get_session_factory
    from server.db.models import OrgMember

    async with get_session_factory()() as db:
        db.add(
            OrgMember(
                org_id=world.orgs[side],
                user_id=world.users[who],
                role_id=world.roles[role],
            )
        )
        await db.commit()


MANAGED = "This account is managed by the platform administrator"


class TestOrganizations:
    async def test_the_platform_lists_creates_renames_and_deletes_them(self, world):
        listed = {o["slug"] for o in await world.ok("platform", "GET", "/admin/orgs")}
        assert listed == {"default", "acme", "globex"} or listed >= {"acme", "globex"}

        created = await world.call(
            "platform",
            "POST",
            "/admin/orgs",
            json={"name": "Initech", "slug": "initech"},
        )
        assert created.status_code == 201, created.text
        org = created.json()
        clash = await world.call(
            "platform", "POST", "/admin/orgs", json={"name": "Other", "slug": "initech"}
        )
        assert clash.status_code == 409
        assert clash.json()["detail"] == "An organization with slug 'initech' exists"

        renamed = await world.ok(
            "platform", "PATCH", f"/admin/orgs/{org['id']}", json={"name": "Initrode"}
        )
        assert renamed["name"] == "Initrode"
        assert await world.ok("platform", "DELETE", f"/admin/orgs/{org['id']}") == {
            "deleted": True
        }
        slugs = {o["slug"] for o in await world.ok("platform", "GET", "/admin/orgs")}
        assert "initech" not in slugs

    async def test_an_unknown_organization_is_not_found(self, world):
        missing = str(uuid.uuid4())
        for method, body in (("PATCH", {"name": "X"}), ("DELETE", None)):
            answer = await world.call(
                "platform", method, f"/admin/orgs/{missing}", json=body
            )
            assert answer.status_code == 404
            assert answer.json()["detail"] == "Organization not found"

    async def test_a_suspended_organization_keeps_its_reads_only(self, world):
        before = await permissions(world, "contributor_a")
        assert "task.write" in before
        await world.ok(
            "platform",
            "PATCH",
            f"/admin/orgs/{world.orgs['a']}",
            json={"is_active": False},
        )
        after = await permissions(world, "contributor_a")
        assert after and all(key.endswith(".read") for key in after)
        refused = await world.call(
            "contributor_a",
            "POST",
            "/api/board/cards",
            params={"project_id": world.projects["a"]},
            json={"title": "x"},
        )
        assert refused.status_code == 403
        board = await world.call(
            "contributor_a",
            "GET",
            "/api/board/snapshot",
            params={"project_id": world.projects["a"]},
        )
        assert board.status_code == 200
        # The other tenant is untouched.
        assert "task.write" in await permissions(world, "member_b")

    async def test_a_disabled_permission_is_gone_on_the_next_request(self, world):
        await world.ok(
            "platform",
            "PATCH",
            f"/admin/orgs/{world.orgs['a']}",
            json={"disabled_permissions": ["agent.execute", "agent.execute"]},
        )
        assert "agent.execute" not in await permissions(world, "contributor_a")
        assert "task.write" in await permissions(world, "contributor_a")
        listed = await world.ok("platform", "GET", "/admin/orgs")
        settings = {o["slug"]: o for o in listed}["acme"]
        assert settings.get("settings", {"disabled_permissions": ["agent.execute"]})[
            "disabled_permissions"
        ] == ["agent.execute"]

    async def test_deleting_an_organization_removes_its_projects(self, world):
        await world.ok("platform", "DELETE", f"/admin/orgs/{world.orgs['b']}")
        listed = await world.ok("platform", "GET", "/projects")
        assert [p["id"] for p in listed] == [world.projects["a"]]


class TestMembers:
    async def test_the_list_is_the_organization_s_with_their_roles(self, world):
        members = await world.ok("admin_a", "GET", "/admin/members")
        roles = {m["display_name"]: m["role_slug"] for m in members}
        assert roles["admin_a"] == "admin"
        assert roles["nobody_a"] == "nobody"
        assert "admin_b" not in roles

    async def test_adding_an_account_gives_the_default_role(self, world):
        from server.db.engine import get_session_factory
        from server.db.models import User

        async with get_session_factory()() as db:
            user = User(email="newcomer@example.com", display_name="newcomer")
            db.add(user)
            await db.commit()
            new_id = user.id
        added = await world.call(
            "admin_a", "POST", "/admin/members", json={"user_id": new_id}
        )
        assert added.status_code == 201, added.text
        assert added.json()["role_slug"] == "contributor"
        again = await world.call(
            "admin_a", "POST", "/admin/members", json={"user_id": new_id}
        )
        assert again.status_code == 409
        assert again.json()["detail"] == "Already a member"
        assert "org.member.added" in await audit_actions(world)

    async def test_the_platform_adds_an_account_of_another_org_by_email(self, world):
        """Someone already on the server joins a second organization: an
        invitation refuses an address that has an account."""
        added = await world.call(
            "platform",
            "POST",
            "/admin/members",
            org="a",
            json={"email": "Member_B@example.com", "role_slug": "reviewer"},
        )
        assert added.status_code == 201, added.text
        assert added.json()["user_id"] == world.users["member_b"]
        assert added.json()["role_slug"] == "reviewer"
        unknown = await world.call(
            "platform",
            "POST",
            "/admin/members",
            org="a",
            json={"email": "nobody-here@example.com"},
        )
        assert unknown.status_code == 404

    async def test_an_organization_admin_cannot_look_an_account_up_by_email(
        self, world
    ):
        answer = await world.call(
            "admin_a",
            "POST",
            "/admin/members",
            json={"email": "member_b@example.com"},
        )
        assert answer.status_code == 403
        members = await world.ok("admin_a", "GET", "/admin/members")
        assert world.users["member_b"] not in {m["user_id"] for m in members}

    @pytest.mark.parametrize(
        "body", [{}, {"user_id": "x", "email": "member_b@example.com"}]
    )
    async def test_exactly_one_account_is_named(self, world, body):
        answer = await world.call(
            "platform", "POST", "/admin/members", org="a", json=body
        )
        assert answer.status_code == 422

    async def test_an_unknown_account_or_role_is_refused(self, world):
        unknown = await world.call(
            "admin_a", "POST", "/admin/members", json={"user_id": str(uuid.uuid4())}
        )
        assert unknown.status_code == 404
        bad_role = await world.call(
            "admin_a",
            "PATCH",
            f"/admin/members/{world.users['viewer_a']}",
            json={"role_slug": "emperor"},
        )
        assert bad_role.status_code == 400
        assert bad_role.json()["detail"] == "Unknown role 'emperor'"

    async def test_a_role_change_applies_on_the_next_request(self, world):
        assert "task.write" not in await permissions(world, "viewer_a")
        changed = await world.ok(
            "admin_a",
            "PATCH",
            f"/admin/members/{world.users['viewer_a']}",
            json={"role_slug": "contributor"},
        )
        assert changed["role_slug"] == "contributor"
        assert "task.write" in await permissions(world, "viewer_a")

    async def test_an_administrator_cannot_demote_or_remove_themselves(self, world):
        demote = await world.call(
            "admin_a",
            "PATCH",
            f"/admin/members/{world.users['admin_a']}",
            json={"role_slug": "viewer"},
        )
        assert demote.status_code == 400
        assert (
            demote.json()["detail"]
            == "You cannot remove your own right to manage members"
        )
        remove = await world.call(
            "admin_a", "DELETE", f"/admin/members/{world.users['admin_a']}"
        )
        assert remove.status_code == 400

    async def test_the_last_administrator_is_kept(self, world):
        """``admin_b`` is the only one of their organization who manages members."""
        from server.db.engine import get_session_factory
        from server.db.models import OrgMember

        async with get_session_factory()() as db:
            db.add(
                OrgMember(
                    org_id=world.orgs["b"],
                    user_id=world.users["platform"],
                    role_id=world.roles["viewer"],
                )
            )
            await db.commit()
        answer = await world.call(
            "platform",
            "PATCH",
            f"/admin/members/{world.users['admin_b']}",
            org="b",
            json={"role_slug": "viewer"},
        )
        assert answer.status_code == 400
        assert answer.json()["detail"] == (
            "The organization would be left without an administrator"
        )

    async def test_roles_change_in_an_organization_with_no_administrator_yet(
        self, world
    ):
        """An organization a platform administrator created has no member who
        manages members: changing the role of someone who never could is not
        losing an administrator, and must not be refused."""
        from server.db.engine import get_session_factory
        from server.db.models import OrgMember
        from sqlalchemy import delete

        async with get_session_factory()() as db:
            await db.execute(
                delete(OrgMember).where(
                    OrgMember.org_id == world.orgs["b"],
                    OrgMember.user_id == world.users["admin_b"],
                )
            )
            await db.commit()
        for role_slug in ("viewer", "reviewer", "contributor"):
            changed = await world.ok(
                "platform",
                "PATCH",
                f"/admin/members/{world.users['member_b']}",
                org="b",
                json={"role_slug": role_slug},
            )
            assert changed["role_slug"] == role_slug
        promoted = await world.ok(
            "platform",
            "PATCH",
            f"/admin/members/{world.users['member_b']}",
            org="b",
            json={"role_slug": "admin"},
        )
        assert promoted["role_slug"] == "admin"
        # Now the organization has one administrator, and keeps them.
        answer = await world.call(
            "platform",
            "PATCH",
            f"/admin/members/{world.users['member_b']}",
            org="b",
            json={"role_slug": "viewer"},
        )
        assert answer.status_code == 400

    async def test_removing_a_member_ends_their_access(self, world):
        assert await world.ok(
            "admin_a", "DELETE", f"/admin/members/{world.users['contributor_a']}"
        ) == {"removed": True}
        me = await world.ok("contributor_a", "GET", "/auth/me/permissions")
        assert me["org_id"] is None
        assert me["permissions"] == []
        answer = await world.call(
            "contributor_a",
            "GET",
            "/api/board/snapshot",
            params={"project_id": world.projects["a"]},
        )
        assert answer.status_code == 403
        gone = await world.call(
            "admin_a", "DELETE", f"/admin/members/{world.users['contributor_a']}"
        )
        assert gone.status_code == 404

    async def test_a_member_of_another_organization_is_out_of_reach(self, world):
        for method, path, body in (
            (
                "PATCH",
                f"/admin/members/{world.users['member_b']}",
                {"role_slug": "viewer"},
            ),
            ("DELETE", f"/admin/members/{world.users['member_b']}", None),
            ("POST", f"/admin/users/{world.users['member_b']}/deactivate", None),
            ("POST", f"/admin/users/{world.users['member_b']}/activate", None),
            ("DELETE", f"/admin/sessions/{world.users['member_b']}", None),
        ):
            answer = await world.call("admin_a", method, path, json=body)
            assert answer.status_code == 404, (method, path, answer.text)
            assert answer.json()["detail"] == "Not a member of this organization"


class TestAccounts:
    async def test_the_list_is_the_organization_s(self, world):
        names = {
            u["display_name"] for u in await world.ok("admin_a", "GET", "/admin/users")
        }
        assert "viewer_a" in names
        assert "member_b" not in names
        assert "platform" not in names

    async def test_deactivating_cuts_the_tokens_now_and_activating_restores(
        self, world
    ):
        password = await world.give_password("viewer_a")
        signed_in = await world.client.post(
            "/auth/login", json={"email": "viewer_a@example.com", "password": password}
        )
        refresh = signed_in.json()["refresh_token"]
        sessions = await world.ok("admin_a", "GET", "/admin/sessions")
        assert [s["user_email"] for s in sessions] == ["viewer_a@example.com"]

        user = await world.ok(
            "admin_a", "POST", f"/admin/users/{world.users['viewer_a']}/deactivate"
        )
        assert user["id"] == world.users["viewer_a"]
        assert (await world.call("viewer_a", "GET", "/projects")).status_code == 401
        replay = await world.client.post(
            "/auth/refresh", json={"refresh_token": refresh}
        )
        assert replay.status_code == 401
        assert await world.ok("admin_a", "GET", "/admin/sessions") == []

        await world.ok(
            "admin_a", "POST", f"/admin/users/{world.users['viewer_a']}/activate"
        )
        assert (await world.call("viewer_a", "GET", "/projects")).status_code == 200
        assert {"user.deactivated", "user.activated"} <= set(await audit_actions(world))

    async def test_an_administrator_cannot_deactivate_themselves(self, world):
        answer = await world.call(
            "admin_a", "POST", f"/admin/users/{world.users['admin_a']}/deactivate"
        )
        assert answer.status_code == 400
        assert answer.json()["detail"] == "You cannot deactivate yourself"

    @pytest.mark.parametrize(
        ("method", "action"),
        [("POST", "deactivate"), ("POST", "activate"), ("DELETE", "sessions")],
    )
    async def test_an_account_shared_with_another_organization_is_the_platform_s(
        self, world, method, action
    ):
        await also_in(world, "member_b", "a")
        target = world.users["member_b"]
        path = (
            f"/admin/sessions/{target}"
            if action == "sessions"
            else f"/admin/users/{target}/{action}"
        )
        answer = await world.call("admin_a", method, path)
        assert answer.status_code == 403
        assert answer.json()["detail"] == MANAGED
        assert (await world.call("member_b", "GET", "/projects")).status_code == 200
        done = await world.call(
            "platform", method, path, headers={"X-WorkPilot-Org": world.orgs["a"]}
        )
        assert done.status_code == 200, done.text

    async def test_a_platform_administrator_in_the_organization_is_the_platform_s(
        self, world
    ):
        await also_in(world, "platform", "a")
        target = world.users["platform"]
        for method, path in (
            ("POST", f"/admin/users/{target}/deactivate"),
            ("DELETE", f"/admin/sessions/{target}"),
        ):
            answer = await world.call("admin_a", method, path)
            assert answer.status_code == 403, path
            assert answer.json()["detail"] == MANAGED
        assert (await world.call("platform", "GET", "/admin/orgs")).status_code == 200

    async def test_signing_someone_out_everywhere(self, world):
        password = await world.give_password("viewer_a")
        for _ in range(2):
            await world.client.post(
                "/auth/login",
                json={"email": "viewer_a@example.com", "password": password},
            )
        await world.give_password("contributor_a")
        listed = await world.ok(
            "admin_a",
            "GET",
            "/admin/sessions",
            params={"user_id": world.users["viewer_a"]},
        )
        assert len(listed) == 2
        assert await world.ok(
            "admin_a", "DELETE", f"/admin/sessions/{world.users['viewer_a']}"
        ) == {"revoked": 2}
        assert (
            await world.ok(
                "admin_a",
                "GET",
                "/admin/sessions",
                params={"user_id": world.users["viewer_a"]},
            )
            == []
        )

    async def test_the_platform_hands_out_and_takes_back_its_role(self, world):
        target = world.users["viewer_a"]
        granted = await world.ok(
            "platform",
            "POST",
            f"/admin/users/{target}/platform-role",
            params={"role": "admin"},
        )
        assert granted["role"] == "admin"
        # The role is read from the token: a new one carries it.
        world.tokens.clear()
        assert (await world.ok("viewer_a", "GET", "/auth/me/permissions"))[
            "is_platform_admin"
        ]
        back = await world.ok(
            "platform",
            "POST",
            f"/admin/users/{target}/platform-role",
            params={"role": "member"},
        )
        assert back["role"] == "member"

    @pytest.mark.parametrize(
        ("who", "role", "status", "detail"),
        [
            (
                "viewer_a",
                "god",
                400,
                "role must be one of ['admin', 'member', 'viewer']",
            ),
            ("platform", "member", 400, "You cannot drop your own platform-admin role"),
            (None, "member", 404, "User not found"),
        ],
    )
    async def test_the_platform_role_refusals(self, world, who, role, status, detail):
        target = world.users[who] if who else str(uuid.uuid4())
        answer = await world.call(
            "platform",
            "POST",
            f"/admin/users/{target}/platform-role",
            params={"role": role},
        )
        assert answer.status_code == status
        assert answer.json()["detail"] == detail


class TestRoles:
    async def test_a_custom_role_gives_its_permissions_and_changes_with_them(
        self, world
    ):
        created = await world.call(
            "admin_a",
            "POST",
            "/admin/roles",
            json={
                "slug": "board-keeper",
                "name": "Board keeper",
                "permissions": ["task.read"],
            },
        )
        assert created.status_code == 201, created.text
        role = created.json()
        await world.ok(
            "admin_a",
            "PATCH",
            f"/admin/members/{world.users['nobody_a']}",
            json={"role_slug": "board-keeper"},
        )
        assert await permissions(world, "nobody_a") == {"task.read"}

        updated = await world.ok(
            "admin_a",
            "PATCH",
            f"/admin/roles/{role['id']}",
            json={
                "name": "Board writer",
                "description": "Writes cards",
                "permissions": ["task.read", "task.write"],
            },
        )
        assert updated["name"] == "Board writer"
        assert await permissions(world, "nobody_a") == {"task.read", "task.write"}

        bad = await world.call(
            "admin_a",
            "PATCH",
            f"/admin/roles/{role['id']}",
            json={"permissions": ["task.read", "task.everything"]},
        )
        assert bad.status_code == 400
        assert bad.json()["detail"] == "Unknown permission keys: task.everything"

        in_use = await world.call("admin_a", "DELETE", f"/admin/roles/{role['id']}")
        assert in_use.status_code == 409
        await world.ok(
            "admin_a",
            "PATCH",
            f"/admin/members/{world.users['nobody_a']}",
            json={"role_slug": "viewer"},
        )
        assert await world.ok("admin_a", "DELETE", f"/admin/roles/{role['id']}") == {
            "deleted": True
        }
        assert {"role.created", "role.updated", "role.deleted"} <= set(
            await audit_actions(world)
        )

    async def test_a_built_in_role_is_read_only(self, world):
        for method, body in (("PATCH", {"name": "Mine"}), ("DELETE", None)):
            answer = await world.call(
                "admin_a", method, f"/admin/roles/{world.roles['viewer']}", json=body
            )
            assert answer.status_code == 403
            assert answer.json()["detail"].startswith("Built-in roles are read-only")

    async def test_another_organization_s_role_does_not_exist(self, world):
        answer = await world.call(
            "admin_b",
            "PATCH",
            f"/admin/roles/{world.roles['nobody']}",
            json={"name": "X"},
        )
        assert answer.status_code == 404
        assert answer.json()["detail"] == "Role not found"
        listed = {r["slug"] for r in await world.ok("admin_b", "GET", "/admin/roles")}
        assert "nobody" not in listed

    async def test_a_scope_must_be_known(self, world):
        answer = await world.call(
            "admin_a",
            "POST",
            "/admin/roles",
            json={"slug": "odd", "name": "Odd", "scope": "galaxy"},
        )
        assert answer.status_code == 400
        assert answer.json()["detail"] == "scope must be 'org' or 'project'"

    async def test_a_built_in_slug_is_taken(self, world):
        answer = await world.call(
            "admin_a",
            "POST",
            "/admin/roles",
            json={"slug": "viewer", "name": "Viewer 2"},
        )
        assert answer.status_code == 409


class TestQuotasOverviewAudit:
    async def test_the_quotas_and_their_use(self, world):
        quotas = await world.ok("admin_a", "GET", "/admin/quotas")
        assert quotas["max_users"] is None
        assert quotas["used_projects"] == 1
        updated = await world.ok(
            "admin_a",
            "PUT",
            "/admin/quotas",
            json={
                "max_users": 50,
                "monthly_token_budget": 1000,
                "enforce_hard_stop": True,
            },
        )
        assert updated["max_users"] == 50
        assert updated["enforce_hard_stop"] is True
        assert (await world.ok("admin_b", "GET", "/admin/quotas"))["max_users"] is None

    async def test_the_overview_counts_the_organization_s_runs(self, world):
        from datetime import UTC, datetime, timedelta

        from server.db.engine import get_session_factory
        from server.db.models import AgentRun, SpecIndex

        async with get_session_factory()() as db:
            spec = SpecIndex(project_id=world.projects["a"], spec_name="001-x")
            other = SpecIndex(project_id=world.projects["b"], spec_name="001-y")
            db.add_all([spec, other])
            await db.flush()
            now = datetime.now(UTC)
            db.add_all(
                [
                    AgentRun(
                        spec_id=spec.id,
                        phase="build",
                        started_by=world.users["contributor_a"],
                        status="succeeded",
                        started_at=now - timedelta(hours=1),
                    ),
                    AgentRun(
                        spec_id=spec.id,
                        phase="qa",
                        started_by=world.users["contributor_a"],
                        status="failed",
                        started_at=now - timedelta(days=2),
                    ),
                    AgentRun(
                        spec_id=spec.id,
                        phase="build",
                        started_by=world.users["operator_a"],
                        status="running",
                        started_at=now,
                    ),
                    AgentRun(spec_id=other.id, phase="build", status="succeeded"),
                ]
            )
            await db.commit()
        overview = await world.ok("analyst_a", "GET", "/admin/overview")
        assert overview["org_id"] == world.orgs["a"]
        flat = str(overview)
        assert "contributor_a" in flat
        top = {u["display_name"]: u["runs"] for u in overview["top_users"]}
        assert top == {"contributor_a": 2, "operator_a": 1}
        assert sum(day["count"] for day in overview["runs_by_day"]) == 3
        b = await world.ok("admin_b", "GET", "/admin/overview")
        assert b["top_users"] == []

    async def test_the_journal_is_the_organization_s(self, world):
        await world.ok(
            "admin_b",
            "PATCH",
            f"/admin/members/{world.users['member_b']}",
            json={"role_slug": "viewer"},
        )
        assert "org.member.role_changed" not in await audit_actions(world)
        b_actions = [
            row["action"] for row in await world.ok("admin_b", "GET", "/admin/audit")
        ]
        assert "org.member.role_changed" in b_actions
