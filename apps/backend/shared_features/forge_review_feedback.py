"""Feedback on the findings of a server project's PR reviews (#361).

A local project's feedback is written by the desktop app
(``main/ipc-handlers/github/review-feedback-store.ts``) to
``<project>/.workpilot/code_review_feedback.jsonl``. A server project's
reviews run on the server, in its clone (``forge_review``), so its feedback is
written here, to the same file of the clone, in the same line shape: the
review job reads it there (``learning_loop.review_feedback``) and every member
of the project learns from it.

The client names a pull request by number and a finding by id, nothing else
(S5): the finding's category, severity and title are read from the review the
runner saved in the clone, so a client cannot teach the reviewer to drop a
kind of finding that was never reviewed.

**A rejection waits for a maintainer.** Someone who joined a project may
reject findings without knowing its conventions. A rejection (reject or not
applicable) from a member who is not a maintainer of the project (its owner,
or an organization administrator) is held in
``.workpilot/code_review_feedback_held.json``, which the reviewer never
reads; a maintainer approves it, and it joins the dataset, or discards it.
An acceptance counts at once: it only makes the reviewer keep a remark.
Resetting a learned rule changes the reviews of everyone, so it is a
maintainer's too. The held file names no one.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from learning_loop import review_feedback as rf
from pydantic import BaseModel, ConfigDict, Field
from server.authz.principal import Principal, get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.models import ProjectRole
from shared_board.cards import _require_writer
from shared_features.api import read_file
from shared_features.forge_review import GITHUB, MAX_REVIEW, NUMBER_MAX

FINDING_ID = r"^[A-Za-z0-9_.:-]{1,128}$"
NOTE_MAX = 280
HELD_FILE = "code_review_feedback_held.json"
#: The oldest held rejections go past this many.
MAX_HELD = 500
MAX_HELD_BYTES = 1_000_000
#: The dataset is rewritten with its newest lines past this size (as the app).
MAX_FILE_BYTES = 1_000_000
KEEP_LINES_ON_COMPACT = 2_000
_CATEGORY = re.compile(r"^[a-z_]{1,32}$")
_FINDING_ID = re.compile(FINDING_ID)
_SPACES = re.compile(r"\s+")

router = APIRouter(prefix="/api/features/forge/github/reviews", tags=["features"])


class FeedbackIn(BaseModel):
    """One verdict on one finding."""

    model_config = ConfigDict(extra="forbid")

    finding_id: str = Field(pattern=FINDING_ID)
    verdict: Literal["accepted", "rejected", "not_applicable"]
    reason: (
        Literal[
            "too_pedantic",
            "project_convention",
            "false_positive",
            "legacy_exception",
            "other",
        ]
        | None
    ) = None
    note: str = Field(default="", max_length=NOTE_MAX)


class ResetIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    signature: str = Field(pattern=r"^[0-9a-f]{16}$")


class HeldDecision(BaseModel):
    """A maintainer's answer on a held rejection."""

    model_config = ConfigDict(extra="forbid")

    pr: int = Field(ge=1, le=NUMBER_MAX)
    finding_id: str = Field(pattern=FINDING_ID)
    approve: bool


def is_maintainer(scope: ProjectScope, principal: Principal) -> bool:
    """The project's owner, or an organization administrator."""
    if scope.project_role is None:
        return principal.is_platform_admin or principal.has("project.member.write")
    return scope.project_role == ProjectRole.OWNER.value


def _require_maintainer(scope: ProjectScope, principal: Principal) -> None:
    if not is_maintainer(scope, principal):
        raise HTTPException(status_code=403, detail="Requires project role 'owner'")


def _workpilot_dir(scope: ProjectScope) -> Path:
    """The clone's ``.workpilot``, refused when a link leads it out."""
    root = scope.path.resolve()
    directory = scope.path / ".workpilot"
    if directory.is_symlink() or (
        directory.exists() and not directory.resolve().is_relative_to(root)
    ):
        raise HTTPException(status_code=409, detail="Feedback unavailable")
    return directory


