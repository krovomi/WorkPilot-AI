"""
Git History Surgeon — read, plan and rewrite a branch's history.

``history_analyzer`` finds what weighs on a repository (large blobs, secrets,
messy messages). ``rewrite`` plans a branch's clean-up (squash the fix-ups,
reword to the project's convention, split mixed commits) and replays it on a
new branch whose files are the branch's, byte for byte. ``branches`` lists the
local branches to tidy. See docs/architecture/git-history-surgeon.md.
"""

from .branches import delete_merged, list_branches
from .commits import SurgeonError
from .history_analyzer import (
    HistoryAnalyzer,
    HistoryIssue,
    HistoryIssueType,
    SurgeryAction,
    SurgeryPlan,
)
from .rewrite import apply, make_plan

__all__ = [
    "HistoryAnalyzer",
    "SurgeryPlan",
    "HistoryIssue",
    "HistoryIssueType",
    "SurgeryAction",
    "SurgeonError",
    "apply",
    "delete_merged",
    "list_branches",
    "make_plan",
]
