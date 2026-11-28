"""Server mode: a card's captures for its pull request, read from the app.

The server's clone prepares each capture's published copy (fakes in place of
personal data, `pr_captures`); these routes show the app what the pull request
shows, one published copy at a time, and let a reviewer publish or withdraw
them when the team reviews captures first. A client never names a file: a
screen is its place in `publication.json`, and only a copy listed there as
publishable, inside `captures/published/`, is read.
"""

from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from tests.backend.test_shared_board import (  # noqa: E402
    _clean_settings,  # noqa: F401 - autouse fixture
    _db,
    _project,
    _request,
    _scope,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def _side(file: str, *, publishable: bool = True, signature: str = "1:1") -> dict:
    return {
        "source": file.replace("published/", ""),
        "file": file if publishable else "",
        "signature": signature,
        "protected": True,
        "privacy": {
            "status": "pseudonymized" if publishable else "withheld",
            "replaced": 2,
            "checks": ["page", "ocr:tesseract"],
            "kinds": ["email", "phone"],
            "notes": [],
        },
        "publishable": publishable,
    }


def _publication(publish: str = "auto", *, withheld: bool = False) -> dict:
    return {
        "version": 1,
        "generatedAt": "2026-11-28T16:00:00+00:00",
        "decision": {"needed": True, "reason": "ui-files"},
        "settings": {"publish": publish, "protect": True, "publishUnchecked": False},
        "items": [
            {
                "key": "web|/settings|desktop|fr",
                "label": "Réglages",
                "platform": "web",
                "variant": "desktop",
                "route": "settings",
                "locale": "fr",
                "source": "verify",
                "before": _side(
                    "captures/published/base/settings.png", signature="1:2"
                ),
                "after": _side("captures/published/task/settings.png", signature="1:3"),
                "publishable": True,
            },
            {
                "key": "web|/profile|desktop|fr",
                "label": "Profil",
                "platform": "web",
                "variant": "desktop",
                "route": "profile",
                "locale": "fr",
                "source": "verify",
                "before": None,
                "after": _side(
                    "captures/published/task/profile.png", publishable=not withheld
                ),
                "publishable": not withheld,
            },
        ],
        "publishable": 1 if withheld else 2,
        "withheld": 1 if withheld else 0,
    }


def _write_captures(spec: Path, publication: dict) -> None:
    captures = spec / "captures"
    for side in ("base", "task"):
        (captures / "published" / side).mkdir(parents=True, exist_ok=True)
    (captures / "published/base/settings.png").write_bytes(PNG)
    (captures / "published/task/settings.png").write_bytes(PNG)
    (captures / "published/task/profile.png").write_bytes(PNG)
    (captures / "task").mkdir(exist_ok=True)
    (captures / "task/settings.png").write_bytes(PNG + b"original")
    (captures / "publication.json").write_text(
        json.dumps(publication), encoding="utf-8"
    )


async def _card(tmp_path, role: str = "member"):
    from shared_board.api import CardCreate, create_card

    pid, oid, clone = await _project(tmp_path)
    member = _scope(pid, oid, clone, "member")
    async with await _db() as db:
        card = await create_card(CardCreate(title="T"), _request(), member, db)
    spec = clone / ".workpilot/specs" / card["id"]
    return _scope(pid, oid, clone, role), clone, spec, card["id"]


@pytest.mark.asyncio
async def test_a_card_without_captures_says_so(tmp_path):
    from shared_board.captures import card_captures

    scope, _, _, card_id = await _card(tmp_path, "viewer")
    got = (await card_captures(card_id, scope))["captures"]
    assert got["needed"] is False
    assert got["items"] == [] and got["sync"] is None


@pytest.mark.asyncio
async def test_a_viewer_reads_what_the_pull_request_shows_without_a_path(tmp_path):
    from shared_board.captures import card_captures

    scope, _, spec, card_id = await _card(tmp_path, "viewer")
    _write_captures(spec, _publication(withheld=True))
    (spec / "captures/pr-sync.json").write_text(
        json.dumps(
            {
                "status": "published",
                "reason": "",
                "hosted": 2,
                "syncedAt": "2026-11-28T16:01:00+00:00",
                "prUrl": "https://github.com/acme/shop/pull/7",
            }
        ),
        encoding="utf-8",
    )
    got = (await card_captures(card_id, scope))["captures"]
    assert got["needed"] is True and got["reason"] == "ui-files"
    assert got["publishable"] == 1 and got["withheld"] == 1
    assert got["publish"] == "auto" and got["approved"] is False
    first, second = got["items"]
    assert first["label"] == "Réglages"
    assert first["after"] == {
        "available": True,
        "status": "pseudonymized",
        "replaced": 2,
        "kinds": ["email", "phone"],
        "passes": ["page", "ocr:tesseract"],
    }
    assert second["after"]["available"] is False and second["before"] is None
    assert got["sync"]["prUrl"] == "https://github.com/acme/shop/pull/7"
    text = json.dumps(got)
    # No file name, no signature, no source path reaches the app.
    assert (
        "published/" not in text and "1:3" not in text and "captures/task" not in text
    )


@pytest.mark.asyncio
async def test_a_pull_request_link_that_is_not_https_is_dropped(tmp_path):
    from shared_board.captures import card_captures

    scope, _, spec, card_id = await _card(tmp_path, "viewer")
    _write_captures(spec, _publication())
    (spec / "captures/pr-sync.json").write_text(
        json.dumps({"status": "published", "prUrl": "javascript:alert(1)"}),
        encoding="utf-8",
    )
    got = (await card_captures(card_id, scope))["captures"]
    assert got["sync"]["prUrl"] == ""


@pytest.mark.asyncio
async def test_the_build_workspace_copy_wins_when_its_publication_is_newer(tmp_path):
    from shared_board.captures import card_captures

    scope, clone, spec, card_id = await _card(tmp_path, "viewer")
    _write_captures(spec, _publication(withheld=True))
    copy = clone / ".workpilot/worktrees/tasks" / card_id / ".workpilot/specs" / card_id
    copy.mkdir(parents=True)
    _write_captures(copy, _publication())
    older = (spec / "captures/publication.json").stat().st_mtime - 60
    os.utime(spec / "captures/publication.json", (older, older))
    got = (await card_captures(card_id, scope))["captures"]
    assert got["withheld"] == 0


@pytest.mark.asyncio
async def test_a_published_copy_is_served_as_base64_png(tmp_path):
    from shared_board.captures import card_capture_image

    scope, _, spec, card_id = await _card(tmp_path, "viewer")
    _write_captures(spec, _publication())
    got = await card_capture_image(card_id, 0, "before", scope)
    assert got["mimeType"] == "image/png"
    assert base64.b64decode(got["data"]) == PNG


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("index", "side"),
    [(1, "before"), (5, "after"), (-1, "after"), (0, "original")],
)
async def test_nothing_outside_the_list_is_served(tmp_path, index, side):
    from shared_board.captures import card_capture_image

    scope, _, spec, card_id = await _card(tmp_path, "viewer")
    _write_captures(spec, _publication())
    with pytest.raises(HTTPException) as caught:
        await card_capture_image(card_id, index, side, scope)
    assert caught.value.status_code == 404


