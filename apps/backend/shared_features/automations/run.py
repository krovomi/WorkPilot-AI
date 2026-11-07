"""One pass over a server project's rules: the desktop's pass (``run.ts``).

Read each rule's source, drop what was already answered, hold back what the
daily cap does not allow, create the rest as cards (or, for a pull or merge
request, start its unposted review). The ledger is changed in place; the
caller writes it once, at the end.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

import httpx
from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError

from .sources import Event, SourceError, SourceResult, local_date

MAX_ERROR = 300

#: What a source, a card or a review may fail with. Anything else is a bug,
#: and the pass of the whole project reports it (``scheduler.py``).
EXPECTED = (
    SourceError,
    HTTPException,
    httpx.HTTPError,
    OSError,
    ValueError,
    KeyError,
    TypeError,
    SQLAlchemyError,
    RuntimeError,
)


class Deps(Protocol):
    def now(self) -> datetime:
        """The time of this pass."""

    async def read_source(
        self, rule: dict[str, Any], ledger: dict[str, Any]
    ) -> SourceResult:
        """The events of the rule's source not yet seen in its ledger."""

    async def create_card(self, rule: dict[str, Any], event: Event) -> str:
        """Create the card for an event; returns its id."""

    async def start_card(self, rule: dict[str, Any], card_id: str) -> None:
        """Start the spec run of a card the rule created."""

    def is_card_open(self, card_id: str) -> bool:
        """Whether the card is still on the board and not done."""

    def issue_numbers_on_board(self, forge: str) -> set[int]:
        """The issue numbers of that forge already linked to a card."""

    def has_pr_review(self, rule: dict[str, Any], number: int) -> bool:
        """Whether that PR or MR already has a review, saved or running."""

    async def start_pr_review(self, rule: dict[str, Any], number: int) -> None:
        """Start the review job of that PR or MR as the rule's owner."""


@dataclass
class Summary:
    created: int = 0
    reviews: int = 0
    errors: int = 0


def _message(error: BaseException) -> str:
    text = str(getattr(error, "detail", None) or error) or type(error).__name__
    return f"{text[:MAX_ERROR]}…" if len(text) > MAX_ERROR else text


def _reason(error: BaseException, default: str) -> str:
    return error.reason if isinstance(error, SourceError) else default


class _Book:
    """Writes one rule's lines in the ledger, during one pass."""

    def __init__(
        self,
        ledger: dict[str, Any],
        rule: dict[str, Any],
        status: dict[str, Any],
        previous: dict[str, Any],
        at: str,
        summary: Summary,
    ) -> None:
        self.ledger, self.rule, self.status = ledger, rule, status
        self.previous, self.at, self.summary = previous, at, summary

    def log(self, outcome: str, subject: str, **extra: Any) -> None:
        self.ledger["activity"].append(
            {
                "at": self.at,
                "ruleId": self.rule["id"],
                "ruleName": self.rule["name"],
                "outcome": outcome,
                "subject": subject,
                **{k: v for k, v in extra.items() if v is not None},
            }
        )

    def remember(self, key: str, outcome: str, spec_id: str | None = None) -> None:
        self.ledger["seen"][key] = {
            "ruleId": self.rule["id"],
            "at": self.at,
            "outcome": outcome,
            **({"specId": spec_id} if spec_id else {}),
        }

    def fail(self, reason: str, detail: str, subject: str) -> None:
        self.status["lastError"] = reason
        self.status["lastErrorDetail"] = detail
        self.summary.errors += 1
        # The same failure every few minutes is one line, not a hundred.
        if reason != self.previous.get("lastError") or detail != self.previous.get(
            "lastErrorDetail"
        ):
            self.log("error", subject, reason=reason, detail=detail)


