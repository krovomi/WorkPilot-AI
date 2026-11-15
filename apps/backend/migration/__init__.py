"""
Code Migration: the project's stack and a rule-based migration plan.

Read by the Code Migration page through `runners/code_migration_runner.py`.
The migration itself is a Kanban task (spec, planner, coder, QA in a
worktree), for every stack.
"""

from .analyzer import StackAnalyzer
from .models import (
    MigrationContext,
    MigrationPhase,
    MigrationPlan,
    MigrationState,
    MigrationStep,
    RiskLevel,
    StackInfo,
)
from .orchestrator import MigrationOrchestrator
from .planner import MigrationPlanner

__all__ = [
    "MigrationContext",
    "MigrationOrchestrator",
    "MigrationPhase",
    "MigrationPlan",
    "MigrationPlanner",
    "MigrationState",
    "MigrationStep",
    "RiskLevel",
    "StackAnalyzer",
    "StackInfo",
]
