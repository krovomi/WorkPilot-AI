"""Signs of a poisoned tool description: instructions meant for the model alone.

The model reads a tool's description and the descriptions of its parameters;
the person never sees them. Tool poisoning (Invariant Labs, April 2025) hides
instructions there: read `~/.ssh/id_rsa` and pass it as a parameter, do not
tell the user, change how *another* server's tool behaves (shadowing).

The checks are deliberately few and specific, because a finding holds a
server back until the person confirms it: a sentence a normal tool would not
write. The general prompt-injection scanner (`injection_guard`) runs too.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable

from injection_guard import InjectionScanner, ThreatLevel

__all__ = ["description_findings"]

#: Zero-width, bidirectional and tag characters: text the person cannot see.
_INVISIBLE = re.compile(
    r"[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\U000e0000-\U000e007f]"
)
_HIDDEN_TAG = re.compile(
    r"<\s*/?\s*(?:important|system|instructions?|secret|hidden|admin)\b[^>]*>"
    r"|\[/?(?:INST|SYSTEM)\]",
    re.I,
)
_SECRECY = re.compile(
    r"\b(?:do\s+not|don'?t|never|without)\s+(?:tell(?:ing)?|mention(?:ing)?|"
    r"inform(?:ing)?|notify(?:ing)?|reveal(?:ing)?|alert(?:ing)?)\b"
    r"[^.\n]{0,40}\b(?:user|human|person)\b",
    re.I,
)
_SECRET_FILES = re.compile(
    r"(?:~|\$HOME|%USERPROFILE%)?[/\\]?\.(?:ssh|aws|gnupg|kube|docker)[/\\]"
    r"|\bid_(?:rsa|ed25519|ecdsa)\b|\bmcp\.json\b|\.cursor[/\\]|"
    r"\bclaude_desktop_config\.json\b|\.npmrc\b|\.netrc\b|\.git-credentials\b",
    re.I,
)
_PRECONDITION = re.compile(
    r"\bbefore\s+(?:using|calling|invoking|running)\s+(?:this|any)\s+tool\b"
    r"[^.\n]{0,60}\b(?:read|send|call|pass|include|upload|fetch|run)\b",
    re.I,
)
_OTHER_TOOLS = re.compile(
    r"\b(?:other|all|every|any)\s+(?:tools?|servers?)\b[^.\n]{0,40}\b(?:must|should|"
    r"always|instead)\b|\bwhen\s+(?:the\s+)?\w+\s+tool\s+is\s+(?:available|present|"
    r"used|called)\b",
    re.I,
)
_LONG = 4000
_SCANNER = InjectionScanner()


def _mentions(text: str, names: Iterable[str]) -> list[str]:
    folded = text.casefold()
    return sorted(
        {
            n
            for n in names
            if len(n) >= 5 and re.search(rf"\b{re.escape(n.casefold())}\b", folded)
        }
    )


def description_findings(
    text: str, *, other_tools: Iterable[str] = (), own_name: str = ""
) -> list[str]:
    """What looks like a hidden instruction in ``text``; ``[]`` when nothing does.

    Each finding is a code, or ``code:detail`` (the app translates the code):
    ``invisible``, ``private-use``, ``model-tag``, ``secrecy``,
    ``secret-file``, ``precondition``, ``other-tools``, ``shadowing:<tools>``,
    ``long:<characters>``, ``injection:<what the scanner saw>``.

    ``other_tools`` are the names of the tools of the *other* configured
    servers: a description that names one of them tries to steer it.
    """
    findings: list[str] = []
    if _INVISIBLE.search(text):
        findings.append("invisible")
    if any(unicodedata.category(c) == "Co" for c in text):
        findings.append("private-use")
    for pattern, label in (
        (_HIDDEN_TAG, "model-tag"),
        (_SECRECY, "secrecy"),
        (_SECRET_FILES, "secret-file"),
        (_PRECONDITION, "precondition"),
        (_OTHER_TOOLS, "other-tools"),
    ):
        if pattern.search(text):
            findings.append(label)
    shadowed = [n for n in _mentions(text, other_tools) if n != own_name]
    if shadowed:
        findings.append("shadowing:" + ", ".join(shadowed[:3]))
    if len(text) > _LONG:
        findings.append(f"long:{len(text)}")
    result = _SCANNER.scan(text, source="mcp-tool-description")
    if result.threat_level != ThreatLevel.SAFE:
        findings.extend(
            f"injection:{f.description}"
            for f in result.findings
            if f.severity in ("high", "critical")
        )
    return list(dict.fromkeys(findings))