async def run_rules(
    rules: list[dict[str, Any]], ledger: dict[str, Any], deps: Deps
) -> Summary:
    summary = Summary()
    rules = [rule for rule in rules if rule.get("enabled")]
    if not rules:
        return summary
    now = deps.now()
    at = now.isoformat()
    today = local_date(now)
    board_issues: dict[str, set[int]] = {}

    for rule in rules:
        rule_id = rule["id"]
        previous = ledger["statuses"].get(rule_id)
        previous = previous if isinstance(previous, dict) else {}
        created = ledger["created"].get(rule_id)
        created = created if isinstance(created, dict) else {}
        ledger["created"][rule_id] = created
        # Only today's count matters; yesterday's goes.
        for day in [d for d in created if d != today]:
            del created[day]
        status: dict[str, Any] = {
            "lastRunAt": at,
            "createdToday": int(created.get(today, 0)),
            "deferred": 0,
        }

        book = _Book(ledger, rule, status, previous, at, summary)
        log, remember, fail = book.log, book.remember, book.fail

        try:
            source = await deps.read_source(rule, ledger)
        except EXPECTED as error:
            fail(_reason(error, "source_failed"), _message(error), rule["name"])
            ledger["statuses"][rule_id] = status
            continue

        for key, subject, reason in source.ignored:
            remember(key, "ignored")
            log("ignored", subject, reason=reason)
        if source.green:
            ledger["openCi"].pop(rule_id, None)

        for event in source.events:
            if event.key in ledger["seen"]:
                continue
            if event.issue:
                forge = event.issue["forge"]
                if forge not in board_issues:
                    board_issues[forge] = deps.issue_numbers_on_board(forge)
                if event.issue["number"] in board_issues[forge]:
                    remember(event.key, "duplicate")
                    log(
                        "duplicate",
                        event.subject,
                        url=event.url,
                        reason="issue_on_board",
                    )
                    continue
            if event.pr and deps.has_pr_review(rule, event.pr["number"]):
                # Reviewed by hand, or by another rule: one draft per request.
                remember(event.key, "duplicate")
                log(
                    "duplicate", event.subject, url=event.url, reason="already_reviewed"
                )
                continue
            streak = ledger["openCi"].get(rule_id)
            if (
                rule["trigger"]["type"] == "ci_failed"
                and isinstance(streak, str)
                and deps.is_card_open(streak)
            ):
                # Same red streak: the open card is the answer to it.
                remember(event.key, "duplicate", streak)
                log(
                    "duplicate",
                    event.subject,
                    url=event.url,
                    specId=streak,
                    reason="streak_open",
                )
                continue
            if status["createdToday"] >= rule["dailyCap"]:
                # Not remembered: it comes back tomorrow, under tomorrow's cap.
                status["deferred"] += 1
                continue

            if event.pr:
                try:
                    await deps.start_pr_review(rule, event.pr["number"])
                except EXPECTED as error:
                    # Not remembered: the next pass tries again, and logs once.
                    fail(
                        _reason(error, "review_failed"), _message(error), event.subject
                    )
                    continue
                status["createdToday"] += 1
                created[today] = status["createdToday"]
                summary.reviews += 1
                remember(event.key, "review_started")
                log("review_started", event.subject, url=event.url)
                continue

            try:
                card_id = await deps.create_card(rule, event)
            except EXPECTED as error:
                fail(_reason(error, "card_failed"), _message(error), event.subject)
                continue
            status["createdToday"] += 1
            created[today] = status["createdToday"]
            summary.created += 1
            if event.issue:
                board_issues[event.issue["forge"]].add(event.issue["number"])
            if rule["trigger"]["type"] == "ci_failed":
                ledger["openCi"][rule_id] = card_id

            outcome = "created"
            failure: str | None = None
            if not rule.get("draft", True):
                try:
                    await deps.start_card(rule, card_id)
                    outcome = "started"
                except EXPECTED as error:
                    # The card exists; only its launch failed, and the log says so.
                    failure = _message(error)
            remember(event.key, outcome, card_id)
            log(
                outcome,
                event.subject,
                specId=card_id,
                url=event.url,
                reason="not_started" if failure else None,
                detail=failure,
            )
        ledger["statuses"][rule_id] = status
    return summary
