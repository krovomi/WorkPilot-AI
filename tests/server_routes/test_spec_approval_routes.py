"""Approving the spec of a card one created (``WORKPILOT_SELF_APPROVAL``).

Over HTTP through the real middleware, on the seeded deployment: project A has
several people who may approve (``owner_a``, ``maintainer_a``, ``reviewer_a``),
project B one (``admin_b``, whose only teammate is a contributor).
"""

from __future__ import annotations

import asyncio
import json
import textwrap
from pathlib import Path

import pytest

from tests.server_routes.world import World

OWN_CARD = "Someone else approves the spec of a card you created"


def policy(monkeypatch, value: str | None) -> None:
    from server import config as server_config

    if value is None:
        monkeypatch.delenv("WORKPILOT_SELF_APPROVAL", raising=False)
    else:
        monkeypatch.setenv("WORKPILOT_SELF_APPROVAL", value)
    server_config.reset_settings_cache()


async def new_card(world: World, who: str, side: str, require_review: bool = True):
    card = await world.ok(
        who,
        "POST",
        "/api/board/cards",
        params={"project_id": world.projects[side]},
        json={"title": f"Card of {who}", "require_review": require_review},
    )
    return card["id"]


def card_dir(world: World, side: str, card_id: str) -> Path:
    return world.clone(side) / ".workpilot" / "specs" / card_id


def with_spec(world: World, side: str, card_id: str) -> None:
    (card_dir(world, side, card_id) / "spec.md").write_text(
        "# Spec\n", encoding="utf-8"
    )


def asks_review(world: World, side: str, card_id: str) -> bool:
    meta = card_dir(world, side, card_id) / "task_metadata.json"
    return json.loads(meta.read_text(encoding="utf-8"))["requireReviewBeforeCoding"]


async def approve(world: World, who: str, side: str, card_id: str):
    return await world.call(
        who,
        "POST",
        f"/api/board/cards/{card_id}/approve",
        params={"project_id": world.projects[side]},
    )


async def test_by_default_a_teammate_approves_ones_card(world):
    card = await new_card(world, "maintainer_a", "a")
    with_spec(world, "a", card)
    own = await approve(world, "maintainer_a", "a", card)
    assert own.status_code == 403
    assert own.json()["detail"] == OWN_CARD
    assert (await approve(world, "reviewer_a", "a", card)).status_code == 200


async def test_alone_on_a_project_one_approves_ones_card(world):
    card = await new_card(world, "admin_b", "b")
    with_spec(world, "b", card)
    assert (await approve(world, "admin_b", "b", card)).status_code == 200


async def test_the_deployment_allows_or_denies_it(world, monkeypatch):
    policy(monkeypatch, "allow")
    card = await new_card(world, "maintainer_a", "a")
    with_spec(world, "a", card)
    assert (await approve(world, "maintainer_a", "a", card)).status_code == 200

    policy(monkeypatch, "deny")
    alone = await new_card(world, "admin_b", "b")
    with_spec(world, "b", alone)
    refused = await approve(world, "admin_b", "b", alone)
    assert refused.status_code == 403 and refused.json()["detail"] == OWN_CARD


async def test_going_without_a_review_follows_the_same_rule(world, monkeypatch):
    # With teammates who approve, one's card asks for their review.
    team = await new_card(world, "maintainer_a", "a", require_review=False)
    assert asks_review(world, "a", team) is True
    # Alone, one may go without.
    alone = await new_card(world, "admin_b", "b", require_review=False)
    assert asks_review(world, "b", alone) is False
    # Without the approval right, never.
    contributor = await new_card(world, "contributor_a", "a", require_review=False)
    assert asks_review(world, "a", contributor) is True
    policy(monkeypatch, "allow")
    allowed = await new_card(world, "maintainer_a", "a", require_review=False)
    assert asks_review(world, "a", allowed) is False


