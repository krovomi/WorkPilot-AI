"""A member's rejection of a review finding reaches the maintainers (#361).

On the seeded deployment (``world.py``), project A's maintainers are its
owners (``owner_a``, and ``maintainer_a`` whose project role is owner) and
the organization's administrator who is not on it (``admin_a``). A member
(``contributor_a``) rejects a finding of a saved review: the rejection is
held, and the first one of a wait tells the maintainers on their "needs you"
channels. Nothing leaves the test: the channels post to a mock transport
through a fixed public resolver.
"""

from __future__ import annotations

import asyncio
import json
import logging

import httpx
from shared_features import forge_review_feedback_notify as notify
from sqlalchemy.exc import SQLAlchemyError

from tests.server_routes.test_approval_escalation import _public, channel, turn_on
from tests.server_routes.test_spec_quorum_routes import params, settings
from tests.server_routes.world import World

ROUTE = "/api/features/forge/github/reviews"
FINDINGS = [
    {"id": f"f-{n}", "category": "style", "severity": "low", "title": f"Remark {n}"}
    for n in (1, 2, 3)
]


def saved_review(world: World) -> None:
    reviews = world.clone("a") / ".workpilot" / "github" / "pr"
    reviews.mkdir(parents=True, exist_ok=True)
    (reviews / "review_5.json").write_text(
        json.dumps({"pr_number": 5, "findings": FINDINGS}), encoding="utf-8"
    )


async def tell(world: World, sent: list[httpx.Request], rejecter: str | None) -> int:
    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json={"ok": True})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        return await notify.tell_maintainers(
            world.projects["a"],
            5,
            world.users[rejecter] if rejecter else None,
            client=client,
            resolver=_public,
        )


def texts(sent: list[httpx.Request]) -> dict[str, str]:
    bodies = [json.loads(r.content) for r in sent]
    return {body["chat_id"]: body["text"] for body in bodies}


async def maintainers_of(world: World, exclude: str | None = None) -> set[str]:
    from server.db.engine import get_session_factory
    from server.db.models import Project

    async with get_session_factory()() as db:
        project = await db.get(Project, world.projects["a"])
        found = await notify.maintainers(
            db, project, exclude=world.users[exclude] if exclude else None
        )
    names = {uid: name for name, uid in world.users.items()}
    return {names[uid] for uid in found}


async def test_the_maintainers_are_the_owners_and_the_org_administrators(world):
    assert await maintainers_of(world) == {"owner_a", "admin_a", "maintainer_a"}
    assert await maintainers_of(world, exclude="owner_a") == {"admin_a", "maintainer_a"}


async def test_an_inactive_maintainer_is_not_one(world, monkeypatch):
    from server.db.engine import get_session_factory
    from server.db.models import User

    async with get_session_factory()() as db:
        (await db.get(User, world.users["admin_a"])).is_active = False
        await db.commit()
    monkeypatch.setattr(notify, "MAX_RECIPIENTS", 1)

    assert len(await maintainers_of(world)) == 1
    assert "admin_a" not in await maintainers_of(world)


async def test_each_maintainer_hears_of_it_in_their_language(world, monkeypatch):
    turn_on(monkeypatch)
    await channel(world, "owner_a", "1")
    await channel(world, "admin_a", "2", events={}, locale="fr")
    await channel(
        world, "maintainer_a", "3", events={"review_feedback_held": False}, locale="en"
    )
    await channel(world, "contributor_a", "4")
    await channel(world, "reviewer_a", "5")

    sent: list[httpx.Request] = []
    assert await tell(world, sent, "contributor_a") == 2

    said = texts(sent)
    assert sorted(said) == ["1", "2"]
    assert said["1"].startswith("A rejection waits for you\nProject A: a member")
    assert "pull request #5" in said["1"]
    assert said["2"].startswith("Un rejet t'attend\nProject A : un membre")
    # The finding and who rejected it never leave the server.
    assert not any("Remark" in t or "contributor" in t for t in said.values())


async def test_nothing_leaves_while_the_operator_has_it_off(world, monkeypatch):
    turn_on(monkeypatch)
    await channel(world, "owner_a", "1")
    settings(monkeypatch, needs_you_enabled="0")

    sent: list[httpx.Request] = []
    assert await tell(world, sent, None) == 0
    assert sent == []
    assert notify.schedule(world.projects["a"], 5, None) is None
    assert notify._background == set()


async def test_an_unknown_project_tells_no_one(world):
    assert await notify.tell_maintainers("no-such-project", 5, None) == 0


class _Told:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int, str | None]] = []

    async def __call__(self, project_id: str, number: int, rejecter: str | None):
        self.calls.append((project_id, number, rejecter))
        return 1


async def _verdict(world: World, who: str, finding: str, verdict="rejected") -> None:
    await world.ok(
        who,
        "POST",
        f"{ROUTE}/5/feedback",
        params=params(world),
        json={"finding_id": finding, "verdict": verdict},
    )
    await asyncio.gather(*notify._background)


async def test_the_first_rejection_of_a_wait_tells_them_once(world, monkeypatch):
    turn_on(monkeypatch)
    saved_review(world)
    told = _Told()
    monkeypatch.setattr(notify, "tell_maintainers", told)

    await _verdict(world, "contributor_a", "f-1")
    await _verdict(world, "contributor_a", "f-2", "not_applicable")
    # A maintainer's own rejection, or an acceptance, holds nothing.
    await _verdict(world, "owner_a", "f-3")
    await _verdict(world, "contributor_a", "f-3", "accepted")

    assert told.calls == [(world.projects["a"], 5, world.users["contributor_a"])]

    for finding in ("f-1", "f-2"):
        await world.ok(
            "owner_a",
            "POST",
            f"{ROUTE}/feedback/held",
            params=params(world),
            json={"pr": 5, "finding_id": finding, "approve": False},
        )
    await _verdict(world, "contributor_a", "f-1")

    assert len(told.calls) == 2


async def test_a_failed_notification_never_fails_the_verdict(
    world, monkeypatch, caplog
):
    turn_on(monkeypatch)
    saved_review(world)

    async def broken(*_args):
        raise SQLAlchemyError("lost the database, detail-7731")

    monkeypatch.setattr(notify, "tell_maintainers", broken)

    with caplog.at_level(logging.WARNING):
        await _verdict(world, "contributor_a", "f-1")

    assert "Held-rejection notification not sent: SQLAlchemyError" in caplog.text
    assert "detail-7731" not in caplog.text
