"""The reviewer reads its own findings again before they are posted (#361).

The passes and the specialists of a review report the same remark more than
once: on line 12 and on line 14, ``Missing null check.`` and ``missing null
check``, once as ``high`` and once as ``low``. The existing deduplication only
drops exact repeats (same file, same line, same title) and keeps whichever
came first, so a review could say the same thing twice, or contradict itself
on how serious it is.

This pass merges a remark the review raised more than once at the same place
into one finding, the most severe of them: same file, same wording once case,
punctuation and spacing are set aside, lines at most ``LINE_WINDOW`` apart.
Identifiers and numbers stay in the wording, so ``Unused import `os` `` and
``Unused import `sys` `` stay two findings. It runs on the findings, without
a model, so it holds on every provider; what it merged is listed in the
summary, so nothing disappears without a trace.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from runners.github.models import PRReviewFinding, PRReviewResult

LINE_WINDOW = 3
"""Two reports of one remark at most this many lines apart are one finding."""
MAX_LISTED = 10

_SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}
_NON_WORD = re.compile(r"[^\w]+", re.UNICODE)


def wording(title: str) -> str:
    """The title without case, punctuation or spacing; identifiers kept."""
    text = unicodedata.normalize("NFKC", str(title or "")).casefold()
    return _NON_WORD.sub(" ", text).strip()


def _span(finding: PRReviewFinding) -> tuple[int, int]:
    start = finding.line or 0
    end = finding.end_line if finding.end_line and finding.end_line > start else start
    return start, end


def _rank(finding: PRReviewFinding) -> tuple[int, int, float]:
    """Lower is kept: more severe, then a security finding, then more confident."""
    severity = _SEVERITY_RANK.get(getattr(finding.severity, "value", ""), 4)
    security = 0 if getattr(finding.category, "value", "") == "security" else 1
    return severity, security, -float(finding.confidence or 0.0)


@dataclass
class _Cluster:
    members: list[PRReviewFinding]
    start: int
    end: int
    agents: list[str] = field(default_factory=list)

    def near(self, start: int, end: int) -> bool:
        return start <= self.end + LINE_WINDOW and end >= self.start - LINE_WINDOW


def merge_redundant(
    findings: list[PRReviewFinding],
) -> tuple[list[PRReviewFinding], list[dict[str, Any]]]:
    """``(kept, merged)``: one finding per remark and place, in report order.

    The kept one is the most severe report; it gains the source agents of the
    others. ``merged`` describes each report folded into another.
    """
    clusters: dict[tuple[str, str], list[_Cluster]] = {}
    order: list[_Cluster] = []
    for finding in findings:
        key = (finding.file or "", wording(finding.title))
        start, end = _span(finding)
        cluster = next((c for c in clusters.get(key, []) if c.near(start, end)), None)
        if cluster is None or not key[1]:
            cluster = _Cluster([], start, end)
            clusters.setdefault(key, []).append(cluster)
            order.append(cluster)
        cluster.members.append(finding)
        cluster.start = min(cluster.start, start)
        cluster.end = max(cluster.end, end)
        for agent in finding.source_agents or []:
            if agent not in cluster.agents:
                cluster.agents.append(agent)

    kept: list[PRReviewFinding] = []
    merged: list[dict[str, Any]] = []
    for cluster in order:
        best = min(cluster.members, key=_rank)
        if len(cluster.members) > 1:
            best.source_agents = list(cluster.agents)
        kept.append(best)
        for other in cluster.members:
            if other is best:
                continue
            merged.append(
                {
                    "id": other.id,
                    "title": other.title,
                    "file": other.file,
                    "line": other.line,
                    "severity": getattr(other.severity, "value", str(other.severity)),
                    "merged_into": best.id,
                }
            )
    # Report order, not cluster order: a kept finding stays where it was.
    position = {id(finding): index for index, finding in enumerate(findings)}
    kept.sort(key=lambda finding: position[id(finding)])
    return kept, merged


def summary_note(merged: list[dict[str, Any]]) -> str:
    """The summary's account of what was merged, or "" when nothing was."""
    if not merged:
        return ""
    lines = [
        "",
        "",
        "### Self-check before posting",
        f"{len(merged)} finding(s) repeated a remark already made at the same "
        "place and were merged into it, at the most severe level reported:",
    ]
    for item in merged[:MAX_LISTED]:
        lines.append(
            f"- {item['title']} ({item['file']}:{item['line']}, "
            f"{item['severity']}) into {item['merged_into']}"
        )
    if len(merged) > MAX_LISTED:
        lines.append(f"- and {len(merged) - MAX_LISTED} more")
    return "\n".join(lines)


def apply_to_followup(result: PRReviewResult) -> int:
    """The same pass on a follow-up's findings; the number merged.

    A merged report also leaves the follow-up's lists of unresolved and new
    findings. The verdict stands: the kept finding is the most severe report,
    so nothing the verdict rested on goes.
    """
    if not result.success or len(result.findings) < 2:
        return 0
    kept, merged = merge_redundant(result.findings)
    if not merged:
        return 0
    gone = {item["id"] for item in merged}
    result.findings = kept
    result.unresolved_findings = [
        fid for fid in result.unresolved_findings if fid not in gone
    ]
    result.new_findings_since_last_review = [
        fid for fid in result.new_findings_since_last_review if fid not in gone
    ]
    result.summary = (result.summary or "") + summary_note(merged)
    return len(merged)
