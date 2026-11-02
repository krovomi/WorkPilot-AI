"""The card a server rule creates, and who creates it.

The card is a card of the shared board, written as ``POST /api/board/cards``
writes one (``board_mcp.server.write_card``, numbered under the board's
lock), with the metadata the desktop rule writes (``cards.ts``): the rule it
came from, the issue's fields so the import and the issue views recognise
it, the kind and the engine the rule chose. Its author is the server's
service account, *Automations*: the board, the index and the live stream
say a rule made it, not the person who happened to save the rule.

The service account is a user row that cannot sign in: it is inactive, has
no identity (no password, no single sign-on) and its address is on the
reserved ``.invalid`` domain, which no invitation or identity provider can
claim. It belongs to no organization, so it appears in no member list.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from server.db.models import User
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .sources import Event, one_line

SERVICE_EMAIL = "automations@service.workpilot.invalid"
SERVICE_NAME = "Automations"
MAX_TITLE = 200
MAX_DESCRIPTION = 50_000

#: ``determineCategoryFromLabels`` of the desktop's GitHub import, in order:
#: a label containing one of the words.
_CATEGORIES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("bug_fix", ("bug", "defect", "error", "fix")),
    ("security", ("security", "vulnerability", "cve")),
    ("performance", ("performance", "optimization", "speed")),
    ("ui_ux", ("ui", "ux", "design", "styling")),
    ("infrastructure", ("infrastructure", "devops", "deployment")),
    ("testing", ("test", "testing", "qa")),
    (
        "refactoring",
        ("refactor", "cleanup", "maintenance", "chore", "tech-debt", "technical debt"),
    ),
    ("documentation", ("documentation", "docs")),
)
#: ``ci`` and ``cd`` count as whole words only (not "acid", "decide").
_WHOLE_WORD = re.compile(r"\b(?:ci|cd)\b")


def category_from_labels(labels: list[str]) -> str:
    lowered = [label.lower() for label in labels]
    for category, words in _CATEGORIES:
        if any(word in label for label in lowered for word in words):
            return category
        if category == "infrastructure" and any(
            _WHOLE_WORD.search(label) for label in lowered
        ):
            return category
    return "feature"


async def service_account(db: AsyncSession) -> User:
    """The *Automations* user, made the first time a rule creates a card."""
    user = await db.scalar(select(User).where(User.email == SERVICE_EMAIL))
    if user is None:
        user = User(email=SERVICE_EMAIL, display_name=SERVICE_NAME, is_active=False)
        db.add(user)
        await db.commit()
        await db.refresh(user)
    return user


def engine_metadata(engine: dict[str, str]) -> dict[str, Any]:
    """``buildEngineMetadata(uniformEngine(trio))`` of the desktop, checked by
    the board's own engine model (a provider of the capability matrix)."""
    from shared_board.settings import CardEngine

    phases = ("spec", "planning", "coding", "qa")
    checked = CardEngine(
        provider=engine["provider"],
        model=engine["model"],
        thinkingLevel=engine["effort"],
    )
    return {
        "engineLocked": True,
        "isAutoProfile": True,
        "provider": checked.provider,
        "model": checked.model,
        "thinkingLevel": checked.thinkingLevel,
        "phaseProviders": dict.fromkeys(phases, checked.provider),
        "phaseModels": dict.fromkeys(phases, checked.model),
        "phaseThinking": dict.fromkeys(phases, checked.thinkingLevel),
    }


def card_metadata(
    rule: dict[str, Any], event: Event, author: User, base_branch: str
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "sourceType": "automation",
        "automation": {
            "ruleId": rule["id"],
            "ruleName": rule["name"],
            "eventKey": event.key,
            **({"url": event.url} if event.url else {}),
        },
        "createdBy": author.id,
        "createdByName": author.display_name,
        # The build waits for a person to approve the spec and the plan.
        "requireReviewBeforeCoding": True,
        **({"baseBranch": base_branch} if base_branch else {}),
    }
    issue = event.issue
    if issue:
        # The fields the forge's import writes, so the import and the issue
        # views see this card as the issue's card.
        if issue["forge"] == "github":
            metadata["sourceType"] = "github"
            metadata["githubIssueNumber"] = issue["number"]
            if issue["url"]:
                metadata["githubUrl"] = issue["url"]
        else:
            metadata["sourceType"] = "gitlab"
            metadata["gitlabIssueIid"] = issue["number"]
            if issue["url"]:
                metadata["gitlabUrl"] = issue["url"]
        metadata["category"] = category_from_labels(issue["labels"])
    if rule.get("kind"):
        # The person chose the kind when writing the rule: the classifier keeps it.
        metadata.update(kind=rule["kind"], kindSource="user", kindConfidence=1)
    if rule.get("engine"):
        metadata.update(engine_metadata(rule["engine"]))
    return metadata


def read_metadata(directory: Path) -> dict[str, Any]:
    """A card's ``task_metadata.json``; empty when absent or unreadable."""
    try:
        value = json.loads(
            (directory / "task_metadata.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def issues_on_board(root: Path, forge: str) -> set[int]:
    """The forge's issues the board already has a card for, imported or not."""
    from board_mcp.server import CARD_ID, SPECS

    field = "githubIssueNumber" if forge == "github" else "gitlabIssueIid"
    numbers: set[int] = set()
    specs = root / SPECS
    if not specs.is_dir():
        return numbers
    for entry in specs.iterdir():
        if not CARD_ID.match(entry.name) or not entry.is_dir() or entry.is_symlink():
            continue
        # No metadata, or unreadable: not an issue card.
        number = read_metadata(entry).get(field)
        if isinstance(number, int) and not isinstance(number, bool):
            numbers.add(number)
    return numbers


def write_automation_card(
    root: Path, rule: dict[str, Any], event: Event, metadata: dict[str, Any]
) -> Path:
    """The card on disk; its directory. Raises ``SpecNumberLockError``."""
    from board_mcp.server import write_card

    title = one_line(event.title, MAX_TITLE) or rule["name"]
    description = (event.description or "").strip()[:MAX_DESCRIPTION] or title
    return write_card(root, title, description, metadata)
