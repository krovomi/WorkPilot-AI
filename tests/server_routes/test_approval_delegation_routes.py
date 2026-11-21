"""Lending one's approval on a project for a while.

Over HTTP through the real middleware, on the seeded deployment's project A:
``reviewer_a`` and ``maintainer_a`` approve, ``contributor_a`` does not,
``viewer_a`` only reads it and ``stranger_a`` is not on it.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from tests.server_routes.world import World

OWN_CARD = "Someone else approves the spec of a card you created"
MISSING = "Missing permission: review.approve"


def params(world: World) -> dict[str, str]:
    return {"project_id": world.projects["a"]}


def later(**delta: float) -> str:
    return (datetime.now(UTC) + timedelta(**delta)).isoformat()


async def lend(world: World, who: str, to: str, **body):
    return await world.call(
        who,
        "POST",
        "/api/board/delegations",
        params=params(world),
        json={"to_user_id": world.users[to], "ends_at": later(days=7), **body},
    )


async def new_card(world: World, who: str) -> str:
    card = await world.ok(
        who, "POST", "/api/board/cards", params=params(world), json={"title": "T"}
    )
    spec = world.clone("a") / ".workpilot" / "specs" / card["id"] / "spec.md"
    spec.write_text("# Spec\n", encoding="utf-8")
    return card["id"]


async def approve(world: World, who: str, card_id: str):
    return await world.call(
        who, "POST", f"/api/board/cards/{card_id}/approve", params=params(world)
    )


async def test_a_delegate_approves_in_the_approver_s_name(world):
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog
    from sqlalchemy import select

    lent = await lend(world, "reviewer_a", "contributor_a")
    assert lent.status_code == 201
    body = lent.json()
    assert (
        body["from"]["name"] == "reviewer_a" and body["to"]["name"] == "contributor_a"
    )
    assert body["active"] is True

    card = await new_card(world, "maintainer_a")
    answer = await approve(world, "contributor_a", card)
    assert answer.status_code == 200 and answer.json()["approved"] is True
    given = answer.json()["approval"]["approvals"]
    assert given[0]["by"] == "contributor_a" and given[0]["for"] == "reviewer_a"
    assert "reviewer" in given[0]["roles"]
    assert answer.json()["approvedBy"] == "contributor_a for reviewer_a"
    # The approver's place is filled: their own approval adds nothing.
    again = await approve(world, "reviewer_a", card)
    assert again.json()["approval"]["count"] == 1

    async with get_session_factory()() as db:
        actions = {
            row.action: row.payload
            for row in await db.scalars(
                select(AuditLog).where(AuditLog.action.like("review.%"))
            )
        }
    assert actions["review.approved"]["acting_for"] == world.users["reviewer_a"]
    assert actions["review.delegation.created"]["to"] == world.users["contributor_a"]


async def test_a_delegate_neither_lends_it_on_nor_sets_a_criticality(world):
    await lend(world, "reviewer_a", "contributor_a")
    onward = await lend(world, "contributor_a", "operator_a")
    assert onward.status_code == 403 and onward.json()["detail"] == MISSING
    card = await new_card(world, "maintainer_a")
    level = await world.call(
        "contributor_a",
        "PUT",
        f"/api/board/cards/{card}/criticality",
        params=params(world),
        json={"criticality": "low"},
    )
    assert level.status_code == 403


async def test_standing_in_for_the_author_is_the_author_approving(world):
    await lend(world, "maintainer_a", "contributor_a")
    card = await new_card(world, "maintainer_a")
    refused = await approve(world, "contributor_a", card)
    assert refused.status_code == 403 and refused.json()["detail"] == OWN_CARD


async def test_a_delegation_lends_only_while_it_runs(world):
    from server.db.engine import get_session_factory
    from server.db.models import OrgMember
    from sqlalchemy import select

    card = await new_card(world, "maintainer_a")
    soon = await lend(world, "reviewer_a", "contributor_a", starts_at=later(days=1))
    assert soon.json()["active"] is False
    assert (await approve(world, "contributor_a", card)).status_code == 403

    now = await lend(world, "maintainer_a", "contributor_a")
    assert (await approve(world, "contributor_a", card)).status_code == 403  # own card
    await world.call(
        "maintainer_a",
        "DELETE",
        f"/api/board/delegations/{now.json()['id']}",
        params=params(world),
    )
    await lend(world, "owner_a", "contributor_a")
    assert (await approve(world, "contributor_a", card)).status_code == 200

    # An approver who can no longer approve lends nothing.
    async with get_session_factory()() as db:
        owner = await db.scalar(
            select(OrgMember).where(OrgMember.user_id == world.users["owner_a"])
        )
        owner.role_id = world.roles["viewer"]
        await db.commit()
    other = await new_card(world, "maintainer_a")
    refused = await approve(world, "contributor_a", other)
    assert refused.status_code == 403 and refused.json()["detail"] == MISSING


async def test_the_oldest_delegation_on_a_project_counts(world):
    await lend(world, "reviewer_a", "contributor_a")
    await lend(world, "maintainer_a", "contributor_a")
    card = await new_card(world, "owner_a")
    given = (await approve(world, "contributor_a", card)).json()
    assert given["approval"]["approvals"][0]["for"] == "reviewer_a"


async def test_what_a_delegation_may_be(world):
    async def refused(to: str, status: int = 422, **body) -> None:
        answer = await lend(world, "reviewer_a", to, **body)
        assert answer.status_code == status, answer.text

    await refused("reviewer_a")  # oneself
    await refused("stranger_a")  # not on the project
    await refused("viewer_a")  # reads it only
    await refused("contributor_a", ends_at=later(days=-1))
    await refused("contributor_a", starts_at=later(days=3), ends_at=later(days=2))
    await refused("contributor_a", ends_at=later(days=91))
    await refused("contributor_a", starts_at=later(days=400), ends_at=later(days=401))
    naive = (datetime.now(UTC) + timedelta(days=1)).replace(tzinfo=None).isoformat()
    assert (await lend(world, "reviewer_a", "contributor_a", ends_at=naive)).is_success
    for _ in range(4):
        assert (await lend(world, "reviewer_a", "operator_a")).is_success
    await refused("grouped_a", 409)


async def test_an_inactive_colleague_is_not_lent_it(world):
    from server.db.engine import get_session_factory
    from server.db.models import User

    async with get_session_factory()() as db:
        person = await db.get(User, world.users["contributor_a"])
        person.is_active = False
        await db.commit()
    assert (await lend(world, "reviewer_a", "contributor_a")).status_code == 422


async def test_listing_and_ending_delegations(world):
    lent = (await lend(world, "reviewer_a", "contributor_a")).json()
    listed = await world.ok(
        "viewer_a", "GET", "/api/board/delegations", params=params(world)
    )
    assert [d["id"] for d in listed] == [lent["id"]]

    async def end(who: str, delegation: str, side: str = "a"):
        return await world.call(
            who,
            "DELETE",
            f"/api/board/delegations/{delegation}",
            params={"project_id": world.projects[side]},
        )

    # Not someone else's approver; an owner of the organization may.
    other = await end("maintainer_a", lent["id"])
    assert other.status_code == 403 and other.json()["detail"] == (
        "Only its approver ends it"
    )
    assert (await end("admin_b", lent["id"], "b")).status_code == 404
    assert (await end("owner_a", lent["id"])).json() == {"revoked": lent["id"]}
    assert (await end("owner_a", lent["id"])).status_code == 404
    assert (await end("owner_a", "nope")).status_code == 404
    empty = await world.ok(
        "viewer_a", "GET", "/api/board/delegations", params=params(world)
    )
    assert empty == []
