"""Approving a card by as many people as its criticality asks.

Over HTTP through the real middleware, on the seeded deployment: project A has
several people who may approve (``owner_a``, ``maintainer_a``, ``reviewer_a``),
project B one (``admin_b``, whose teammate ``member_b`` is a contributor).
"""

from __future__ import annotations

import json
from pathlib import Path

from tests.server_routes.world import World


def settings(monkeypatch, **values: str | None) -> None:
    from server import config as server_config

    for key, value in values.items():
        name = f"WORKPILOT_{key.upper()}"
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    server_config.reset_settings_cache()


def params(world: World, side: str = "a") -> dict[str, str]:
    return {"project_id": world.projects[side]}


async def new_card(
    world: World, who: str, side: str = "a", require_review: bool = True
) -> str:
    card = await world.ok(
        who,
        "POST",
        "/api/board/cards",
        params=params(world, side),
        json={"title": f"Card of {who}", "require_review": require_review},
    )
    directory = card_dir(world, side, card["id"])
    (directory / "spec.md").write_text("# Spec\n", encoding="utf-8")
    return card["id"]


def card_dir(world: World, side: str, card_id: str) -> Path:
    return world.clone(side) / ".workpilot" / "specs" / card_id


def build_may_start(world: World, side: str, card_id: str) -> bool:
    from review.state import ReviewState

    directory = card_dir(world, side, card_id)
    return ReviewState.load(directory).is_approval_valid(directory)


async def approve(world: World, who: str, card_id: str, side: str = "a"):
    return await world.call(
        who, "POST", f"/api/board/cards/{card_id}/approve", params=params(world, side)
    )


async def status(world: World, card_id: str, side: str = "a") -> dict:
    return await world.ok(
        "viewer_a" if side == "a" else "member_b",
        "GET",
        f"/api/board/cards/{card_id}/approvals",
        params=params(world, side),
    )


async def set_criticality(world: World, who: str, card_id: str, level: str):
    return await world.call(
        who,
        "PUT",
        f"/api/board/cards/{card_id}/criticality",
        params=params(world),
        json={"criticality": level},
    )


async def test_a_card_waits_for_as_many_approvals_as_it_needs(world, monkeypatch):
    settings(monkeypatch, approval_quorum="medium=2")
    card = await new_card(world, "contributor_a")

    first = (await approve(world, "reviewer_a", card)).json()
    assert first["approved"] is False and first["approvedBy"] is None
    assert first["approval"]["count"] == 1 and first["approval"]["needed"] == 2
    assert not build_may_start(world, "a", card)
    # The same person again adds nothing.
    again = (await approve(world, "reviewer_a", card)).json()
    assert again["approval"]["count"] == 1

    second = (await approve(world, "maintainer_a", card)).json()
    assert second["approved"] is True
    assert second["approvedBy"] == "reviewer_a, maintainer_a"
    assert build_may_start(world, "a", card)
    seen = await status(world, card)
    assert [a["by"] for a in seen["approvals"]] == ["reviewer_a", "maintainer_a"]
    assert seen["complete"] is True and seen["approved"] is True
    assert seen["criticality"] == "medium" and seen["criticalitySource"] == "default"


async def test_an_edit_voids_the_approvals_given_before(world, monkeypatch):
    settings(monkeypatch, approval_quorum="medium=2")
    card = await new_card(world, "contributor_a")
    await approve(world, "reviewer_a", card)
    (card_dir(world, "a", card) / "spec.md").write_text("# Other\n", encoding="utf-8")
    assert (await status(world, card))["count"] == 0
    assert (await approve(world, "maintainer_a", card)).json()["approved"] is False


async def test_a_criticality_may_ask_for_a_role(world, monkeypatch):
    settings(
        monkeypatch, approval_quorum="medium=2", approval_roles="medium=maintainer"
    )
    card = await new_card(world, "contributor_a")
    await approve(world, "reviewer_a", card)
    two = (await approve(world, "owner_a", card)).json()
    assert two["approved"] is False
    assert two["approval"]["missingRoles"] == ["maintainer"]
    done = (await approve(world, "maintainer_a", card)).json()
    assert done["approved"] is True and done["approval"]["missingRoles"] == []


async def test_the_author_adds_theirs_while_the_others_are_too_few(world, monkeypatch):
    from server.db.engine import get_session_factory
    from server.db.models import OrgMember
    from sqlalchemy import select

    settings(monkeypatch, approval_quorum="medium=2")
    card = await new_card(world, "admin_b", "b")
    # Alone: their approval counts, and the card waits for a second one.
    alone = (await approve(world, "admin_b", card, "b")).json()
    assert alone["approved"] is False and alone["approval"]["count"] == 1

    async with get_session_factory()() as db:
        member = await db.scalar(
            select(OrgMember).where(OrgMember.user_id == world.users["member_b"])
        )
        member.role_id = world.roles["reviewer"]
        await db.commit()
    second = await new_card(world, "admin_b", "b")
    # One teammate cannot reach two approvals alone: the author's still counts.
    assert (await approve(world, "admin_b", second, "b")).status_code == 200
    done = (await approve(world, "member_b", second, "b")).json()
    assert done["approved"] is True


