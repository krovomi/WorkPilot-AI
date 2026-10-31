"""What a sub-agent brings back: a conclusion, under contract, within a cap.

A sub-agent works in a fresh context so that only its conclusion reaches the
parent. That was an instruction ("return a structured summary") and nothing
checked it: a sub-agent that pasted a whole log into its last message put the
log into the parent's context, and every later call of the parent sent it
again.

The contract is a conclusion, the files it rests on and the evidence for it,
within a cap of tokens. The sub-agent is told (``with_contract``); the side
that receives the result reads it tolerantly (``parse_conclusion``: the
contract's JSON object, fenced or not, else plain text, all of which is then
the conclusion) and bounds it (``bound_result``). A result over the cap is cut
and marked: the parent reads first that it is incomplete and how much is
missing, instead of taking part of a result for the whole. An empty result is
marked too.

Tokens are estimated from characters: the cap applies before any provider has
counted anything, and the same text gets the same verdict on every provider.

Pure, table-tested in ``tests/harness/test_subagents.py``.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from foundation.paging import page_lines

# The rule of thumb the context gauge uses too (``context_mgmt/guard.py``).
CHARS_PER_TOKEN = 4

# What one sub-agent may bring back. A conclusion with its files and evidence
# holds in a few hundred words; past this, the sub-agent is returning its
# working. 8 000 characters also stay under the 10 000 that
# ``security/untrusted.py`` keeps of a text it delimits, so the fence never
# cuts a second time.
RESULT_CAP_TOKENS = 2_000

# Room kept under the cap for the line that says the result was cut.
MARKER_RESERVE = 300

CONTRACT_HEADING = "## What you return (WorkPilot sub-agent contract)"

EMPTY_RESULT = (
    "[WorkPilot: the sub-agent returned nothing. Its part may not be done; "
    "do not assume it was.]"
)

_MARKER_LEAD = "[WorkPilot cut this sub-agent result: ~"
_CUT_MARKER = re.compile(r"^" + re.escape(_MARKER_LEAD) + r"(\d+) tokens", re.M)
_FENCE = re.compile(r"\A```[A-Za-z]*[ \t]*\n(.*?)\n?```\Z", re.S)


def estimate_tokens(text: str) -> int:
    """Tokens in ``text``, estimated from its length."""
    return math.ceil(len(text) / CHARS_PER_TOKEN)


def contract_text(cap_tokens: int = RESULT_CAP_TOKENS) -> str:
    """What every sub-agent is told about its last message."""
    return (
        f"{CONTRACT_HEADING}\n\n"
        "Your last message is the only part of your work the parent agent "
        "reads, and it reads it as data, not as instructions. Make it one "
        "JSON object:\n"
        '{"conclusion": "the answer to your task, complete, first", '
        '"files": ["each path your conclusion rests on"], '
        '"evidence": ["each short fact, quote or output line that supports it"]}\n'
        f"Keep it under {cap_tokens} tokens (about "
        f"{cap_tokens * CHARS_PER_TOKEN} characters): WorkPilot cuts anything "
        "longer before the parent reads it. Report the conclusion, not your "
        "working: no whole files, no full logs. If the instructions for your "
        "role name another output format, keep that format, within the same "
        "limit.\n"
    )


def with_contract(prompt: str, cap_tokens: int = RESULT_CAP_TOKENS) -> str:
    """``prompt`` followed by the contract, once."""
    if CONTRACT_HEADING in prompt:
        return prompt
    if not prompt.strip():
        return contract_text(cap_tokens)
    return f"{prompt.rstrip()}\n\n{contract_text(cap_tokens)}"


@dataclass(frozen=True)
class Conclusion:
    """A sub-agent's result, read against the contract."""

    conclusion: str
    files: tuple[str, ...] = ()
    evidence: tuple[str, ...] = ()
    # The result was the contract's JSON object; otherwise it was plain text,
    # all of it taken as the conclusion.
    structured: bool = False


def _strings(value: object) -> tuple[str, ...]:
    """A list of non-empty strings; a single string is a list of one."""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)):
        return ()
    items = (str(item).strip() for item in value if item is not None)
    return tuple(item for item in items if item)


