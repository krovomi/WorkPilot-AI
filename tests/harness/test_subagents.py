"""What a sub-agent brings back: the contract, the tolerant parser, the cap."""

from __future__ import annotations

import json

import pytest
from harness.domain import UsageLedger
from harness.domain.subagents import (
    CHARS_PER_TOKEN,
    CONTRACT_HEADING,
    EMPTY_RESULT,
    RESULT_CAP_TOKENS,
    Conclusion,
    SubagentReturn,
    bound_result,
    contract_text,
    estimate_tokens,
    measure_returned,
    parse_conclusion,
    with_contract,
)

CAP = 100  # tokens: 400 characters
CAP_CHARS = CAP * CHARS_PER_TOKEN


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            '{"conclusion": "Tests pass.", "files": ["a.py"], "evidence": ["3 passed"]}',
            Conclusion("Tests pass.", ("a.py",), ("3 passed",), structured=True),
        ),
        (
            '```json\n{"conclusion": "Fenced.", "files": [], "evidence": []}\n```',
            Conclusion("Fenced.", structured=True),
        ),
        (
            '```\n{"conclusion": "Fenced, no language."}\n```',
            Conclusion("Fenced, no language.", structured=True),
        ),
        # A single string is a list of one; empty and null items are dropped.
        (
            '{"conclusion": "x", "files": "a.py", "evidence": ["", null, " b "]}',
            Conclusion("x", ("a.py",), ("b",), structured=True),
        ),
        # Anything else is plain text, all of it the conclusion.
        ("  All good: 12 passed.  ", Conclusion("All good: 12 passed.")),
        (
            '{"summary": "no conclusion key"}',
            Conclusion('{"summary": "no conclusion key"}'),
        ),
        ('["a list"]', Conclusion('["a list"]')),
        ("```python\nprint(1)\n```", Conclusion("```python\nprint(1)\n```")),
        ('Result:\n{"conclusion": "prose around it"}', None),
    ],
)
def test_the_parser_reads_the_contract_and_tolerates_plain_text(text, expected):
    parsed = parse_conclusion(text)
    if expected is None:
        assert not parsed.structured
        assert parsed.conclusion == text
    else:
        assert parsed == expected


def test_under_the_cap_a_result_passes_as_it_came():
    text = '{"conclusion": "ok", "files": ["a.py"], "evidence": ["1 passed"]}'
    bound = bound_result(f"\n{text}\n", cap_tokens=CAP)
    assert bound.text == text
    assert bound.structured
    assert bound.report == SubagentReturn(
        estimate_tokens(text), estimate_tokens(text), cut=False
    )


@pytest.mark.parametrize("text", ["", "   \n\t "])
def test_an_empty_result_is_marked(text):
    bound = bound_result(text, cap_tokens=CAP)
    assert bound.text == EMPTY_RESULT
    assert bound.report.received_tokens == 0
    assert not bound.report.cut


def test_plain_text_over_the_cap_is_cut_on_a_line_and_marked_first():
    lines = [f"line {i}: " + "x" * 30 for i in range(1, 101)]
    text = "\n".join(lines)
    bound = bound_result(text, cap_tokens=CAP)

    marker, _, body = bound.text.partition("\n")
    assert marker.startswith("[WorkPilot cut this sub-agent result: ~")
    assert f"~{estimate_tokens(text)} tokens, over its cap of {CAP}" in marker
    assert "Treat it as incomplete." in marker
    # Whole lines from the head, nothing invented.
    assert text.startswith(body)
    assert body.split("\n")[-1] in lines
    shown = len(body.split("\n"))
    assert f"lines 1–{shown} of 100 are shown" in marker
    assert len(bound.text) <= CAP_CHARS
    assert bound.report.cut
    assert bound.report.received_tokens == estimate_tokens(text)
    assert bound.report.returned_tokens == estimate_tokens(bound.text)


def test_a_single_line_longer_than_the_cap_is_cut_and_says_so():
    bound = bound_result("y" * 5_000, cap_tokens=CAP)
    assert "line 1 cut" in bound.text.partition("\n")[0]
    assert len(bound.text) <= CAP_CHARS