async def test_going_without_review_needs_an_approval_that_is_enough(
    world, monkeypatch
):
    settings(monkeypatch, approval_quorum="medium=2")
    card = await world.ok(
        "admin_b",
        "POST",
        "/api/board/cards",
        params=params(world, "b"),
        json={"title": "Alone", "require_review": False},
    )
    meta = card_dir(world, "b", card["id"]) / "task_metadata.json"
    assert json.loads(meta.read_text(encoding="utf-8"))["requireReviewBeforeCoding"]

    settings(monkeypatch, approval_quorum=None, approval_roles="medium=maintainer")
    other = await world.ok(
        "admin_b",
        "POST",
        "/api/board/cards",
        params=params(world, "b"),
        json={"title": "Alone again", "require_review": False},
    )
    meta = card_dir(world, "b", other["id"]) / "task_metadata.json"
    # admin_b is no maintainer: their approval alone does not meet the role.
    assert json.loads(meta.read_text(encoding="utf-8"))["requireReviewBeforeCoding"]

    settings(monkeypatch, approval_roles="medium=admin")
    held = await world.ok(
        "admin_b",
        "POST",
        "/api/board/cards",
        params=params(world, "b"),
        json={"title": "Alone, with the role", "require_review": False},
    )
    meta = card_dir(world, "b", held["id"]) / "task_metadata.json"
    assert not json.loads(meta.read_text(encoding="utf-8"))["requireReviewBeforeCoding"]


async def test_a_change_request_is_one_of_the_approvals(world, monkeypatch):
    settings(monkeypatch, approval_quorum="medium=2")
    card = await new_card(world, "contributor_a")
    (world.clone("a") / ".workpilot" / "worktrees" / "tasks" / card).mkdir(parents=True)
    sent = await world.ok(
        "reviewer_a",
        "POST",
        f"/api/board/cards/{card}/request-changes",
        params=params(world),
        json={"feedback": "Keep the old button"},
    )
    assert sent == {"requested": True, "approved": False}
    assert (await approve(world, "maintainer_a", card)).json()["approved"] is True


async def test_criticality_sets_the_quorum(world, monkeypatch):
    settings(monkeypatch, approval_quorum="low=1,medium=2,high=3")
    card = await new_card(world, "contributor_a")
    await approve(world, "reviewer_a", card)
    assert not build_may_start(world, "a", card)

    # Lowering it completes the approval already given.
    low = (await set_criticality(world, "maintainer_a", card, "low")).json()
    assert low["criticality"] == "low" and low["criticalitySource"] == "set"
    assert low["approved"] is True and build_may_start(world, "a", card)

    # Raising it voids an approval that is no longer enough.
    high = (await set_criticality(world, "maintainer_a", card, "high")).json()
    assert high["needed"] == 3 and high["approved"] is False
    assert not build_may_start(world, "a", card)
    # Raising it again while it waits changes nothing else.
    assert (await set_criticality(world, "owner_a", card, "high")).status_code == 200


async def test_criticality_belongs_to_approvers(world, monkeypatch):
    card = await new_card(world, "maintainer_a")
    refused = await set_criticality(world, "contributor_a", card, "high")
    assert refused.status_code == 403
    assert refused.json()["detail"] == "Missing permission: review.approve"
    bad = await set_criticality(world, "maintainer_a", card, "urgent")
    assert bad.status_code == 422
    # Its author does not lower it while teammates approve...
    own = await set_criticality(world, "maintainer_a", card, "low")
    assert own.status_code == 403
    assert own.json()["detail"] == (
        "Someone else lowers the criticality of a card you created"
    )
    # ...but raises it, and a teammate lowers it.
    assert (await set_criticality(world, "maintainer_a", card, "high")).is_success
    assert (await set_criticality(world, "reviewer_a", card, "low")).is_success


async def test_the_spec_assessment_only_raises_it(world):
    card = await new_card(world, "contributor_a")
    assessment = card_dir(world, "a", card) / "complexity_assessment.json"
    assessment.write_text(json.dumps({"complexity": "simple"}), encoding="utf-8")
    assert (await status(world, card))["criticality"] == "medium"
    assessment.write_text(json.dumps({"complexity": "complex"}), encoding="utf-8")
    seen = await status(world, card)
    assert seen["criticality"] == "high" and seen["criticalitySource"] == "assessed"


async def test_approvals_and_criticality_are_audited(world, monkeypatch):
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog
    from sqlalchemy import select

    card = await new_card(world, "contributor_a")
    await set_criticality(world, "reviewer_a", card, "high")
    await approve(world, "reviewer_a", card)
    async with get_session_factory()() as db:
        rows = list(
            await db.scalars(select(AuditLog).where(AuditLog.action.like("review.%")))
        )
    by_action = {row.action: row for row in rows}
    assert by_action["review.criticality.set"].payload == {
        "spec": card,
        "from": "medium",
        "to": "high",
    }
    approved = by_action["review.approved"]
    assert approved.org_id == world.orgs["a"]
    assert approved.payload["criticality"] == "high"
    assert approved.payload["complete"] is True


async def test_without_the_right_a_card_is_not_approved(world):
    card = await new_card(world, "maintainer_a")
    refused = await approve(world, "contributor_a", card)
    assert refused.status_code == 403
    assert refused.json()["detail"] == "Missing permission: review.approve"
