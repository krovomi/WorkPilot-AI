"""Server mode: Pixel Office's team leaderboard and each person's badges (#350).

A delivered card counts for the person who launched its last successful
build, weighted by the complexity its spec was assessed at; an approval of
someone else's card counts as help. Nobody is named without their consent,
which only they write; the caller always sees their own score. The
organization's board reads only the projects the caller may read.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48
NOW = datetime.now(UTC)
LONG_AGO = NOW - timedelta(days=400)


@pytest.fixture(autouse=True)
def server(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path / "repos"))
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "board.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


def _db():
    from server.db.engine import get_session_factory

    return get_session_factory()()


async def _world(tmp_path: Path):
    """Org A with projects p, q (Ada is on both) and r (Ada is not on it);
    org B with project z."""
    from server.db import engine as db_engine
    from server.db.models import Organization, Project, ProjectMember, User

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    async with _db() as db:
        orgs = {}
        for slug in ("a", "b"):
            org = Organization(name=slug.upper(), slug=f"org-{slug}")
            db.add(org)
            await db.flush()
            orgs[slug] = org.id
        for uid, name in (("u-1", "Ada"), ("u-2", "Bob"), ("u-3", ""), ("u-4", "Dee")):
            db.add(User(id=uid, email=f"{uid}@x", display_name=name))
        projects = {}
        for name, slug in (("p", "a"), ("q", "a"), ("r", "a"), ("z", "b")):
            clone = tmp_path / "repos" / name
            clone.mkdir(parents=True)
            subprocess.run(["git", "init", "-q", str(clone)], check=True)
            project = Project(
                org_id=orgs[slug],
                name=name,
                repo_url=f"https://x/{name}.git",
                server_path=str(clone),
            )
            db.add(project)
            await db.flush()
            projects[name] = (project.id, clone)
        await db.flush()
        for name in ("p", "q"):
            db.add(ProjectMember(project_id=projects[name][0], user_id="u-1"))
        await db.commit()
    return orgs, projects


async def _card(
    project,
    name: str,
    *,
    status: str = "done",
    by: str | None = "u-1",
    author: str | None = None,
    at: datetime = NOW,
    complexity: str | None = None,
    runs: tuple[tuple[str, str, str], ...] | None = None,
) -> None:
    """A card of the project; ``runs`` are (phase, status, person) in order."""
    from server.db.models import AgentRun, SpecIndex

    project_id, clone = project
    folder = clone / ".workpilot" / "specs" / name
    folder.mkdir(parents=True)
    if complexity is not None:
        (folder / "complexity_assessment.json").write_text(
            json.dumps({"complexity": complexity}), encoding="utf-8"
        )
    async with _db() as db:
        row = SpecIndex(
            project_id=project_id,
            spec_name=name,
            status=status,
            created_by=author,
            updated_at=at,
        )
        db.add(row)
        await db.flush()
        chain = runs if runs is not None else (("build", "succeeded", by),)
        for index, (phase, outcome, person) in enumerate(chain):
            db.add(
                AgentRun(
                    spec_id=row.id,
                    phase=phase,
                    status=outcome,
                    started_by=person,
                    started_at=at - timedelta(hours=len(chain) - index),
                )
            )
        await db.commit()


async def _approve(project, card: str, person: str, at: datetime = NOW, slot=None):
    from server.db.models import SpecApproval

    async with _db() as db:
        db.add(
            SpecApproval(
                project_id=project[0],
                spec_name=card,
                content_hash=(slot or person).ljust(64, "0"),
                user_id=person,
                slot_id=slot or person,
                criticality="medium",
                created_at=at,
            )
        )
        await db.commit()


def _scope(org_id, project, role="member"):
    from server.authz.scope import ProjectScope

    project_id, clone = project
    return ProjectScope(project_id, org_id, clone, role)


def _principal(user="u-1", name="Ada", org_id=None):
    from server.authz.principal import Principal

    return Principal(
        id=user,
        email=f"{user}@x",
        display_name=name,
        permissions=frozenset({"analytics.read"}),
        org_id=org_id,
    )


async def _board(scope, principal, *, wide="project", period="season"):
    from shared_features.pixel_office import leaderboard

    async with _db() as db:
        return await leaderboard(wide, period, scope, principal, db)


class _Request:
    def __init__(self):
        from types import SimpleNamespace

        self.headers = {}
        self.client = None
        self.state = SimpleNamespace()


async def _consent(scope, principal, visible: bool):
    from shared_features.pixel_office import ConsentRequest, set_consent

    async with _db() as db:
        return await set_consent(
            ConsentRequest(visible=visible), _Request(), scope, principal, db
        )


async def test_nobody_is_named_without_consent_but_each_sees_their_own(tmp_path):
    orgs, projects = await _world(tmp_path)
    p = projects["p"]
    await _card(p, "001-login", complexity="complex")
    await _card(p, "002-logout", by="u-2", author="u-2")
    await _approve(p, "002-logout", "u-1")
    scope = _scope(orgs["a"], p)

    board = await _board(scope, _principal())
    assert board["entries"] == []
    # Ada's complex card (3) and her review of Bob's card (2).
    assert board["me"] == {
        "visible": False,
        "delivered": 1,
        "reviews": 1,
        "points": 5,
        "badges": ["first_delivery", "complex_delivery", "first_review"],
        "rank": None,
    }
    bob = await _board(scope, _principal("u-2", "Bob"))
    # Unassessed: the least a card weighs.
    assert bob["me"]["points"] == 1
    assert bob["entries"] == []

    assert await _consent(scope, _principal(), True) == {"visible": True}
    board = await _board(scope, _principal("u-2", "Bob"))
    (ada,) = board["entries"]
    assert ada["name"] == "Ada" and ada["points"] == 5 and ada["you"] is False
    assert board["me"]["visible"] is False

    mine = await _board(scope, _principal())
    assert mine["me"]["visible"] is True and mine["me"]["rank"] == 1
    assert mine["entries"][0]["you"] is True

    # Saying no again takes the name off.
    await _consent(scope, _principal(), False)
    assert (await _board(scope, _principal("u-2", "Bob")))["entries"] == []


async def test_consent_is_the_callers_own_and_is_audited(tmp_path):
    from server.db.models import AuditLog, LeaderboardConsent
    from sqlalchemy import select

    orgs, projects = await _world(tmp_path)
    scope = _scope(orgs["a"], projects["p"], "viewer")
    await _consent(scope, _principal("u-2", "Bob"), True)
    await _consent(scope, _principal("u-2", "Bob"), True)
    async with _db() as db:
        rows = (await db.scalars(select(LeaderboardConsent))).all()
        assert [(r.org_id, r.user_id, r.visible) for r in rows] == [
            (orgs["a"], "u-2", True)
        ]
        actions = (
            await db.scalars(select(AuditLog.action).where(AuditLog.user_id == "u-2"))
        ).all()
        assert actions == ["pixel_office.leaderboard.consent"] * 2


def test_the_consent_body_takes_a_boolean_only():
    from pydantic import ValidationError
    from shared_features.pixel_office import ConsentRequest

    for hostile in ("true", 1, None, {"visible": True}):
        with pytest.raises(ValidationError):
            ConsentRequest(visible=hostile)


async def test_the_last_successful_build_credits_the_card(tmp_path):
    orgs, projects = await _world(tmp_path)
    p = projects["p"]
    # Bob's build failed, Ada's later one delivered: Ada's card.
    await _card(
        p,
        "001-a",
        runs=(("build", "failed", "u-2"), ("build", "succeeded", "u-1")),
    )
    # Ada built it, Bob built it again later: Bob's.
    await _card(
        p,
        "002-b",
        complexity="standard",
        runs=(("build", "succeeded", "u-1"), ("build", "succeeded", "u-2")),
    )
    # A spec run, a QA run or a build nobody launched credits nobody.
    await _card(
        p, "003-c", runs=(("spec", "succeeded", "u-1"), ("qa", "succeeded", "u-1"))
    )
    await _card(p, "004-d", runs=(("build", "succeeded", None),))
    # Not delivered yet.
    await _card(p, "005-e", status="human_review")
    await _card(p, "006-f", status="pr_created", complexity="simple")
    scope = _scope(orgs["a"], p)
    ada = (await _board(scope, _principal()))["me"]
    bob = (await _board(scope, _principal("u-2", "Bob")))["me"]
    assert (ada["delivered"], ada["points"]) == (2, 2)
    assert (bob["delivered"], bob["points"]) == (1, 2)


async def test_help_counts_once_per_card_and_never_on_ones_own_work(tmp_path):
    orgs, projects = await _world(tmp_path)
    p = projects["p"]
    await _card(p, "001-bob", by="u-2", author="u-2")
    await _card(p, "002-ada", by="u-2", author="u-1")
    await _card(p, "003-mine", by="u-1", author="u-2")
    await _card(p, "004-open", status="backlog", by=None, author="u-2", runs=())
    # Twice on the same card (the spec changed in between): one review.
    await _approve(p, "001-bob", "u-1")
    await _approve(p, "001-bob", "u-1", slot="u-1-again")
    # Her own card, and a card she delivered herself: no help.
    await _approve(p, "002-ada", "u-1")
    await _approve(p, "003-mine", "u-1")
    # A card not delivered yet still got a review.
    await _approve(p, "004-open", "u-1")
    me = (await _board(_scope(orgs["a"], p), _principal()))["me"]
    assert me["reviews"] == 2
    assert me["points"] == 1 + 2 * 2


async def test_the_season_counts_this_quarter_and_badges_count_since_the_start(
    tmp_path,
):
    orgs, projects = await _world(tmp_path)
    p = projects["p"]
    for index in range(10):
        await _card(p, f"0{index:02d}-old", at=LONG_AGO)
    await _card(p, "100-new", by="u-2")
    await _approve(p, "100-new", "u-1", at=LONG_AGO)
    scope = _scope(orgs["a"], p)
    season = (await _board(scope, _principal()))["me"]
    assert (season["delivered"], season["reviews"], season["points"]) == (0, 0, 0)
    assert season["badges"] == ["first_delivery", "ten_deliveries", "first_review"]
    ever = (await _board(scope, _principal(), period="all"))["me"]
    assert (ever["delivered"], ever["reviews"], ever["points"]) == (10, 1, 12)


async def test_equal_points_share_a_rank_and_the_list_is_bounded(tmp_path, monkeypatch):
    from shared_features import pixel_office

    orgs, projects = await _world(tmp_path)
    p = projects["p"]
    await _card(p, "001-a", complexity="complex", by="u-1")
    await _card(p, "002-b", complexity="complex", by="u-2")
    await _card(p, "003-c", by="u-3")
    await _card(p, "004-d", by="u-4")
    scope = _scope(orgs["a"], p)
    for uid in ("u-1", "u-2", "u-3"):
        await _consent(scope, _principal(uid), True)
    board = await _board(scope, _principal("u-4", "Dee"))
    assert [(e["rank"], e["name"], e["points"]) for e in board["entries"]] == [
        (1, "Ada", 3),
        (1, "Bob", 3),
        # No display name: the email.
        (3, "u-3@x", 1),
    ]
    monkeypatch.setattr(pixel_office, "MAX_ENTRIES", 1)
    assert len((await _board(scope, _principal()))["entries"]) == 1


async def test_the_organization_board_reads_only_what_the_caller_may_read(
    tmp_path,
):
    orgs, projects = await _world(tmp_path)
    for name in ("p", "q", "r", "z"):
        await _card(projects[name], "001-x")
    ada = _principal(org_id=orgs["a"])
    scope = _scope(orgs["a"], projects["p"])
    project_only = await _board(scope, ada)
    assert (project_only["projects"], project_only["me"]["delivered"]) == (1, 1)
    org = await _board(scope, ada, wide="org")
    # p and q: r is not hers, z is another organization's.
    assert (org["projects"], org["me"]["delivered"]) == (2, 2)
    assert org["scope"] == "org"


async def test_consent_belongs_to_the_organization(tmp_path):
    orgs, projects = await _world(tmp_path)
    await _card(projects["z"], "001-x", by="u-2")
    await _consent(_scope(orgs["a"], projects["p"]), _principal("u-2", "Bob"), True)
    board = await _board(_scope(orgs["b"], projects["z"]), _principal("u-4", "Dee"))
    assert board["entries"] == []


async def test_a_card_folder_that_is_a_link_is_not_read(tmp_path):
    from shared_features.pixel_office import card_points

    _orgs, projects = await _world(tmp_path)
    _pid, clone = projects["p"]
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "complexity_assessment.json").write_text(
        json.dumps({"complexity": "complex"}), encoding="utf-8"
    )
    specs = clone / ".workpilot" / "specs"
    specs.mkdir(parents=True)
    (specs / "001-link").symlink_to(outside, target_is_directory=True)
    assert card_points(clone, "001-link") == (1, False)
    assert card_points(clone, "../outside") == (1, False)


async def test_a_project_with_nothing_delivered_has_an_empty_board(tmp_path):
    from shared_features.pixel_office import collect_facts

    orgs, projects = await _world(tmp_path)
    board = await _board(_scope(orgs["a"], projects["p"]), _principal())
    assert board["entries"] == []
    assert board["me"]["points"] == 0 and board["me"]["badges"] == []
    async with _db() as db:
        facts = await collect_facts(db, {}, None)
    assert not facts.period and not facts.ever


def test_a_season_is_a_calendar_quarter():
    from shared_features.pixel_office import season_bounds

    assert season_bounds(datetime(2026, 11, 22, tzinfo=UTC)) == (
        datetime(2026, 10, 1, tzinfo=UTC),
        datetime(2027, 1, 1, tzinfo=UTC),
    )
    assert season_bounds(datetime(2026, 2, 3, tzinfo=UTC)) == (
        datetime(2026, 1, 1, tzinfo=UTC),
        datetime(2026, 4, 1, tzinfo=UTC),
    )


def test_a_moment_without_a_date_is_in_no_season():
    from shared_features.pixel_office import _within, season_bounds

    bounds = season_bounds(NOW)
    assert _within(None, bounds) is False
    assert _within(None, None) is True
    assert _within(NOW.replace(tzinfo=None), bounds) is True


async def test_another_tenants_project_answers_404(tmp_path):
    from server.authz.scope import load_project_scope

    orgs, projects = await _world(tmp_path)
    async with _db() as db:
        with pytest.raises(HTTPException) as refused:
            await load_project_scope(db, _principal(org_id=orgs["a"]), projects["z"][0])
    assert refused.value.status_code == 404
