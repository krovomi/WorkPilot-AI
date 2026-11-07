"""Known injection payloads replayed through the path forge content takes.

Every issue body, pull request text and review comment reaches a prompt
through `security.untrusted` (rule S2). The middleware tests check the guard's
plumbing; this checks what it catches (plan of 29 October, S4). A payload of
corpus.yaml passes when it is neutralised (its marker is no longer in the
cleaned text) or flagged (rated suspect or blocked: written to the spec's
ledger, logged, refused under WORKPILOT_INJECTION_GUARD=block when blocked).
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from security.untrusted import (
    GUARD_MODE_ENV_VAR,
    LEDGER_FILENAME,
    _forge_findings,
    clean_untrusted,
    quote_untrusted,
)

CORPUS = yaml.safe_load(
    (Path(__file__).parent / "corpus.yaml").read_text(encoding="utf-8")
)
PAYLOADS = CORPUS["payloads"]
FENCE_START, FENCE_END = "<user_content>", "</user_content>"


def test_the_corpus_is_the_size_the_plan_asked_for():
    ids = [payload["id"] for payload in PAYLOADS]
    assert len(ids) >= 50
    assert len(set(ids)) == len(ids)
    for payload in PAYLOADS:
        assert payload["marker"] in payload["text"], payload["id"]


@pytest.mark.parametrize("payload", PAYLOADS, ids=lambda p: p["id"])
def test_each_payload_is_neutralised_or_flagged(payload):
    cleaned = clean_untrusted(payload["text"], kind=payload["carrier"])
    neutralised = payload["marker"] not in cleaned.text
    assert neutralised or cleaned.suspicious, (
        f"{payload['id']} reaches the prompt unflagged: {cleaned.text!r}"
    )


@pytest.mark.parametrize("payload", PAYLOADS, ids=lambda p: p["id"])
def test_each_payload_stays_inside_one_fence(payload):
    quoted = quote_untrusted(payload["text"], kind=payload["carrier"])
    assert quoted.startswith(FENCE_START) and quoted.endswith(FENCE_END)
    # A payload cannot close the fence early and speak outside it.
    inner = quoted[len(FENCE_START) : -len(FENCE_END)]
    assert FENCE_START not in inner and FENCE_END not in inner


def test_a_flagged_payload_is_written_to_the_ledger(tmp_path):
    payload = next(p for p in PAYLOADS if p["id"] == "note-to-ai")
    quote_untrusted(payload["text"], kind=payload["carrier"], spec_dir=tmp_path)
    ledger = (tmp_path / LEDGER_FILENAME).read_text(encoding="utf-8")
    assert "Text addressed to the agent" in ledger
    assert payload["text"] not in ledger  # what was seen, never the text itself


def test_block_mode_refuses_what_is_rated_blocked(monkeypatch):
    monkeypatch.setenv(GUARD_MODE_ENV_VAR, "block")
    blocked = [
        p
        for p in PAYLOADS
        if clean_untrusted(p["text"], kind=p["carrier"]).threat_level == "blocked"
    ]
    assert blocked
    for payload in blocked:
        quoted = quote_untrusted(payload["text"], kind=payload["carrier"])
        assert payload["marker"] not in quoted, payload["id"]
        assert "Ask a human to read it" in quoted


@pytest.mark.parametrize("text", CORPUS["benign"])
def test_an_ordinary_report_is_not_blocked_nor_seen_as_aimed_at_the_agent(text):
    cleaned = clean_untrusted(text)
    assert cleaned.threat_level != "blocked"
    assert cleaned.text == text
    assert _forge_findings(text) == []
