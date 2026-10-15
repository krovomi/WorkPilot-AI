"""Gate 4 — the instructions a skill must not be able to smuggle in.

A skill is not a document. ``.agents/skills/<name>/SKILL.md`` is a procedure
every connected agent may load and follow, on every provider, in every later
session. ``skills/`` is fed by four paths — ``skills-cli add`` and the
``bootstrap`` fetch (a third party's repository, on its own release cadence),
the weekly ``skills-sync`` job, hermes adoption, and hand authoring — and a
body only becomes an instruction when the build emits it. So the check belongs
at the emission boundary, where one gate covers all four, rather than in each
of them, where the next ingestion path would arrive without one.

**Refused, not cleaned.** ``clean_untrusted`` strips the carriers and hands back
usable text, which is the right answer for an issue body an agent still has to
read. It is the wrong answer here: nobody needs a vendored skill with the
payload taken out, and rewriting a third party's file would leave the emitted
content no longer matching the tree SHA ``skills-lock.json`` recorded. A skill
whose body reads as an instruction override is not emitted at all, and
``skills-cli why <skill>`` says why.

**Both the raw body and the cleaned one are scanned**, and that is the gate
rather than a detail. The sanitizer removes HTML comments and truncates long
content, so scanning only its output reports ``safe`` for a file the build then
emits *with the comment still in it* — and sees nothing at all past the
truncation cap. The carriers it removed are reported; the verdict is the worse
of the two scans.

**What is refused is a closed list, not a threshold.** A skill about dangerous
work legitimately contains dangerous text: the first run of this gate refused
`claude-code` and `computer-use`, whose bodies document destructive commands and
credential handling. Only the findings that mean *this body addresses the agent*
refuse it (``_OVERRIDE_FINDINGS``); everything else the scanners see is
reported. What a skill tells a person to do stays a matter for the review of the
pull request that vendors it — this gate is not a review, and nothing here
grants trust on a reviewer's behalf.

**A missing scanner refuses nothing**, as everywhere else here
(``security/untrusted.py``: detection is never worth a failed build). This is a
barrier against a poisoned upstream, not a dependency of the build.

``WORKPILOT_INJECTION_GUARD=report`` downgrades a refusal to a finding the
resolution still carries. The default is the strict one, unlike for issue
bodies, and the asymmetry is deliberate: an issue is read once by one session,
a skill is followed by every agent until someone deletes it.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

from security.untrusted import GUARD_MODE_ENV_VAR, UntrustedContent, clean_untrusted

logger = logging.getLogger(__name__)

__all__ = ["GATE", "SkillVerdict", "scan_skill_body"]

#: The resolver gate name, as ``skills-cli why`` prints it.
GATE = "injection"

#: The scanner's verdict for text it would not pass on at all.
BLOCKED = "blocked"

#: The findings that mean *this body addresses the agent* — an override, a role
#: hijack, a prompt extraction, a reset — and nothing else. Refusing on the
#: scanner's aggregate verdict instead cost two working skills on the first run:
#: `claude-code` and `computer-use` document destructive commands and
#: credential handling, which is what a skill about those subjects is *for*.
#: What a skill may never do is speak past its reader to the agent reading it,
#: and that is a closed list rather than a threshold.
#:
#: Two of them are left out for the same reason, now written down: `Role
#: injection` is `act as a`, `Persona injection` is `pretend to be`. Both are
#: ordinary English in a skill that explains how to brief an agent, and the
#: first refused `bmad-prfaq`, which says to act as a customer. A marker or a
#: tag is structural and cannot be written by accident; a verb phrase can.
#:
#: The descriptions are `injection_guard.scanner._INJECTION_PATTERNS`'. A new
#: pattern there is reported, not refused, until it is named here — the
#: fail-open direction is the deliberate one for a list this gate does not own.
_OVERRIDE_FINDINGS = frozenset(
    {
        "Direct instruction override attempt",
        "Instruction disregard attempt",
        "Role reassignment attempt",
        "System/assistant role spoofing marker",
        "XML-style role injection",
        "XML instruction tag injection",
        "Llama instruction tag injection",
        "Pipe-style role tag injection",
        "Conversation role injection",
        "Prompt extraction attempt",
        "System prompt extraction",
        "System prompt query",
        "Context extraction",
        "Memory reset attempt",
        "Jailbreak trigger phrase",
        "Base64-encoded injection",
        "French instruction override",
        "French memory reset",
        "French role reassignment",
    }
)

#: ``WORKPILOT_INJECTION_GUARD`` set to this reports instead of refusing.
_REPORT_MODE = "report"

#: What the sanitizer is told it is looking at: a file's text, not an issue.
_CONTENT_KIND = "file"

#: Worst-first ordering of the scanner's verdicts. An unavailable scanner
#: answers "", which has to rank with "safe" rather than above it.
_SEVERITY = {"": 0, "safe": 0, "clean": 0, "suspect": 1, BLOCKED: 2}

#: Enough findings to name the problem; the file is where the detail is.
_FINDINGS_IN_REASON = 3


@dataclass(frozen=True)
class SkillVerdict:
    """What the scanners saw in one skill body."""

    threat_level: str = ""
    findings: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    report_only: bool = False
    """``WORKPILOT_INJECTION_GUARD=report`` was set: nothing is refused."""

    @property
    def overrides(self) -> list[str]:
        """The findings that make this body an instruction, not a document."""
        return [f for f in self.findings if f in _OVERRIDE_FINDINGS]

    @property
    def blocked(self) -> bool:
        """This body speaks to the agent that would read it."""
        return bool(self.overrides)

    @property
    def suspicious(self) -> bool:
        """Something was found, blocking or not — worth a human eye."""
        return bool(self.findings) or bool(self.removed)

    @property
    def refused(self) -> bool:
        """This body must not be emitted."""
        return self.blocked and not self.report_only

    @property
    def summary(self) -> str:
        """The findings, for the rejection reason. Never any of the body."""
        overrides = self.overrides
        named = overrides[:_FINDINGS_IN_REASON]
        more = len(overrides) - len(named)
        text = "; ".join(named) or "no finding named"
        if more > 0:
            text += f" (+{more} more)"
        if self.removed:
            text += f"; hidden-instruction carriers removed before the scan: {', '.join(sorted(set(self.removed)))}"
        return text


def _report_only() -> bool:
    return os.environ.get(GUARD_MODE_ENV_VAR, "").strip().lower() == _REPORT_MODE


def _worst(*levels: str) -> str:
    return max(levels, key=lambda level: _SEVERITY.get(level, 0), default="")


def _scan_raw(text: str, source: str) -> tuple[str, list[str]]:
    """The scanner's verdict on the text exactly as it sits on disk.

    Separate from ``clean_untrusted`` on purpose: that one scans what it is
    about to hand a model, this one scans what the build is about to write.
    """
    try:
        from injection_guard import get_default_scanner

        result = get_default_scanner().scan(text, source=source)
        level = str(getattr(result.threat_level, "value", result.threat_level))
        return level, [finding.description for finding in result.findings]
    except Exception:  # noqa: BLE001 - detection is never worth a failed build
        logger.debug("injection scan of %s unavailable", source, exc_info=True)
        return "", []


def scan_skill_body(body: str, source: str = "skill") -> SkillVerdict:
    """Scan one skill or agent body. Never raises.

    ``source`` names the skill for the scanner's own records
    (``<pack>/<skill>``); it is never the body itself.
    """
    report_only = _report_only()
    if not body or not body.strip():
        return SkillVerdict(report_only=report_only)

    try:
        cleaned = clean_untrusted(body, kind=_CONTENT_KIND, source=source)
    except Exception:  # noqa: BLE001 - a build never fails on the detector
        logger.debug("cleaning %s failed; raw scan only", source, exc_info=True)
        cleaned = UntrustedContent("", [], False, [], "", _CONTENT_KIND)
    raw_level, raw_findings = _scan_raw(body, source)

    # dict.fromkeys: the two scans agree on most findings, and the first
    # occurrence keeps the order the scanner reported them in.
    findings = list(dict.fromkeys([*cleaned.findings, *raw_findings]))

    verdict = SkillVerdict(
        threat_level=_worst(cleaned.threat_level, raw_level),
        findings=findings,
        removed=list(cleaned.removed),
        report_only=report_only,
    )
    # Said once, here, so a finding that does not refuse still leaves a trace:
    # the resolution only carries rejections.
    if verdict.suspicious and not verdict.blocked:
        logger.warning(
            "skill %s: %s — emitted, not an instruction override",
            source,
            "; ".join(verdict.findings or verdict.removed),
        )
    return verdict
