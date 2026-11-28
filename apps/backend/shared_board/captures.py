"""A server card's captures for its pull request, read from the app.

A task that touches a screen prepares its captures on the server's clone
(`pr_captures`): the verification takes the "after", the comparison with the
base branch the "before", and each image is copied to `captures/published/`
with its personal data replaced by fakes of the same format. The pull request
shows those copies (`core/capture_hosting`). These routes let the phone and
the desktop app connected to the server see what the pull request shows, and,
when the team reviews captures first (`CAPTURES_PUBLISH=review`), publish or
withdraw them:

- ``GET  /api/board/cards/{id}/captures``: what `publication.json` and
  `pr-sync.json` say, without a path, a signature or a value: kinds of data
  replaced, never the data;
- ``GET  /api/board/cards/{id}/captures/{index}/{side}``: one published copy,
  as base64 PNG. Only a file `publication.json` lists as publishable, inside
  `captures/published/`, is ever read; an original never leaves the clone;
- ``POST /api/board/cards/{id}/captures/publish`` and ``.../withdraw``: the
  review's answer (``review.approve``, `ROUTE_OVERRIDES`), recorded by
  `pr_captures.approval` and audited. Putting the images in the pull request
  is the ``captures`` run phase (``runners/pr_captures_runner.py sync``),
  started by the run route with ``vcs.pr.create``, with the starter's forge
  token.

The client names a card and a screen by its place in the list, never a path
(rule S5). Reading needs the board's ``task.read``.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, HTTPException, Request
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import AuditLog
from shared_board import listing
from shared_board.cards import _card_or_404, _require_writer
from sqlalchemy.ext.asyncio import AsyncSession

CAPTURES = "captures"
PUBLICATION = "publication.json"
SYNC = "pr-sync.json"
PUBLISHED = "published"
#: A published copy is a screen, re-encoded: far below this.
MAX_IMAGE_BYTES = 8_000_000
MAX_JSON_BYTES = 1_000_000
#: `pr_captures.publication.MAX_ITEMS`; a larger index names nothing.
MAX_ITEMS = 12
_PNG = b"\x89PNG\r\n\x1a\n"
_SIDES = {"before": "before", "after": "after"}
_WORD = 40

Side = Literal["before", "after"]


def _read(path: Path) -> dict | None:
    try:
        if path.is_symlink() or path.stat().st_size > MAX_JSON_BYTES:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _stamp(spec: Path) -> float:
    try:
        return (spec / CAPTURES / PUBLICATION).stat().st_mtime
    except OSError:
        return -1.0


def captures_spec(root: Path, directory: Path) -> Path:
    """The copy of the card whose publication is the newest, as the runner picks it.

    The build workspace's copy is the live one while it exists; the card's
    own folder keeps what an earlier build left.
    """
    candidates = [directory, listing.card_source(root, directory)]
    return max(candidates, key=_stamp)


def _word(value: Any) -> str:
    """A short code from a file the pipeline wrote: letters, digits, ``-:_.``."""
    text = str(value or "")[:_WORD]
    return "".join(c for c in text if c.isalnum() or c in "-:_.")


def _words(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    return [w for w in (_word(v) for v in values[:20]) if w]


def _label(value: Any) -> str:
    return " ".join(str(value or "").split())[:120]


def _side(entry: Any) -> dict | None:
    if not isinstance(entry, dict):
        return None
    privacy = entry.get("privacy") if isinstance(entry.get("privacy"), dict) else {}
    return {
        "available": bool(entry.get("publishable") and entry.get("file")),
        "status": _word(privacy.get("status")) or "failed",
        "replaced": max(0, int(privacy.get("replaced") or 0))
        if isinstance(privacy.get("replaced"), int)
        else 0,
        "kinds": _words(privacy.get("kinds")),
        "passes": _words(privacy.get("checks")),
    }


def _signatures(publication: dict) -> list[str]:
    found: list[str] = []
    for item in publication.get("items") or []:
        if not isinstance(item, dict) or not item.get("publishable"):
            continue
        for name in ("after", "before"):
            entry = item.get(name)
            if isinstance(entry, dict) and entry.get("publishable"):
                signature = str(entry.get("signature") or "")
                if signature and signature not in found:
                    found.append(signature)
    return found


def _approved(spec: Path, publication: dict) -> bool:
    """Every copy the pull request would show was published by a person."""
    from pr_captures.approval import approved_signatures

    wanted = _signatures(publication)
    return bool(wanted) and set(wanted) <= approved_signatures(spec)


def summary(spec: Path) -> dict[str, Any]:
    """What the app shows of a card's captures: no path, signature or value."""
    publication = _read(spec / CAPTURES / PUBLICATION)
    synced = _read(spec / CAPTURES / SYNC) or {}
    if publication is None:
        return {
            "needed": False,
            "reason": "",
            "items": [],
            "publishable": 0,
            "withheld": 0,
            "publish": "",
            "approved": False,
            "sync": None,
        }
    decision = (
        publication.get("decision")
        if isinstance(publication.get("decision"), dict)
        else {}
    )
    settings = (
        publication.get("settings")
        if isinstance(publication.get("settings"), dict)
        else {}
    )
    items = []
    for item in (publication.get("items") or [])[:MAX_ITEMS]:
        if not isinstance(item, dict):
            continue
        items.append(
            {
                "key": _label(item.get("key")),
                "label": _label(item.get("label")),
                "platform": _word(item.get("platform")),
                "variant": _word(item.get("variant")),
                "route": _label(item.get("route")),
                "locale": _word(item.get("locale")),
                "before": _side(item.get("before")),
                "after": _side(item.get("after")),
                "publishable": bool(item.get("publishable")),
            }
        )
    publish = _word(settings.get("publish"))
    sync = None
    if synced:
        sync = {
            "status": _word(synced.get("status")),
            "reason": _word(synced.get("reason")),
            "hosted": synced.get("hosted")
            if isinstance(synced.get("hosted"), int)
            else 0,
            "syncedAt": _word(synced.get("syncedAt")),
            "prUrl": str(synced.get("prUrl") or "")[:500]
            if str(synced.get("prUrl") or "").startswith("https://")
            else "",
        }
    return {
        "needed": bool(decision.get("needed")),
        "reason": _word(decision.get("reason")),
        "items": items,
        "publishable": sum(1 for i in items if i["publishable"]),
        "withheld": sum(1 for i in items if not i["publishable"]),
        "publish": publish,
        "protect": settings.get("protect") is not False,
        "approved": publish == "review" and _approved(spec, publication),
        "sync": sync,
    }