@pytest.mark.asyncio
async def test_a_withheld_capture_is_never_served(tmp_path):
    from shared_board.captures import card_capture_image

    scope, _, spec, card_id = await _card(tmp_path, "viewer")
    publication = _publication(withheld=True)
    # Even when the file field still names a copy, publishable false wins.
    publication["items"][1]["after"]["file"] = "captures/published/task/profile.png"
    _write_captures(spec, publication)
    with pytest.raises(HTTPException):
        await card_capture_image(card_id, 1, "after", scope)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "file",
    [
        "captures/task/settings.png",
        "captures/published/../task/settings.png",
        "../../../etc/passwd.png",
        "captures/published/task/notes.txt",
    ],
)
async def test_a_file_outside_the_published_copies_is_refused(tmp_path, file):
    from shared_board.captures import card_capture_image

    scope, _, spec, card_id = await _card(tmp_path, "viewer")
    publication = _publication()
    publication["items"][0]["after"]["file"] = file
    _write_captures(spec, publication)
    (spec / "captures/published/task/notes.txt").write_bytes(PNG)
    with pytest.raises(HTTPException):
        await card_capture_image(card_id, 0, "after", scope)


@pytest.mark.asyncio
async def test_a_link_out_of_the_published_folder_is_refused(tmp_path):
    from shared_board.captures import card_capture_image

    scope, _, spec, card_id = await _card(tmp_path, "viewer")
    _write_captures(spec, _publication())
    outside = tmp_path / "secret.png"
    outside.write_bytes(PNG + b"secret")
    target = spec / "captures/published/task/settings.png"
    target.unlink()
    target.symlink_to(outside)
    with pytest.raises(HTTPException):
        await card_capture_image(card_id, 0, "after", scope)


@pytest.mark.asyncio
async def test_a_file_that_is_not_a_png_is_refused(tmp_path):
    from shared_board.captures import card_capture_image

    scope, _, spec, card_id = await _card(tmp_path, "viewer")
    _write_captures(spec, _publication())
    (spec / "captures/published/task/settings.png").write_bytes(b"<svg/>")
    with pytest.raises(HTTPException):
        await card_capture_image(card_id, 0, "after", scope)


@pytest.mark.asyncio
async def test_a_reviewer_publishes_then_withdraws_and_both_are_audited(tmp_path):
    from server.db.models import AuditLog
    from shared_board.captures import publish_captures, withdraw_captures
    from sqlalchemy import select

    scope, _, spec, card_id = await _card(tmp_path)
    _write_captures(spec, _publication("review"))
    async with await _db() as db:
        got = (await publish_captures(card_id, _request(), scope, db))["captures"]
    assert got["approved"] is True
    approval = json.loads((spec / "captures/approval.json").read_text(encoding="utf-8"))
    assert set(approval["signatures"]) == {"1:1", "1:2", "1:3"}
    async with await _db() as db:
        got = (await withdraw_captures(card_id, _request(), scope, db))["captures"]
    assert got["approved"] is False
    assert not (spec / "captures/approval.json").exists()
    async with await _db() as db:
        rows = (await db.scalars(select(AuditLog).order_by(AuditLog.created_at))).all()
    actions = [
        (r.action, r.payload) for r in rows if r.action.startswith("task.captures")
    ]
    assert actions == [
        ("task.captures.published", {"spec": card_id, "images": 3}),
        ("task.captures.withdrawn", {"spec": card_id, "images": 0}),
    ]


