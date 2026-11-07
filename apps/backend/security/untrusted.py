"""Content somebody outside this build wrote, on its way into a prompt.

An issue body, a pull request description, a review comment: text anyone with
a GitHub account can write, which WorkPilot reads and hands to an agent that
has `Bash` and `Write`. The repository had three defences for this and used
none of them —

=================================  =========================================
`security/content_sanitizer.py`    570 lines, zero callers (and it lived
                                   under `runners/github/`, behind an import
                                   of every runner in the product)
`injection_guard/` + `BaseAgent`   `BaseAgent` has zero subclasses
`security/injection_scanner.py`    re-exported by `security/__init__`, called
                                   by nothing — since merged into
                                   `injection_guard` and deleted
=================================  =========================================

— so a `<!-- ignore all previous instructions and … -->` in an issue body
reached the model exactly as written. HTML comments are the sharp end of
this: GitHub does not render them, so the text is invisible to the human
reviewing the issue and plain to the model reading it.

This module is the joint, not a fourth implementation. `ContentSanitizer`
does the sanitising — it was written for this and is the most complete of the
three — and `injection_guard`'s scanner does the detection. What is added here
is that they are *called*, from one function, with one policy.

Sanitise, then report — and do not block
-----------------------------------------
`clean_untrusted` strips, truncates and records. It does not raise, and the
scan does not gate anything.

That is a measurement, not a preference. Run over this repository's own 62
system prompts, the scanner rates 12 `suspect` and marks
`prompts/github/pr_reviewer.md` `blocked` — correctly, in its own terms: a
prompt that teaches an agent to review code for destructive shell commands and
credential exfiltration is a prompt full of the phrases that name them.
Blocking on that signal would stop the product on its own content, and a
control that has to be switched off on the first build is a control nobody
runs with.

What survives is worth more than what is given up. Stripping is unconditional
and needs no confidence: an HTML comment carries no meaning for the model that
its visible text does not, so removing it costs nothing and closes the vector
outright. The scan then writes what it saw next to the spec, where a reviewer
asking "why did this build do that?" is already looking — the same bargain
`watermarks.jsonl` makes for the bytes it rewrites silently.

`WORKPILOT_INJECTION_GUARD=block` turns the highest-confidence findings into a
refusal, for a deployment that would rather lose a build than read an issue
body. It is off by default, and it is deliberately not the kind of switch that
can be turned the other way: there is no value of it that stops the stripping.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

__all__ = [
    "GUARD_MODE_ENV_VAR",
    "LEDGER_FILENAME",
    "UntrustedContent",
    "clean_untrusted",
    "quote_untrusted",
    "record_untrusted",
]

#: `report` (default) or `block`.
GUARD_MODE_ENV_VAR = "WORKPILOT_INJECTION_GUARD"

#: Beside `watermarks.jsonl`, and for the same reason: this is the other place
#: WorkPilot changes text a model will read without telling the model.
LEDGER_FILENAME = "untrusted_content.jsonl"


#: What a forge text asks *of the agent*, beyond the scanner's override
#: phrasings. They live here, not in `injection_guard`, because they are only
#: suspicious from a stranger: a task the user writes may well say "run
#: `curl … | sh`", and an attachment may document `pull_request_target`; an
#: issue that tells the agent to do so is the attack the plan's corpus
#: (tests/injection_guard/corpus.yaml) replays. A hit rates the text `suspect`:
#: it is written to the ledger and logged, never silently passed on.
_FORGE_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE), description)
    for pattern, description in (
        (
            r"\b(?:curl|wget|iwr|irm|Invoke-WebRequest)\b[^\n|]*\|\s*(?:sudo\s+)?"
            r"(?:ba|z|da|k)?sh\b|\|\s*(?:iex|Invoke-Expression)\b",
            "Remote script piped to a shell",
        ),
        (
            r"(?:\bcat|\btype|\bGet-Content|\bcp|\bscp)\s+\S*"
            r"(?:\.ssh/|id_rsa|id_ed25519|\.aws/|\.npmrc|\.netrc|\.pypirc|\.env\b)",
            "Read of a credential file",
        ),
        (
            r"\b(?:paste|post|send|upload|share|include|commit|print|reply\s+with)\b"
            r"[^.\n]{0,40}(?:\.env\b|id_rsa|\.ssh/|\.aws/credentials|\.npmrc|\.netrc|"
            r"\b(?:secrets?|tokens?|credentials|private\s+keys?)\b)",
            "Request to disclose credentials",
        ),
        (
            r"!\[[^\]]*\]\(\s*https?://[^)\s]*(?:\$\{|\$\(|\{\{|%24%7B|"
            r"[?&](?:token|key|secret|password|session|auth)[^=)]*=)",
            "Image URL that carries data out",
        ),
        (
            r"\bgit\s+push\b[^\n]*(?:--force\b|\s-f\b)|"
            r"\bpush\s+(?:it\s+)?(?:directly|straight)\s+(?:to|on)\s+(?:main|master|develop)\b|"
            r"\bpousse[rz]?\s+directement\s+sur\s+(?:main|master|develop)\b",
            "Push that skips review",
        ),
        (
            r"\bpull_request_target\b|\.github/workflows\b[^\n]{0,40}\b(?:secrets?|edit|change|modify)",
            "Request to change CI with secrets",
        ),
        (
            r"\.workpilot-allowlist|\.workpilot-security\.json|\.workpilot/guardrails|"
            r"\.claude(?:_settings\.json|/settings)|\.workpilot-goal\.json",
            "Mention of an agent guardrail file",
        ),
        (
            r"\b(?:disable|remove|skip|bypass|turn\s+off|d[e\u00e9]sactive[rz]?|saute[rz]?)\s+"
            r"(?:the\s+|les?\s+|la\s+)?(?:secret\s+scan|pre-commit|hooks?|tests?|QA|"
            r"review(?:\s+gate)?|allowlist|sandbox|guardrails?|checks?)\b",
            "Request to switch off a control",
        ),
        (
            r"\b(?:note|message|instructions?|reminder|task)\s+(?:to|for)\s+(?:the\s+|any\s+)?"
            r"(?:AI|LLMs?|agents?|assistants?|Claude|Codex|Copilot|GPT|Gemini|bots?|coding\s+agents?)\b|"
            r"\bif\s+you\s+are\s+(?:an?\s+)?(?:AI|LLM|language\s+model|agent|assistant|bot)\b|"
            r"\b(?:AI|coding|reviewer)\s+(?:agent|bot)\s*:",
            "Text addressed to the agent",
        ),
        (
            r"\bI\s+(?:hereby\s+)?(?:authori[sz]e|allow|permit)\s+you\s+to\b|"
            r"\bje\s+t'autorise\s+[\u00e0a]\b",
            "Claimed authorisation",
        ),
    )
)


def _forge_findings(text: str) -> list[str]:
    return [
        description for pattern, description in _FORGE_PATTERNS if pattern.search(text)
    ]


class UntrustedContent:
    """The result of cleaning one span, and what was found in it."""

    __slots__ = ("text", "removed", "truncated", "findings", "threat_level", "kind")

    def __init__(
        self,
        text: str,
        removed: list[str],
        truncated: bool,
        findings: list[str],
        threat_level: str,
        kind: str,
    ) -> None:
        self.text = text
        self.removed = removed
        self.truncated = truncated
        self.findings = findings
        self.threat_level = threat_level
        self.kind = kind

    @property
    def changed(self) -> bool:
        return bool(self.removed) or self.truncated

    @property
    def suspicious(self) -> bool:
        return self.threat_level not in ("", "safe", "clean")


def _sanitizer() -> Any | None:
    try:
        from .content_sanitizer import get_sanitizer

        return get_sanitizer()
    except Exception:  # noqa: BLE001 - a missing sanitizer must not fail a build
        logger.debug("content sanitizer unavailable", exc_info=True)
        return None


def _scan(text: str, source: str) -> tuple[str, list[str]]:
    """Ask the injection scanner what it sees. Never raises."""
    try:
        from injection_guard import get_default_scanner

        result = get_default_scanner().scan(text, source=source)
        return (
            str(getattr(result.threat_level, "value", result.threat_level)),
            [finding.description for finding in result.findings],
        )
    except Exception:  # noqa: BLE001 - detection is never worth a failed build
        logger.debug("injection scan unavailable", exc_info=True)
        return "", []


def clean_untrusted(
    content: str,
    kind: str = "issue_body",
    source: str = "",
) -> UntrustedContent:
    """Strip the hidden-instruction carriers out of `content` and report on it.

    Idempotent: stripping an HTML comment twice is stripping it once, and
    truncating to the same cap twice is truncating once. That is what makes it
    safe to call where the content is *ingested* — a dataclass `__post_init__`
    that a `to_dict`/`from_dict` round trip runs again — rather than only where
    a prompt is assembled.
    """
    if not content:
        return UntrustedContent("", [], False, [], "", kind)

    text = content
    removed: list[str] = []
    truncated = False

    sanitizer = _sanitizer()
    if sanitizer is not None:
        try:
            result = sanitizer.sanitize(content, content_type=kind)
            text = result.content
            removed = list(result.removed_items)
            truncated = bool(result.was_truncated)
        except Exception:  # noqa: BLE001
            logger.debug("sanitizing %s failed; passing through", kind, exc_info=True)

    threat_level, findings = _scan(text, source or kind)
    forge = _forge_findings(text)
    if forge:
        findings = findings + forge
        if threat_level in ("", "safe", "clean"):
            threat_level = "suspect"

    return UntrustedContent(text, removed, truncated, findings, threat_level, kind)


def record_untrusted(
    spec_dir: Path | str | None,
    cleaned: UntrustedContent,
    source: str = "",
) -> None:
    """Append one line to `<spec_dir>/untrusted_content.jsonl`.

    Silent on every failure. A ledger that can fail a build is a ledger that
    gets removed from the hot path.
    """
    if spec_dir is None or not (cleaned.changed or cleaned.suspicious):
        return

    try:
        directory = Path(spec_dir)
        directory.mkdir(parents=True, exist_ok=True)
        entry = {
            "at": datetime.now(UTC).isoformat(),
            "kind": cleaned.kind,
            "source": source,
            "removed": cleaned.removed,
            "truncated": cleaned.truncated,
            "threat_level": cleaned.threat_level,
            "findings": cleaned.findings,
        }
        with open(directory / LEDGER_FILENAME, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001
        logger.debug("untrusted-content ledger write skipped", exc_info=True)


def quote_untrusted(
    content: str,
    kind: str = "issue_body",
    source: str = "",
    spec_dir: Path | str | None = None,
) -> str:
    """Clean `content` and return it fenced, ready to drop into a prompt.

    The fence and the instruction that goes with it are
    `ContentSanitizer.wrap_user_content`'s — the model is told, in the prompt,
    that what is between the markers is data. That instruction is not a
    guarantee and is not treated as one; it is the layer above the stripping,
    which is the one that does not depend on the model cooperating.

    Unlike `clean_untrusted` this is **not** idempotent — it adds a fence each
    time — so it belongs where a prompt is assembled, and nowhere else.
    """
    cleaned = clean_untrusted(content, kind=kind, source=source)
    record_untrusted(spec_dir, cleaned, source=source)

    if cleaned.suspicious:
        logger.warning(
            "untrusted %s from %s rated %s: %s",
            kind,
            source or "unknown",
            cleaned.threat_level,
            "; ".join(cleaned.findings[:3]) or "no description",
        )

    if _blocking() and cleaned.threat_level == "blocked":
        return (
            "[WorkPilot removed this content: it was rated a prompt-injection "
            f"attempt ({'; '.join(cleaned.findings[:3])}). Ask a human to read "
            "it.]"
        )

    sanitizer = _sanitizer()
    if sanitizer is None:
        return cleaned.text
    try:
        return sanitizer.wrap_user_content(
            cleaned.text, content_type=kind, sanitize_first=False
        )
    except Exception:  # noqa: BLE001
        logger.debug("wrapping %s failed; returning cleaned text", kind, exc_info=True)
        return cleaned.text


def _blocking() -> bool:
    return os.environ.get(GUARD_MODE_ENV_VAR, "report").strip().lower() == "block"