def _clean_note(note: str) -> str:
    printable = "".join(" " if ch < " " or ch == "\x7f" else ch for ch in note)
    return _SPACES.sub(" ", printable).strip()


def _reviewed_finding(
    scope: ProjectScope, number: int, finding_id: str
) -> dict[str, str]:
    """The finding as the runner saved it in the clone; 404 when it is not there."""
    directory = GITHUB._review_dir(scope)
    text = read_file(directory, f"review_{number}.json", MAX_REVIEW)
    try:
        data = json.loads(text) if text is not None else None
    except ValueError:
        data = None
    findings = data.get("findings") if isinstance(data, dict) else None
    for raw in findings if isinstance(findings, list) else []:
        if not isinstance(raw, dict) or raw.get("id") != finding_id:
            continue
        category, severity, title = (
            raw.get("category"),
            raw.get("severity"),
            raw.get("title"),
        )
        if (
            isinstance(category, str)
            and _CATEGORY.match(category)
            and severity in rf.SEVERITIES
            and isinstance(title, str)
            and title.strip()
        ):
            return {
                "category": category,
                "severity": str(severity),
                "title": title[: rf.MAX_TITLE_CHARS],
            }
        break
    raise HTTPException(status_code=404, detail="No such finding")


def _dataset(scope: ProjectScope) -> Path:
    path = _workpilot_dir(scope) / rf.FEEDBACK_FILE.name
    if path.is_symlink():
        raise HTTPException(status_code=409, detail="Feedback unavailable")
    return path


