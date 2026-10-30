"""Project rules learned from reviews, adopted by a person (plan of 29 October, IA1).

Two moments say how a project wants its code written better than any analysis
can: a reviewer's thread on the task's pull request that the PR follow-up (G1)
went and fixed, and the feedback a person types when they reject a plan. Each
one becomes a *candidate* here. A candidate does nothing: it waits in
``.workpilot/learning/review-lessons.json`` until a person adopts it, in the
wording they choose, or dismisses it. Only adopted rules reach a prompt, and
they reach every phase (`rules_block`, read by `prompt_injection`).

Why not the brain, where the learning loop's patterns live: a reviewer's
comment is external content (rule S2). Kept as a memory note it could come
back through recall, the Memories tab or the context mesh before anyone read
it. Here it is quoted to nobody until a person turns it into a rule, and
the rule is theirs.

A candidate is never re-created once decided: a dismissed thread stays
dismissed when the PR follow-up sees it again.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path, PurePath
from typing import Any

logger = logging.getLogger(__name__)

LESSONS_FILE = Path(".workpilot") / "learning" / "review-lessons.json"

SOURCES = ("pr_review", "plan_review")
STATUSES = ("pending", "adopted", "dismissed")

MAX_CANDIDATE_CHARS = 600
"""A candidate is the reviewer's first comment, cut here."""
MAX_RULE_CHARS = 500
"""An adopted rule is one short paragraph."""
MAX_PENDING = 50
"""Past this, the oldest pending candidates are dropped, never the decided ones."""
MAX_RULES_IN_PROMPT = 30
MAX_RULES_BLOCK_CHARS = 4_000

_SPACES = re.compile(r"\s+")

RULES_HEADING = "## Project rules adopted from reviews"
_RULES_INTRO = (
    "A person on this project adopted each rule below after a code review or "
    "a rejected plan. Follow them unless the task explicitly says otherwise."
)


def project_root(path: str | Path) -> Path:
    """The project a path belongs to: a task worktree maps to its project.

    Prompts are built in the task's worktree, where ``.workpilot/`` holds no
    learning folder; the rules live in the project that owns it.
    """
    path = Path(path)
    parts = PurePath(path).parts
    for marker in (".workpilot", ".worktrees"):
        if marker in parts:
            index = parts.index(marker)
            if index > 0:
                return Path(*parts[:index])
    return path


def _file(project_dir: str | Path) -> Path:
    return project_root(project_dir) / LESSONS_FILE


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _lesson_id(source: str, ref: str) -> str:
    return hashlib.sha256(f"{source}|{ref}".encode()).hexdigest()[:16]


def _one_line(text: str, limit: int) -> str:
    return _SPACES.sub(" ", text).strip()[:limit].strip()


def load_lessons(project_dir: str | Path) -> list[dict[str, Any]]:
    """Every lesson of the project, oldest first. Empty on anything unreadable."""
    path = _file(project_dir)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.warning("review lessons unreadable: %s", exc)
        return []
    lessons = data.get("lessons") if isinstance(data, dict) else None
    if not isinstance(lessons, list):
        return []
    return [
        lesson
        for lesson in lessons
        if isinstance(lesson, dict)
        and lesson.get("status") in STATUSES
        and lesson.get("source") in SOURCES
        and isinstance(lesson.get("id"), str)
    ]


def _save(project_dir: str | Path, lessons: list[dict[str, Any]]) -> bool:
    path = _file(project_dir)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"version": 1, "lessons": lessons}, indent=2, ensure_ascii=False)
            + "\n",
            encoding="utf-8",
        )
        return True
    except OSError as exc:
        logger.warning("could not write review lessons: %s", exc)
        return False


