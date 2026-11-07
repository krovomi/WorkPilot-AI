"""Server mode: images attached to a card, and to a request for changes.

The app refused both on a server card ("Images cannot be sent to a server
card yet"), or dropped the New Task dialog's images without a word. They now
travel in the request and are stored where the agents read them, as the
desktop does: ``attachments/`` of the card, ``feedback_images/`` of the build
workspace.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from tests.backend.test_shared_board_review import (  # noqa: E402
    _build,
    _card,
    _db,
    _events,  # noqa: F401 - fixture
    _project,
    _request,
    _scope,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 16


def _upload(content: bytes, name: str = "shot.png", mime: str = "image/png") -> dict:
    return {
        "filename": name,
        "mimeType": mime,
        "data": base64.b64encode(content).decode("ascii"),
    }


@pytest.mark.asyncio
async def test_a_new_cards_images_go_where_the_agents_read_them(tmp_path, _events):
    from shared_board.api import CardCreate, create_card

    pid, oid, clone = await _project(tmp_path)
    body = CardCreate(
        title="Fix the header",
        attachments=[
            _upload(PNG, "../../etc/passwd.png"),
            _upload(PNG, "../../etc/passwd.png"),
            _upload(WEBP, "mock up.webp", "image/webp"),
        ],
    )
    async with await _db() as db:
        card = await create_card(
            body, _request(), _scope(pid, oid, clone, "member"), db
        )
    spec = clone / ".workpilot/specs" / card["id"]
    names = sorted(p.name for p in (spec / "attachments").iterdir())
    assert names == ["mock up.webp", "passwd-2.png", "passwd.png"]
    assert (spec / "attachments/passwd.png").read_bytes() == PNG
    assert not (tmp_path / "etc").exists()

    metadata = json.loads((spec / "task_metadata.json").read_text(encoding="utf-8"))
    assert [i["path"] for i in metadata["attachedImages"]] == [
        "attachments/passwd.png",
        "attachments/passwd-2.png",
        "attachments/mock up.webp",
    ]
    assert "data" not in metadata["attachedImages"][0]
    requirements = json.loads((spec / "requirements.json").read_text(encoding="utf-8"))
    assert requirements["attached_images"][0]["path"] == "attachments/passwd.png"


@pytest.mark.asyncio
async def test_an_image_that_is_not_what_it_claims_creates_no_card(tmp_path):
    from fastapi import HTTPException
    from pydantic import ValidationError
    from shared_board.api import CardCreate, create_card

    pid, oid, clone = await _project(tmp_path)
    scope = _scope(pid, oid, clone, "member")
    for upload in (
        _upload(b"<svg onload=alert(1)>", "x.png"),  # bytes are not a PNG
        {"filename": "x.png", "mimeType": "image/png", "data": "not base64!"},
    ):
        async with await _db() as db:
            with pytest.raises(HTTPException) as exc:
                await create_card(
                    CardCreate(title="T", attachments=[upload]), _request(), scope, db
                )
        assert exc.value.status_code == 422
    specs = clone / ".workpilot/specs"
    assert not specs.exists() or not any(specs.iterdir())

    with pytest.raises(ValidationError):  # SVG is not accepted at all
        CardCreate(
            title="T", attachments=[_upload(b"<svg/>", "x.svg", "image/svg+xml")]
        )
    with pytest.raises(ValidationError):
        CardCreate(title="T", attachments=[_upload(PNG)] * 11)


def test_a_too_large_image_is_refused_before_it_is_decoded():
    from pydantic import ValidationError
    from shared_board.attachments import MAX_IMAGE_B64, ImageUpload

    with pytest.raises(ValidationError):
        ImageUpload(
            filename="x.png", mimeType="image/png", data="A" * (MAX_IMAGE_B64 + 4)
        )


@pytest.mark.asyncio
async def test_a_request_for_changes_carries_its_screenshots(tmp_path, _events):
    from shared_board.review import ChangeRequest, request_changes

    pid, oid, clone = await _project(tmp_path)
    card_id = await _card(pid, oid, clone)
    workspace = _build(clone, card_id)
    body = ChangeRequest(feedback="The button is cut.", images=[_upload(PNG)])
    async with await _db() as db:
        await request_changes(
            card_id, body, _request(), _scope(pid, oid, clone, "member"), db
        )
    spec = workspace / ".workpilot/specs" / card_id
    assert (spec / "feedback_images/shot.png").read_bytes() == PNG
    request = (spec / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
    assert "## Reference Images" in request
    assert "![Feedback Image](feedback_images/shot.png)" in request


@pytest.mark.asyncio
async def test_a_linked_images_folder_is_refused(tmp_path, _events):
    from fastapi import HTTPException
    from shared_board.review import ChangeRequest, request_changes

    pid, oid, clone = await _project(tmp_path)
    card_id = await _card(pid, oid, clone)
    workspace = _build(clone, card_id)
    outside = tmp_path / "outside"
    outside.mkdir()
    spec = workspace / ".workpilot/specs" / card_id
    try:
        (spec / "feedback_images").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks unavailable")
    body = ChangeRequest(feedback="Look.", images=[_upload(PNG)])
    async with await _db() as db:
        with pytest.raises(HTTPException) as exc:
            await request_changes(
                card_id, body, _request(), _scope(pid, oid, clone, "member"), db
            )
    assert exc.value.status_code == 409
    assert not any(outside.iterdir())