def _append(scope: ProjectScope, record: dict[str, Any]) -> None:
    """One line at the end of the dataset, compacted past its bound."""
    path = _dataset(scope)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    if path.stat().st_size > MAX_FILE_BYTES:
        lines = [
            line
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        _replace(path, "\n".join(lines[-KEEP_LINES_ON_COMPACT:]) + "\n")


def _replace(path: Path, content: str) -> None:
    """Write ``content`` over ``path`` at once: a reader never sees half of it."""
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _held_path(scope: ProjectScope) -> Path:
    path = _workpilot_dir(scope) / HELD_FILE
    if path.is_symlink():
        raise HTTPException(status_code=409, detail="Feedback unavailable")
    return path


def _valid_held(item: Any) -> dict[str, Any] | None:
    """A held record if it has the dataset's shape, else None."""
    record = rf.valid_record(item)
    if record is None:
        return None
    note = item.get("note")
    at = item.get("at")
    return {
        "v": rf.SCHEMA_VERSION,
        "at": at if isinstance(at, str) else "",
        **record,
        "note": note[:NOTE_MAX] if isinstance(note, str) else "",
    }


def read_held(scope: ProjectScope) -> list[dict[str, Any]]:
    """The held rejections, oldest first; empty on anything unreadable."""
    path = _held_path(scope)
    text = read_file(path.parent, path.name, MAX_HELD_BYTES)
    try:
        data = json.loads(text) if text is not None else []
    except ValueError:
        data = []
    if not isinstance(data, list):
        return []
    held = [_valid_held(item) for item in data if isinstance(item, dict)]
    return [item for item in held if item is not None][-MAX_HELD:]


def _write_held(scope: ProjectScope, held: list[dict[str, Any]]) -> None:
    path = _held_path(scope)
    path.parent.mkdir(parents=True, exist_ok=True)
    _replace(path, json.dumps(held[-MAX_HELD:], ensure_ascii=False, indent=1))


def _without(
    held: list[dict[str, Any]], number: int, finding_id: str
) -> list[dict[str, Any]]:
    return [
        item
        for item in held
        if not (item["pr"] == number and item["finding_id"] == finding_id)
    ]


def _records(scope: ProjectScope) -> list[dict[str, Any]]:
    """The dataset's records as the reviewer reads them, once its place is checked."""
    _dataset(scope)
    return rf.load_feedback(scope.path)


def feedback_view(scope: ProjectScope, number: int) -> dict[str, Any]:
    """The latest verdict per finding of a PR, and the findings whose
    rejection waits for a maintainer (shown as that rejection)."""
    feedback = {
        record["finding_id"]: record["verdict"]
        for record in _records(scope)
        if record["pr"] == number
    }
    held = [item for item in read_held(scope) if item["pr"] == number]
    for item in held:
        feedback[item["finding_id"]] = item["verdict"]
    return {"feedback": feedback, "held": [item["finding_id"] for item in held]}


@router.get("/{number}/feedback")
async def get_feedback(
    number: int, scope: ProjectScope = Depends(resolve_project_scope)
) -> dict[str, Any]:
    if not 1 <= number <= NUMBER_MAX:
        raise HTTPException(status_code=422, detail="Not a request number")
    return feedback_view(scope, number)


@router.post("/{number}/feedback")
async def set_feedback(
    number: int,
    body: FeedbackIn,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """Record a verdict as the caller; a newcomer's rejection is held."""
    principal = get_principal(request)
    _require_writer(scope, principal)
    if not 1 <= number <= NUMBER_MAX:
        raise HTTPException(status_code=422, detail="Not a request number")
    finding = _reviewed_finding(scope, number, body.finding_id)
    rejecting = body.verdict in rf.REJECTING
    record = {
        "v": rf.SCHEMA_VERSION,
        "at": _now(),
        "pr": number,
        "finding_id": body.finding_id,
        "verdict": body.verdict,
        "reason": body.reason if rejecting else None,
        "note": _clean_note(body.note) if rejecting else "",
        **finding,
    }
    held = read_held(scope)
    others = _without(held, number, body.finding_id)
    if rejecting and not is_maintainer(scope, principal):
        _write_held(scope, [*others, record])
    else:
        # What a maintainer says, or an acceptance, settles the finding.
        _append(scope, record)
        if len(others) != len(held):
            _write_held(scope, others)
    return feedback_view(scope, number)


@router.get("/feedback")
async def feedback_overview(
    request: Request, scope: ProjectScope = Depends(resolve_project_scope)
) -> dict[str, Any]:
    """What the app needs for the project-wide view: the dataset as the
    reviewer reads it (its newest part), the threshold the review jobs run
    with, the held rejections, and whether the caller may act on them."""
    path = _dataset(scope)
    dataset = ""
    if path.is_file():
        try:
            dataset = rf.read_tail(path)
        except OSError:
            dataset = ""
    return {
        "dataset": dataset,
        "threshold": rf.resolve_threshold(),
        "held": read_held(scope),
        "maintainer": is_maintainer(scope, get_principal(request)),
    }


@router.post("/feedback/reset")
async def reset_rule(
    body: ResetIn,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, bool]:
    """Forget the votes on one kind of remark, for the whole project."""
    _require_maintainer(scope, get_principal(request))
    known = {rf.signature(r["category"], r["title"]) for r in _records(scope)}
    if body.signature not in known:
        raise HTTPException(status_code=404, detail="No such rule")
    _append(
        scope,
        {
            "v": rf.SCHEMA_VERSION,
            "at": _now(),
            "kind": rf.RESET_KIND,
            "signature": body.signature,
        },
    )
    return {"reset": True}


@router.post("/feedback/held")
async def decide_held(
    body: HeldDecision,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, bool]:
    """A maintainer approves a held rejection, which joins the dataset, or
    discards it."""
    _require_maintainer(scope, get_principal(request))
    held = read_held(scope)
    item = next(
        (h for h in held if h["pr"] == body.pr and h["finding_id"] == body.finding_id),
        None,
    )
    if item is None:
        raise HTTPException(status_code=404, detail="No such held rejection")
    if body.approve:
        _append(scope, {**item, "at": _now()})
    _write_held(scope, _without(held, body.pr, body.finding_id))
    return {"done": True}