def test_over_the_cap_the_conclusion_comes_before_files_and_evidence():
    data = {
        "evidence": [f"log line {i} " + "e" * 40 for i in range(50)],
        "files": ["src/a.py", "src/b.py"],
        "conclusion": "The bug is in the retry loop.",
    }
    bound = bound_result(json.dumps(data), cap_tokens=300)

    marker, _, body = bound.text.partition("\n")
    kept = json.loads(body)
    assert kept["conclusion"] == data["conclusion"]
    assert kept["files"] == data["files"]
    assert 0 < len(kept["evidence"]) < len(data["evidence"])
    assert kept["evidence"] == data["evidence"][: len(kept["evidence"])]
    assert (
        f"kept: the conclusion, 2 of 2 files, {len(kept['evidence'])} of 50 "
        "pieces of evidence" in marker
    )
    assert len(bound.text) <= 300 * CHARS_PER_TOKEN
    assert bound.structured


def test_a_conclusion_longer_than_the_cap_is_cut_itself():
    data = {"conclusion": 'z"\n' * 400, "files": ["a.py"], "evidence": ["e"]}
    bound = bound_result(json.dumps(data), cap_tokens=CAP)
    marker, _, body = bound.text.partition("\n")
    kept = json.loads(body)
    assert data["conclusion"].strip().startswith(kept["conclusion"])
    assert kept["files"] == [] and kept["evidence"] == []
    assert "the conclusion (cut), 0 of 1 files" in marker
    assert len(bound.text) <= CAP_CHARS


@pytest.mark.parametrize("size", [CAP_CHARS, CAP_CHARS + 1, 10 * CAP_CHARS, 1_000_000])
@pytest.mark.parametrize("shape", ["plain", "lines", "structured"])
def test_the_cap_bounds_what_comes_back(size, shape):
    if shape == "plain":
        text = "p" * size
    elif shape == "lines":
        text = ("a line of text\n" * (size // 15 + 1))[:size]
    else:
        filler = "f" * max(0, size - 60)
        text = json.dumps({"conclusion": "c", "files": [], "evidence": [filler]})
    bound = bound_result(text, cap_tokens=CAP)
    assert len(bound.text) <= CAP_CHARS
    assert bound.report.cut == (len(text.strip()) > CAP_CHARS)


def test_the_default_cap_leaves_room_under_the_untrusted_text_limit():
    # security/untrusted.py keeps 10 000 characters of a text it delimits: a
    # result cut to the default cap must not be cut a second time there.
    bound = bound_result("w" * 50_000)
    assert len(bound.text) <= RESULT_CAP_TOKENS * CHARS_PER_TOKEN < 10_000


def test_the_ledger_side_reads_a_cut_from_its_mark():
    text = "\n".join("r" * 50 for _ in range(100))
    bound = bound_result(text, cap_tokens=CAP)
    # As the parent reads it: delimited, the mark on its own line.
    read = f"<user_content>\n{bound.text}\n</user_content>"
    measured = measure_returned(read)
    assert measured.cut
    assert measured.received_tokens == estimate_tokens(text)
    assert measured.returned_tokens == estimate_tokens(read)


def test_an_uncut_result_measures_as_it_reads():
    assert measure_returned("short") == SubagentReturn(2, 2, cut=False)


def test_the_contract_is_said_once_with_its_cap():
    prompt = with_contract("You review code.", 1_500)
    assert prompt.startswith("You review code.\n\n" + CONTRACT_HEADING)
    assert "under 1500 tokens" in prompt
    assert '"conclusion"' in prompt and '"files"' in prompt and '"evidence"' in prompt
    assert with_contract(prompt) == prompt
    assert with_contract("") == contract_text()


def test_the_ledger_keeps_what_came_back_in_numbers():
    ledger = UsageLedger()
    ledger.record_return(SubagentReturn(5_000, 2_010, cut=True))
    ledger.record_return(SubagentReturn(300, 310, cut=False))
    ledger.record_return(None)
    summary = ledger.summary()
    assert summary["subagentReturns"] == 2
    assert summary["subagentReturnTokens"] == 2_320
    assert summary["subagentReturnsCut"] == 1
    json.dumps(summary)