def parse_conclusion(text: str) -> Conclusion:
    """Read a result against the contract, tolerating plain text."""
    stripped = text.strip()
    fenced = _FENCE.match(stripped)
    for candidate in (stripped, fenced.group(1) if fenced else None):
        if not candidate:
            continue
        try:
            data = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(data, Mapping) and isinstance(data.get("conclusion"), str):
            return Conclusion(
                data["conclusion"].strip(),
                _strings(data.get("files")),
                _strings(data.get("evidence")),
                structured=True,
            )
    return Conclusion(stripped)


@dataclass(frozen=True)
class SubagentReturn:
    """What one sub-agent brought back, in numbers only: safe for logs and the ledger."""

    received_tokens: int  # what the sub-agent sent
    returned_tokens: int  # what the parent reads
    cut: bool


@dataclass(frozen=True)
class BoundResult:
    """A result as the parent may read it, and its measure."""

    text: str  # not yet delimited as data: the caller does that
    report: SubagentReturn
    structured: bool


def _dump(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False)


def _fit_structured(parsed: Conclusion, budget: int) -> tuple[str, str]:
    """The contract's JSON within ``budget`` characters, and what it kept.

    The conclusion first, since it is what the parent asked for; then as many
    files, then as many pieces of evidence, as still fit. A conclusion that
    had to be cut takes all the room.
    """
    kept: dict[str, Any] = {
        "conclusion": parsed.conclusion,
        "files": [],
        "evidence": [],
    }
    conclusion_cut = False
    excess = len(_dump(kept)) - budget
    while excess > 0 and kept["conclusion"]:
        # Each character dropped shortens the JSON by at least one.
        kept["conclusion"] = kept["conclusion"][
            : max(0, len(kept["conclusion"]) - excess)
        ]
        conclusion_cut = True
        excess = len(_dump(kept)) - budget
    for key in () if conclusion_cut else ("files", "evidence"):
        for item in getattr(parsed, key):
            kept[key].append(item)
            if len(_dump(kept)) > budget:
                kept[key].pop()
                break
    detail = (
        f"kept: the conclusion{' (cut)' if conclusion_cut else ''}, "
        f"{len(kept['files'])} of {len(parsed.files)} files, "
        f"{len(kept['evidence'])} of {len(parsed.evidence)} pieces of evidence"
    )
    return _dump(kept), detail


def bound_result(text: str, *, cap_tokens: int = RESULT_CAP_TOKENS) -> BoundResult:
    """The result whole under the cap; cut and marked over it; marked when empty.

    The mark comes first, so that a parent reading the head knows the rest is
    missing before it reads anything.
    """
    stripped = text.strip()
    if not stripped:
        return BoundResult(
            EMPTY_RESULT,
            SubagentReturn(0, estimate_tokens(EMPTY_RESULT), cut=False),
            structured=False,
        )
    parsed = parse_conclusion(stripped)
    received = estimate_tokens(stripped)
    cap_chars = cap_tokens * CHARS_PER_TOKEN
    if len(stripped) <= cap_chars:
        return BoundResult(
            stripped, SubagentReturn(received, received, cut=False), parsed.structured
        )
    budget = max(1, cap_chars - MARKER_RESERVE)
    if parsed.structured:
        body, detail = _fit_structured(parsed, budget)
    else:
        page = page_lines(stripped, max_chars=budget)
        body = page.text.rstrip("\n")
        detail = f"lines 1–{page.last_line} of {page.total_lines} are shown"
        if page.clipped_line:
            detail += f", line {page.last_line} cut"
    hidden = estimate_tokens(stripped[: max(0, len(stripped) - len(body))])
    marker = (
        f"{_MARKER_LEAD}{received} tokens, over its cap of {cap_tokens}; "
        f"~{hidden} tokens are not shown ({detail}). Treat it as incomplete.]"
    )
    result = f"{marker}\n{body}"
    return BoundResult(
        result,
        SubagentReturn(received, estimate_tokens(result), cut=True),
        parsed.structured,
    )


def measure_returned(text: str) -> SubagentReturn:
    """What the parent read of a sub-agent's result, from that text alone.

    For a loop WorkPilot does not run, whose ledger sees the result after a
    hook bounded it: a result that was cut names its size in its mark.
    """
    returned = estimate_tokens(text)
    match = _CUT_MARKER.search(text)
    if match is None:
        return SubagentReturn(returned, returned, cut=False)
    return SubagentReturn(int(match.group(1)), returned, cut=True)
