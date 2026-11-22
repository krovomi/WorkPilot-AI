"""A person who leaves ends the approvals they lent or hold.

Deactivating an account, removing a member from the organization or from the
project ends every open delegation that person lent or was lent there, in the
same transaction as the removal and with a count in its audit entry. On the
seeded deployment's project A, ``reviewer_a`` and ``maintainer_a`` approve and
``contributor_a`` writes without approving.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from tests.server_routes.world import World


def params(world: World) -> dict[str, str]:
    return {"project_id": world.projects["a"]}


async def lend(world: World, who: str, to: str) -> str:
    ends = (datetime.now(UTC) + timedelta(days=7)).isoformat()
    lent = await world.ok(
        who,
        "POST",
        "/api/board/delegations",
        params=params(world),
        json={"to_user_id": world.users[to], "ends_at": ends},
    )
    return lent["id"]


async def open_delegations(world: World) -> set[str]:
    rows = await world.ok(
        "viewer_a", "GET", "/api/board/delegations", params=params(world)
    )
    return {row["id"] for row in rows}


async def payload_of(action: str) -> dict:
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog
    from sqlalchemy import select

    async with get_session_factory()() as db:
        return await db.scalar(
            select(AuditLog.payload).where(AuditLog.action == action)
        )


async def test_a_deactivated_account_ends_what_it_holds(world):
    await lend(world, "reviewer_a", "contributor_a")
    await lend(world, "maintainer_a", "contributor_a")
    answer = await world.call(
        "admin_a", "POST", f"/admin/users/{world.users['contributor_a']}/deactivate"
    )
    assert answer.status_code == 200, answer.text
    assert await open_delegations(world) == set()
    assert (await payload_of("user.deactivated"))["delegations_ended"] == 2


async def test_an_approver_removed_from_the_organization_ends_what_they_lent(world):
    lent = await lend(world, "reviewer_a", "contributor_a")
    kept = await lend(world, "maintainer_a", "contributor_a")
    assert await open_delegations(world) == {lent, kept}
    answer = await world.call(
        "admin_a", "DELETE", f"/admin/members/{world.users['reviewer_a']}"
    )
    assert answer.status_code == 200, answer.text
    assert await open_delegations(world) == {kept}
    assert (await payload_of("org.member.removed"))["delegations_ended"] == 1


async def test_a_delegate_removed_from_the_project_ends_what_they_hold(world):
    await lend(world, "reviewer_a", "contributor_a")
    answer = await world.call(
        "owner_a",
        "DELETE",
        f"/projects/{world.projects['a']}/members/{world.users['contributor_a']}",
    )
    assert answer.status_code == 200, answer.text
    assert await open_delegations(world) == set()
    assert (await payload_of("project.member.removed"))["delegations_ended"] == 1
