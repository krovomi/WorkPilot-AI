"""« Interroger le tableau » on a server project: a question, the tickets that relate.

The desktop panel's steps (``apps/frontend/src/main/board-ask/
board-ask-service.ts``), run on the server for the phone app:

1. **Understand.** The model turns the question (and, for a follow-up, the
   conversation) into one standalone question and the words a ticket about
   it would use, in every language the board is written in.
2. **Search.** The keyword search (``search.KeywordIndex``) over every ticket,
   the model's words included; a small board is read whole.
3. **Judge.** The model reads the candidates and says, for each one that
   relates, how much of the question it covers and why, then answers citing
   them.

Without an answer from the model (no provider, a failure, unreadable output)
the keyword ranking answers alone. The question, the conversation and the
tickets enter the prompts as quoted data (S2, ``quote_untrusted``); what
comes back is read as JSON into closed lists and bounded strings, and a
ticket is only named by a reference this code gave. The model is handed in
(``complete``), so this module imports no client.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable, Sequence
from datetime import datetime
from typing import Any

from board_ask.search import KeywordIndex, detect_languages
from board_ask.tickets import Ticket, ticket_digest, ticket_document
from security.untrusted import quote_untrusted

#: A board this small is read whole by the model: nothing to miss.
SMALL_BOARD = 30
#: Candidates the model reads on a larger board.
MAX_CANDIDATES = 30
#: Tickets a keyword answer lists.
KEYWORD_RESULTS = 15
MAX_QUESTION = 1000
MAX_TURNS = 4
DIGEST_CHARS = 900
MAX_TERMS = 60
MAX_TERM_CHARS = 60
MAX_ANSWER_CHARS = 3000
MAX_REASON_CHARS = 300
COVERAGES = ("full", "partial", "related")
_COVERAGE_ORDER = {c: i for i, c in enumerate(COVERAGES)}

LANGUAGE_NAMES = {
    "en": "English",
    "fr": "French",
    "es": "Spanish",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "nl": "Dutch",
}
SYSTEM_PROMPT = "You output ONLY valid JSON. No prose, no markdown fences."

#: One completion: the prompt and the system prompt in, the text out ("" on failure).
Complete = Callable[[str, str], Awaitable[str]]


def json_object(raw: str) -> dict[str, Any] | None:
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        value = json.loads(raw[start : end + 1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def one_line(value: Any, limit: int) -> str:
    return " ".join(value.split())[:limit] if isinstance(value, str) else ""


def _quote(label: str, text: str) -> str:
    quoted = quote_untrusted(text, source="board_ask")
    return f"{label}:\n{quoted}"


def _conversation(history: Sequence[dict[str, str]]) -> str:
    turns = list(history)[-MAX_TURNS:]
    if not turns:
        return ""
    text = "\n\n".join(
        f"Q: {turn['question'][:500]}\nA: {turn['answer'][:800]}" for turn in turns
    )
    return _quote("Earlier in this conversation", text)


def understand_prompt(
    question: str, history: Sequence[dict[str, str]], board_languages: Sequence[str]
) -> str:
    languages = [
        LANGUAGE_NAMES.get(c, c) for c in dict.fromkeys(["en", *board_languages])
    ]
    earlier = _conversation(history)
    return "\n".join(
        [
            "A person searches the tickets of a software project's board (features, fixes, tasks) to find every",
            "ticket related to their question, for instance to learn whether a feature was already built.",
            "",
            "1. Rewrite the question as one standalone question (resolve what a follow-up refers to).",
            "2. List the words and short phrases a ticket about it could contain, in each of: "
            + ", ".join(languages)
            + ".",
            "   Include synonyms, the usual technical names (route, component, file or table names), and the",
            "   related concepts a developer would write (for an admin page: administration, back-office, admin",
            "   panel, settings, dashboard, permissions...). Single words or phrases of at most 3 words.",
            f"   At most {MAX_TERMS} items.",
            "",
            'Output ONLY a JSON object: {"question": "...", "terms": ["...", "..."]}',
            "",
            *([earlier, ""] if earlier else []),
            _quote("Question", question),
        ]
    )


def parse_plan(raw: str) -> tuple[str, list[str]] | None:
    """The standalone question and the search words, or None."""
    parsed = json_object(raw) if raw else None
    if parsed is None:
        return None
    terms = [
        one_line(t, MAX_TERM_CHARS)
        for t in parsed.get("terms") or []
        if isinstance(t, str)
    ]
    terms = [t for t in terms if t][:MAX_TERMS]
    question = one_line(parsed.get("question"), MAX_QUESTION)
    if not question and not terms:
        return None
    return question, terms


def judge_prompt(
    question: str,
    candidates: Sequence[tuple[str, Ticket]],
    language: str,
    history: Sequence[dict[str, str]],
) -> str:
    fallback = LANGUAGE_NAMES.get(language, "English")
    tickets = "\n\n".join(
        f"[{ref}]\n{ticket_digest(t, DIGEST_CHARS)}" for ref, t in candidates
    )
    earlier = _conversation(history)
    return "\n".join(
        [
            "A person asks a question about the tickets of a software project's board, often to learn whether",
            "a feature they plan was already built, even partly. Tickets may be written in another language",
            "than the question: judge them by meaning, not by shared words.",
            "",
            "For each ticket that relates to the question, give:",
            '- "coverage": "full" when it already delivers or plans what the question is about, "partial" when it',
            '  covers part of it, "related" when it only touches the subject;',
            '- "reason": one short sentence saying what it did or plans, and how that relates.',
            "Leave out the tickets that do not relate. Keep the tickets' state in mind: a planned or abandoned",
            "ticket did not deliver anything. A ticket with a Kind line is not a card: a roadmap feature or an",
            "idea is a plan.",
            "",
            'Then write "answer": a short answer to the question (at most 5 sentences) that cites tickets by their',
            "reference in brackets, like [T3]. Say plainly when nothing relates.",
            "",
            'Write "answer" and every "reason" in the language of the question; if it cannot be told, in '
            + fallback
            + ".",
            'Output ONLY a JSON object: {"answer": "...", "matches": [{"ref": "T1", "coverage": "full", "reason": "..."}]}',
            "",
            *([earlier, ""] if earlier else []),
            _quote("Question", question),
            "",
            _quote("Tickets", tickets or "(none)"),
        ]
    )


def parse_judgement(
    raw: str, refs: set[str]
) -> tuple[str, list[dict[str, str]]] | None:
    """The answer and the judged references (known ones only, once each), or None."""
    parsed = json_object(raw) if raw else None
    if parsed is None or not isinstance(parsed.get("answer"), str):
        return None
    seen: set[str] = set()
    matches: list[dict[str, str]] = []
    for item in parsed.get("matches") or []:
        if not isinstance(item, dict):
            continue
        ref = item.get("ref")
        key = ref.strip().strip("[]") if isinstance(ref, str) else ""
        if key not in refs or key in seen:
            continue
        seen.add(key)
        coverage = item.get("coverage")
        matches.append(
            {
                "ref": key,
                "coverage": coverage if coverage in COVERAGES else "related",
                "reason": one_line(item.get("reason"), MAX_REASON_CHARS),
            }
        )
    return parsed["answer"].strip()[:MAX_ANSWER_CHARS], matches


_CITATION = re.compile(r"\[(T\d+)(?:\s*,\s*(T\d+))*\]")


def cite_matches(answer: str, order: Sequence[str]) -> str:
    """``[T7]`` turned into ``[n]``, the position of that ticket in the matches;
    a reference to a ticket not kept is dropped."""

    def replace(match: re.Match[str]) -> str:
        cited = [
            order.index(r) for r in re.findall(r"T\d+", match.group(0)) if r in order
        ]
        return "".join(f"[{i + 1}]" for i in cited)

    text = _CITATION.sub(replace, answer)
    text = re.sub(r"[ \t]+([.,;:!?])", r"\1", text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()


def to_match(ticket: Ticket, **extra: str) -> dict[str, Any]:
    """A ticket as the apps show it (``BoardAskMatch``)."""
    match: dict[str, Any] = {
        "taskId": ticket.id,
        "title": ticket.title,
        "state": ticket.state,
    }
    if ticket.updated_at:
        match["updatedAt"] = ticket.updated_at
    if ticket.archived:
        match["archived"] = True
    if ticket.kind:
        match["kind"] = ticket.kind
    match.update({k: v for k, v in extra.items() if v})
    return match


async def ask_board(
    tickets: Sequence[Ticket],
    question: str,
    complete: Complete,
    *,
    language: str = "en",
    history: Sequence[dict[str, str]] = (),
) -> dict[str, Any]:
    """The answer to a question about these tickets (``BoardAskResult``)."""
    question = question.strip()[:MAX_QUESTION]
    if not tickets or not question:
        return {
            "answer": "",
            "matches": [],
            "mode": "keywords",
            "searched": len(tickets),
        }
    by_id = {t.id: t for t in tickets}
    index = KeywordIndex(ticket_document(t) for t in tickets)
    languages = detect_languages(f"{t.title} {t.description}" for t in tickets)[:4]

    plan = parse_plan(
        await complete(understand_prompt(question, history, languages), SYSTEM_PROMPT)
    )
    standalone, terms = plan or ("", [])
    query = [(question, 1.0)]
    if standalone and standalone != question:
        query.append((standalone, 1.0))
    query += [(term, 0.8) for term in terms]
    # A follow-up's words are in the conversation more than in itself.
    query += [(turn["question"], 0.4) for turn in list(history)[-1:]]
    hits = index.search(query, max(KEYWORD_RESULTS, MAX_CANDIDATES))
    expanded = {"expandedTerms": terms} if terms else {}

    def keyword_answer() -> dict[str, Any]:
        return {
            "answer": "",
            "matches": [to_match(by_id[i]) for i in hits[:KEYWORD_RESULTS]],
            "mode": "keywords",
            "searched": len(tickets),
            **expanded,
        }

    if len(tickets) <= SMALL_BOARD:
        rank = {doc_id: i for i, doc_id in enumerate(hits)}
        candidates = sorted(
            tickets,
            key=lambda t: (rank.get(t.id, len(rank)), -_recency(t)),
        )
    else:
        candidates = [by_id[i] for i in hits]
    if not candidates:
        return keyword_answer()

    refs = [(f"T{i + 1}", t) for i, t in enumerate(candidates[:MAX_CANDIDATES])]
    judged = parse_judgement(
        await complete(
            judge_prompt(standalone or question, refs, language, history), SYSTEM_PROMPT
        ),
        {ref for ref, _ in refs},
    )
    if judged is None:
        return keyword_answer()
    answer, judged_matches = judged
    by_ref = dict(refs)
    kept = sorted(
        enumerate(judged_matches),
        key=lambda item: (_COVERAGE_ORDER[item[1]["coverage"]], item[0]),
    )
    return {
        "answer": cite_matches(answer, [m["ref"] for _, m in kept]),
        "matches": [
            to_match(by_ref[m["ref"]], coverage=m["coverage"], reason=m["reason"])
            for _, m in kept
        ],
        "mode": "ai",
        "searched": len(tickets),
        **expanded,
    }


def _recency(ticket: Ticket) -> float:
    try:
        return datetime.fromisoformat(ticket.updated_at or "").timestamp()
    except ValueError:
        return 0.0
