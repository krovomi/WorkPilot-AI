"""
Data models and types for the migration system.
"""

from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class MigrationState(Enum):
    """Migration state. The page plans; a Kanban task does the rest."""

    PLANNING = "planning"


class RiskLevel(Enum):
    """Risk assessment levels."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class StackInfo:
    """Information about a technology stack."""

    framework: str  # e.g., "react", "vue", "django", "flask"
    language: str  # e.g., "typescript", "python", "java"
    version: str  # Version of the framework/language
    database: str | None = None  # e.g., "mysql", "postgresql"
    db_version: str | None = None
    dependencies: dict[str, str] = field(default_factory=dict)  # name → version
    additional_tools: list[str] = field(default_factory=list)  # e.g., webpack, docker
    package_manager: str = "npm"  # npm, pip, maven, etc.

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class MigrationStep:
    """Atomic migration step."""

    id: str
    title: str
    description: str
    category: str  # e.g., "component", "database", "config", "api"
    files_affected: list[str]
    transformation_type: str  # e.g., "api_mapping", "syntax_conversion"

    # Execution details
    expected_changes: int  # Expected number of file changes
    rollback_procedure: str | None = None
    validation_checks: list[str] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)  # Step IDs this depends on

    status: str = "pending"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class MigrationPhase:
    """Group of related migration steps."""

    id: str
    name: str  # e.g., "Components", "Database Schema", "API Layer"
    description: str

    # Metadata
    estimated_effort: str = "medium"  # Low, Medium, High

    steps: list[MigrationStep] = field(default_factory=list)
    risk_level: RiskLevel = RiskLevel.MEDIUM
    requires_approval: bool = False

    status: str = "pending"

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["steps"] = [step.to_dict() for step in self.steps]
        data["risk_level"] = self.risk_level.value
        return data


@dataclass
class MigrationPlan:
    """Complete migration plan."""

    id: str
    source_stack: StackInfo
    target_stack: StackInfo

    # Plan details
    phases: list[MigrationPhase] = field(default_factory=list)
    total_steps: int = 0

    # Assessment
    estimated_effort: str = "medium"  # Low, Medium, High, Very High
    risk_level: RiskLevel = RiskLevel.MEDIUM
    estimated_duration_hours: float = 0.0

    # Metadata
    created_at: datetime = field(default_factory=datetime.now)
    created_by: str = "claude"
    approvals_required: bool = False

    # Status
    status: str = "pending"  # pending, approved, in_progress, completed, failed

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["source_stack"] = self.source_stack.to_dict()
        data["target_stack"] = self.target_stack.to_dict()
        data["phases"] = [phase.to_dict() for phase in self.phases]
        data["risk_level"] = self.risk_level.value
        data["created_at"] = self.created_at.isoformat()
        return data


@dataclass
class MigrationContext:
    """A planned migration, saved under `.workpilot/migration/`."""

    migration_id: str
    source_stack: StackInfo
    target_stack: StackInfo
    project_dir: str
    plan: MigrationPlan | None = None
    state: MigrationState = MigrationState.PLANNING
    started_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["source_stack"] = self.source_stack.to_dict()
        data["target_stack"] = self.target_stack.to_dict()
        data["plan"] = self.plan.to_dict() if self.plan else None
        data["state"] = self.state.value
        data["started_at"] = self.started_at.isoformat()
        return data