def published_copy(spec: Path, index: int, side: str) -> bytes | None:
    """The bytes of one published copy, or None when nothing may be read there."""
    publication = _read(spec / CAPTURES / PUBLICATION)
    items = (publication or {}).get("items") or []
    if not 0 <= index < min(len(items), MAX_ITEMS) or side not in _SIDES:
        return None
    item = items[index]
    entry = item.get(_SIDES[side]) if isinstance(item, dict) else None
    if not isinstance(entry, dict) or not entry.get("publishable"):
        return None
    name = entry.get("file")
    if not isinstance(name, str) or not name.endswith(".png"):
        return None
    base = os.path.realpath(spec / CAPTURES / PUBLISHED)
    target = os.path.realpath(spec / name)
    if not target.startswith(base + os.sep):
        return None
    path = Path(target)
    try:
        if not path.is_file() or path.stat().st_size > MAX_IMAGE_BYTES:
            return None
        content = path.read_bytes()
    except OSError:
        return None
    return content if content.startswith(_PNG) else None


def _spec(scope: ProjectScope, card_id: str) -> Path:
    directory = _card_or_404(scope, card_id)
    return captures_spec(scope.path.resolve(), directory)


async def card_captures(
    card_id: str,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """The card's captures, as its pull request shows them."""
    return {"captures": summary(_spec(scope, card_id))}


async def card_capture_image(
    card_id: str,
    index: int,
    side: Side,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, str]:
    """One published copy (fakes in place of personal data), as base64 PNG."""
    content = published_copy(_spec(scope, card_id), index, side)
    if content is None:
        raise HTTPException(status_code=404, detail="Capture not found")
    return {"mimeType": "image/png", "data": base64.b64encode(content).decode("ascii")}


async def _answer(
    card_id: str,
    request: Request,
    scope: ProjectScope,
    db: AsyncSession,
    *,
    publish: bool,
) -> dict[str, Any]:
    from pr_captures.approval import approve, revoke

    principal = get_principal(request)
    _require_writer(scope, principal)
    spec = _spec(scope, card_id)
    publication = _read(spec / CAPTURES / PUBLICATION)
    settings = (publication or {}).get("settings") or {}
    if not isinstance(settings, dict) or settings.get("publish") != "review":
        raise HTTPException(
            status_code=409, detail="The team does not review captures first"
        )
    if publish:
        count = approve(spec)
        if count == 0:
            raise HTTPException(status_code=409, detail="No capture to publish")
    else:
        revoke(spec)
        count = 0
    db.add(
        AuditLog(
            user_id=None if principal.is_local else principal.id,
            org_id=scope.org_id,
            project_id=scope.project_id,
            action="task.captures.published" if publish else "task.captures.withdrawn",
            payload={"spec": card_id, "images": count},
        )
    )
    await db.commit()
    return {"captures": summary(spec)}


async def publish_captures(
    card_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Publish the current copies (review mode); the ``captures`` run hosts them."""
    return await _answer(card_id, request, scope, db, publish=True)


async def withdraw_captures(
    card_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Forget the approval; the ``captures`` run then takes the images out of the PR."""
    return await _answer(card_id, request, scope, db, publish=False)