@pytest.mark.asyncio
async def test_a_capture_taken_again_after_publishing_waits_again(tmp_path):
    from shared_board.captures import card_captures, publish_captures

    scope, _, spec, card_id = await _card(tmp_path)
    _write_captures(spec, _publication("review"))
    async with await _db() as db:
        await publish_captures(card_id, _request(), scope, db)
    retaken = _publication("review")
    retaken["items"][0]["after"]["signature"] = "9:9"
    (spec / "captures/publication.json").write_text(
        json.dumps(retaken), encoding="utf-8"
    )
    assert (await card_captures(card_id, scope))["captures"]["approved"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("publish", ["auto", "never"])
async def test_publishing_is_refused_when_the_team_does_not_review(tmp_path, publish):
    from shared_board.captures import publish_captures

    scope, _, spec, card_id = await _card(tmp_path)
    _write_captures(spec, _publication(publish))
    async with await _db() as db:
        with pytest.raises(HTTPException) as caught:
            await publish_captures(card_id, _request(), scope, db)
    assert caught.value.status_code == 409
    assert not (spec / "captures/approval.json").exists()


@pytest.mark.asyncio
async def test_publishing_nothing_is_refused(tmp_path):
    from shared_board.captures import publish_captures

    scope, _, spec, card_id = await _card(tmp_path)
    publication = _publication("review", withheld=True)
    publication["items"] = publication["items"][1:]
    _write_captures(spec, publication)
    async with await _db() as db:
        with pytest.raises(HTTPException) as caught:
            await publish_captures(card_id, _request(), scope, db)
    assert caught.value.status_code == 409


@pytest.mark.asyncio
async def test_a_viewer_cannot_publish(tmp_path):
    from shared_board.captures import publish_captures

    scope, _, spec, card_id = await _card(tmp_path, "viewer")
    _write_captures(spec, _publication("review"))
    async with await _db() as db:
        with pytest.raises(HTTPException) as caught:
            await publish_captures(card_id, _request(), scope, db)
    assert caught.value.status_code == 403
    assert not (spec / "captures/approval.json").exists()


@pytest.mark.asyncio
async def test_an_unknown_card_is_a_404(tmp_path):
    from shared_board.captures import card_captures

    scope, _, _, _ = await _card(tmp_path, "viewer")
    with pytest.raises(HTTPException) as caught:
        await card_captures("999-nope", scope)
    assert caught.value.status_code == 404


def test_publishing_and_withdrawing_need_the_review_right():
    from server.authz.mounting import permission_for

    for verb in ("publish", "withdraw"):
        route = f"/api/board/cards/{{card_id}}/captures/{verb}"
        assert permission_for("POST", route, "task") == "review.approve"
    assert (
        permission_for("GET", "/api/board/cards/{card_id}/captures", "task")
        == "task.read"
    )
    assert (
        permission_for(
            "GET", "/api/board/cards/{card_id}/captures/{index}/{side}", "task"
        )
        == "task.read"
    )


def test_the_captures_run_syncs_the_pull_request_without_an_agent(tmp_path):
    from server.routers.specs import PHASE_PERMISSIONS
    from server.services.run_manager import PHASES, build_command

    assert "captures" in PHASES
    assert PHASE_PERMISSIONS["captures"] == ("vcs.pr.create",)
    cmd = build_command("captures", "001-x", str(tmp_path), "some-model", tmp_path)
    assert Path(cmd[1]).name == "pr_captures_runner.py"
    assert cmd[2:] == ["sync", "--project-dir", str(tmp_path), "--spec-name", "001-x"]
    assert "--model" not in cmd


@pytest.mark.asyncio
async def test_the_snapshot_carries_the_captures_summary_files(tmp_path):
    from shared_board.api import _card_files

    _, _, spec, _ = await _card(tmp_path, "viewer")
    _write_captures(spec, _publication())
    (spec / "captures/pr-sync.json").write_text(
        '{"status": "nothing"}', encoding="utf-8"
    )
    files = _card_files(spec)
    assert json.loads(files["captures/publication.json"])["decision"]["needed"] is True
    assert files["captures/pr-sync.json"] == '{"status": "nothing"}'


@pytest.mark.asyncio
async def test_the_snapshot_skips_a_captures_folder_linked_out_of_the_card(tmp_path):
    from shared_board.api import _card_files

    _, _, spec, _ = await _card(tmp_path, "viewer")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "publication.json").write_text("{}", encoding="utf-8")
    (spec / "captures").symlink_to(elsewhere, target_is_directory=True)
    files = _card_files(spec)
    assert "captures/publication.json" not in files
