"""A server board question answered: understand, search, judge, with a fake model."""

from __future__ import annotations

import asyncio
import json
import re

from board_ask import answer as aw
from board_ask.tickets import Ticket


def _tickets(count: int = 3) -> list[Ticket]:
    base = [
        Ticket(
            id="001-admin",
            title="Refonte de la page d'administration",
            state="done",
            updated_at="2026-11-01T10:00:00+00:00",
        ),
        Ticket(
            id="002-login", title="Login form", description="Sign in", state="planned"
        ),
        Ticket(
            id="roadmap:f1",
            title="Admin audit log",
            state="planned",
            kind="roadmap",
            archived=True,
        ),
    ]
    extra = [
        Ticket(id=f"{i:03d}-filler", title=f"Filler {i}")
        for i in range(10, 10 + count - 3)
    ]
    return base + extra


class Model:
    """Answers the two prompts it is given, and records them."""

    def __init__(self, plan: str = "", judgement: str = "") -> None:
        self.plan, self.judgement, self.prompts = plan, judgement, []

    async def __call__(self, prompt: str, system: str) -> str:
        assert system == aw.SYSTEM_PROMPT
        self.prompts.append(prompt)
        return self.plan if len(self.prompts) == 1 else self.judgement


def _ask(tickets, question, model, **kwargs):
    return asyncio.run(aw.ask_board(tickets, question, model, **kwargs))


def test_the_model_understands_searches_and_judges():
    model = Model(
        plan=json.dumps(
            {
                "question": "How was the admin page reviewed?",
                "terms": ["administration", "", 3],
            }
        ),
        judgement="Sure: "
        + json.dumps(
            {
                "answer": "Done in [T1] , planned in [T3, T9].",
                "matches": [
                    {
                        "ref": "[T3]",
                        "coverage": "related",
                        "reason": "  an audit\nlog ",
                    },
                    {"ref": "T1", "coverage": "full", "reason": "redone"},
                    {"ref": "T1", "coverage": "partial"},
                    {"ref": "T9"},
                    "junk",
                    {"ref": 3},
                    {"ref": "T2", "coverage": "everything"},
                ],
            }
        ),
    )
    history = [{"question": "et la connexion ?", "answer": "planned"}]
    result = _ask(
        _tickets(),
        "  Comment a été revue la page d'admin ?  ",
        model,
        language="fr",
        history=history,
    )
    assert result["mode"] == "ai" and result["searched"] == 3
    assert result["expandedTerms"] == ["administration"]
    assert result["answer"] == "Done in [1], planned in [2]."
    # Each reference names the ticket the judge prompt gave it.
    titles = dict(re.findall(r"\[(T\d+)\]\nTitle: (.*)", model.prompts[1]))
    by_title = {t.title: t for t in _tickets()}
    expected = [
        aw.to_match(by_title[titles["T1"]], coverage="full", reason="redone"),
        aw.to_match(by_title[titles["T3"]], coverage="related", reason="an audit log"),
        aw.to_match(by_title[titles["T2"]], coverage="related"),
    ]
    assert result["matches"] == expected
    assert expected[0]["taskId"] == "001-admin"
    assert any(m.get("kind") == "roadmap" and m.get("archived") for m in expected)
    assert expected[0]["updatedAt"] == "2026-11-01T10:00:00+00:00"
    understand, judge = model.prompts
    # The question and the conversation are quoted; the board's languages asked for.
    assert "Comment a été revue la page d'admin ?" in understand
    assert (
        "Earlier in this conversation" in understand
        and "et la connexion ?" in understand
    )
    assert "English" in understand
    assert "How was the admin page reviewed?" in judge and "[T1]" in judge
    assert "in French." in judge


def test_without_a_model_the_keywords_answer():
    result = _ask(_tickets(), "admin", Model())
    assert result["mode"] == "keywords" and result["answer"] == ""
    assert [m["taskId"] for m in result["matches"]][:2] in (
        ["001-admin", "roadmap:f1"],
        ["roadmap:f1", "001-admin"],
    )
    assert "expandedTerms" not in result
    # Unreadable output is no model either.
    for plan, judgement in (
        ("not json", "{"),
        ("[1]", '{"answer": 3}'),
        ('{"question": "", "terms": []}', "{}"),
    ):
        assert _ask(_tickets(), "admin", Model(plan, judgement))["mode"] == "keywords"


def test_a_large_board_hands_the_model_its_best_candidates():
    tickets = _tickets(aw.SMALL_BOARD + 5)
    model = Model(
        plan='{"question": "admin", "terms": []}',
        judgement='{"answer": "None.", "matches": []}',
    )
    result = _ask(tickets, "admin", model)
    assert result == {
        "answer": "None.",
        "matches": [],
        "mode": "ai",
        "searched": len(tickets),
    }
    judge = model.prompts[1]
    assert "Filler" not in judge and "[T2]" in judge
    # Nothing shares a word with the question: the model is not asked again.
    nothing = Model(plan='{"question": "zzz", "terms": ["qqq"]}')
    result = _ask(tickets, "zzz", nothing)
    assert result["matches"] == [] and result["expandedTerms"] == ["qqq"]
    assert len(nothing.prompts) == 1


def test_an_empty_board_or_question_asks_nothing():
    model = Model()
    assert _ask([], "admin", model) == {
        "answer": "",
        "matches": [],
        "mode": "keywords",
        "searched": 0,
    }
    assert _ask(_tickets(), "   ", model)["searched"] == 3
    assert model.prompts == []


def test_an_unknown_language_falls_back_to_english_and_dates_may_be_odd():
    model = Model(plan="", judgement='{"answer": "ok", "matches": []}')
    tickets = [
        Ticket(id="a", title="A", updated_at="not a date"),
        Ticket(id="b", title="B"),
    ]
    assert _ask(tickets, "A", model, language="xx")["mode"] == "ai"
    assert "in English." in model.prompts[1]
    assert aw._recency(tickets[0]) == 0.0


def test_citations_of_tickets_not_kept_are_dropped():
    assert aw.cite_matches("See [T2] and [T5] .", ["T2"]) == "See [1] and."
    assert aw.cite_matches("[T1,T2]", ["T2", "T1"]) == "[2][1]"


def test_only_a_json_object_is_read():
    assert aw.json_object('noise {"a": 1} noise') == {"a": 1}
    assert aw.json_object("{not json}") is None
    assert aw.json_object("no braces") is None
    assert aw.json_object('{"a": [1]}"') == {"a": [1]}
