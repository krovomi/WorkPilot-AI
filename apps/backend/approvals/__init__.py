"""Approval tiers: who must agree before a pull request merges.

A pull request's facts (type, layers, sensitive paths, size, CI, review) are
measured without a model and judged into four tiers, N0 to N3, by the
``approvals`` section of ``workpilot.policy.yaml`` on top of built-in rules.
Every provider, every stack, every forge. Design:
``docs/architecture/approval-tiers.md``.
"""

from .decide import decide
from .facts import build_facts, changed_files, clean_layers_touched
from .load import ENV_MODE, app_mode, effective_mode, load_approval_policy
from .model import (
    ACTION_BLOCKED,
    ACTION_HUMAN,
    ACTION_MERGE,
    ACTION_WAIT,
    MODE_ENFORCE,
    MODE_OBSERVE,
    MODE_OFF,
    ChangedFile,
    Decision,
    PRFacts,
    Reason,
    Tier,
)
from .policy import ApprovalPolicy, parse_approvals

__all__ = [
    "ACTION_BLOCKED",
    "ACTION_HUMAN",
    "ACTION_MERGE",
    "ACTION_WAIT",
    "ENV_MODE",
    "MODE_ENFORCE",
    "MODE_OBSERVE",
    "MODE_OFF",
    "ApprovalPolicy",
    "ChangedFile",
    "Decision",
    "PRFacts",
    "Reason",
    "Tier",
    "app_mode",
    "build_facts",
    "changed_files",
    "clean_layers_touched",
    "decide",
    "effective_mode",
    "load_approval_policy",
    "parse_approvals",
]