def _cap_pending(lessons: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pending = [lesson for lesson in lessons if lesson["status"] == "pending"]
    excess = len(pending) - MAX_PENDING
    if excess <= 0:
        return lessons
    dropped = {lesson["id"] for lesson in pending[:excess]}
    return [lesson for lesson in lessons if lesson["id"] not in dropped]


def _add(project_dir: str | Path, candidates: Iterable[dict[str, Any]]) -> int:
    lessons = load_lessons(project_dir)
    known = {lesson["id"] for lesson in lessons}
    added = 0
    for candidate in candidates:
        if candidate["id"] in known:
            continue
        lessons.append(candidate)
        known.add(candidate["id"])
        added += 1
    if added and not _save(project_dir, _cap_pending(lessons)):
        return 0
    return added


def record_review_threads(
    project_dir: str | Path, pr_url: str, threads: Iterable[Any]
) -> int:
    """One candidate per review thread the PR follow-up fixed. Returns how many.

    The text is the thread's first comment, cleaned like any forge text
    (`security.untrusted`). A comment rated ``blocked`` is not kept; one rated
    ``suspect`` is kept with its findings, so the person sees why before
    deciding. Never raises: this runs after a fix was pushed.
    """
    try:
        from security.untrusted import clean_untrusted

        candidates = []
        for thread in threads:
            comments = getattr(thread, "comments", ()) or ()
            if not comments:
                continue
            first = comments[0]
            cleaned = clean_untrusted(
                str(getattr(first, "body", "")),
                kind="comment",
                source=f"review:{getattr(first, 'url', '') or thread.id}",
            )
            text = _one_line(cleaned.text, MAX_CANDIDATE_CHARS)
            if not text or cleaned.threat_level == "blocked":
                continue
            candidates.append(
                {
                    "id": _lesson_id("pr_review", str(thread.id)),
                    "source": "pr_review",
                    "status": "pending",
                    "text": text,
                    "rule": "",
                    "flags": list(cleaned.findings) if cleaned.suspicious else [],
                    "origin": {
                        "pr_url": pr_url[:300],
                        "path": str(getattr(thread, "path", ""))[:300],
                        "author": str(getattr(first, "author", ""))[:100],
                        "url": str(getattr(first, "url", ""))[:300],
                    },
                    "seen_at": _now(),
                    "decided_at": "",
                }
            )
        return _add(project_dir, candidates)
    except Exception as exc:  # noqa: BLE001 - learning never fails a fix round
        logger.warning("review lessons not recorded: %s", exc)
        return 0


def record_plan_feedback(project_dir: str | Path, spec_id: str, feedback: str) -> bool:
    """A candidate from the feedback a person gave when rejecting a plan."""
    text = _one_line(feedback or "", MAX_CANDIDATE_CHARS)
    spec = _one_line(spec_id or "", 200)
    if not text or not spec:
        return False
    digest = hashlib.sha256(text.encode()).hexdigest()[:12]
    candidate = {
        "id": _lesson_id("plan_review", f"{spec}:{digest}"),
        "source": "plan_review",
        "status": "pending",
        "text": text,
        "rule": "",
        "flags": [],
        "origin": {"spec": spec},
        "seen_at": _now(),
        "decided_at": "",
    }
    return _add(project_dir, [candidate]) == 1


def _decide(
    project_dir: str | Path, lesson_id: str, status: str, rule: str = ""
) -> dict[str, Any] | None:
    lessons = load_lessons(project_dir)
    for lesson in lessons:
        if lesson["id"] != lesson_id:
            continue
        lesson["status"] = status
        lesson["rule"] = rule if status == "adopted" else lesson.get("rule", "")
        lesson["decided_at"] = _now()
        return lesson if _save(project_dir, lessons) else None
    return None


def adopt(
    project_dir: str | Path, lesson_id: str, rule: str | None = None
) -> dict[str, Any] | None:
    """A person makes a candidate a rule, in their own wording or as it stands.

    Returns the lesson, or None when it does not exist or the rule is empty.
    """
    current = next(
        (lesson for lesson in load_lessons(project_dir) if lesson["id"] == lesson_id),
        None,
    )
    if current is None:
        return None
    wording = _one_line(rule if rule is not None else current["text"], MAX_RULE_CHARS)
    if not wording:
        return None
    return _decide(project_dir, lesson_id, "adopted", wording)


def dismiss(project_dir: str | Path, lesson_id: str) -> bool:
    """A person turns a candidate down, or withdraws an adopted rule."""
    return _decide(project_dir, lesson_id, "dismissed") is not None


def adopted_rules(project_dir: str | Path) -> list[str]:
    return [
        lesson["rule"]
        for lesson in load_lessons(project_dir)
        if lesson["status"] == "adopted" and lesson.get("rule")
    ]


def rules_block(project_dir: str | Path) -> str:
    """The adopted rules as a prompt section, newest first, or "" without any.

    Bounded by count and size; a rule is never cut in the middle.
    """
    try:
        rules = list(reversed(adopted_rules(project_dir)))[:MAX_RULES_IN_PROMPT]
    except Exception as exc:  # noqa: BLE001 - a prompt is built without them
        logger.debug("review rules unavailable: %s", exc)
        return ""
    if not rules:
        return ""
    lines = [RULES_HEADING, "", _RULES_INTRO, ""]
    size = sum(len(line) + 1 for line in lines)
    for rule in rules:
        line = f"- {rule}"
        if size + len(line) + 1 > MAX_RULES_BLOCK_CHARS:
            break
        lines.append(line)
        size += len(line) + 1
    return "\n".join(lines) + "\n"