async def test_a_change_request_on_ones_card_waits_for_a_teammate(world):
    from review.state import ReviewState

    card = await new_card(world, "maintainer_a", "a")
    with_spec(world, "a", card)
    (world.clone("a") / ".workpilot" / "worktrees" / "tasks" / card).mkdir(parents=True)
    directory = card_dir(world, "a", card)

    async def request_changes(who: str):
        return await world.ok(
            who,
            "POST",
            f"/api/board/cards/{card}/request-changes",
            params={"project_id": world.projects["a"]},
            json={"feedback": "Keep the old button"},
        )

    assert await request_changes("maintainer_a") == {
        "requested": True,
        "approved": False,
    }
    assert not ReviewState.load(directory).is_approval_valid(directory)
    assert await request_changes("reviewer_a") == {"requested": True, "approved": True}
    assert ReviewState.load(directory).is_approval_valid(directory)


AGENT = textwrap.dedent(
    """
    import json, sys
    from pathlib import Path

    args = sys.argv[1:]
    project = Path(args[args.index("--project-dir") + 1])
    with open(project / "agent-calls.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(args) + "\\n")
    """
)


@pytest.fixture
def agent(tmp_path, monkeypatch) -> None:
    from server.services import run_manager

    backend = tmp_path / "fake-backend"
    (backend / "runners").mkdir(parents=True)
    (backend / "runners" / "spec_runner.py").write_text(AGENT, encoding="utf-8")
    monkeypatch.setattr(run_manager, "BACKEND_DIR", backend)
    monkeypatch.setenv("WORKPILOT_RUN_ISOLATION", "off")


async def spec_run_args(world: World, who: str, card: str) -> list[str]:
    base = f"/projects/{world.projects['a']}/specs"
    listed = await world.ok(who, "GET", base)
    spec_id = next(s["id"] for s in listed if s["spec_name"] == card)
    await world.ok(who, "POST", f"{base}/{spec_id}/runs", json={"phase": "spec"})
    calls = world.clone("a") / "agent-calls.jsonl"
    for _ in range(200):
        runs = await world.ok(who, "GET", f"{base}/{spec_id}/runs")
        if runs and runs[0]["finished_at"]:
            break
        await asyncio.sleep(0.05)
    lines = calls.read_text(encoding="utf-8").splitlines()
    calls.unlink()
    return json.loads(lines[-1])


async def test_a_spec_run_goes_without_review_only_as_the_rule_allows(
    world, monkeypatch, agent
):
    policy(monkeypatch, "allow")
    card = await new_card(world, "owner_a", "a", require_review=False)
    policy(monkeypatch, None)
    # Its author, with teammates who approve: the build waits for them.
    assert "--no-build" in await spec_run_args(world, "owner_a", card)
    assert asks_review(world, "a", card) is True


async def test_a_teammate_may_start_ones_card_without_review(world, monkeypatch, agent):
    policy(monkeypatch, "allow")
    card = await new_card(world, "owner_a", "a", require_review=False)
    policy(monkeypatch, None)
    assert "--auto-approve" in await spec_run_args(world, "maintainer_a", card)


async def test_who_counts_as_another_approver(world):
    from server.authz import self_approval
    from server.db.engine import get_session_factory
    from server.db.models import OrgMember, User
    from sqlalchemy import select

    async with get_session_factory()() as db:
        candidates = await self_approval._candidates(
            db, world.projects["a"], world.orgs["a"], world.users["owner_a"]
        )
        # Writers on the project, directly or by a group; not its viewers,
        # nor people of the organization who are not on it.
        assert set(candidates) == {
            world.users[k]
            for k in (
                "maintainer_a",
                "contributor_a",
                "reviewer_a",
                "operator_a",
                "nobody_a",
                "grouped_a",
            )
        }
        ids = {"project_id": world.projects["b"], "org_id": world.orgs["b"]}
        assert not await self_approval.another_approver(
            db, **ids, user_id=world.users["admin_b"]
        )
        member = await db.scalar(
            select(OrgMember).where(OrgMember.user_id == world.users["member_b"])
        )
        member.role_id = world.roles["reviewer"]
        await db.commit()
        assert await self_approval.another_approver(
            db, **ids, user_id=world.users["admin_b"]
        )
        person = await db.get(User, world.users["member_b"])
        person.is_active = False
        await db.commit()
        assert not await self_approval.another_approver(
            db, **ids, user_id=world.users["admin_b"]
        )
