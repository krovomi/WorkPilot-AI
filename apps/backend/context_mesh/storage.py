"""
File-based storage for Context Mesh data.

Stores cross-project patterns, handbook entries, skill transfers,
recommendations, and project registry in a central location.
All data is persisted as JSON in ~/.workpilot/context_mesh/.
"""

import json
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

from foundation.file_utils import write_json_atomic

from .types import (
    ContextMeshConfig,
    ContextualRecommendation,
    CrossProjectPattern,
    HandbookEntry,
    MeshAnalysisReport,
    ProjectSummary,
    SkillTransfer,
)

logger = logging.getLogger(__name__)

T = TypeVar("T")

DEFAULT_MESH_DIR = "~/.workpilot/context_mesh"


class ContextMeshStorage:
    """Manages file-based persistence for context mesh data."""

    def __init__(self, mesh_dir: str | Path | None = None):
        self.mesh_dir = Path(mesh_dir or DEFAULT_MESH_DIR).expanduser()
        self.mesh_dir.mkdir(parents=True, exist_ok=True)

    # ── File paths ──────────────────────────────────────────────

    @property
    def _projects_file(self) -> Path:
        return self.mesh_dir / "projects.json"

    @property
    def _patterns_file(self) -> Path:
        return self.mesh_dir / "patterns.json"

    @property
    def _handbook_file(self) -> Path:
        return self.mesh_dir / "handbook.json"

    @property
    def _transfers_file(self) -> Path:
        return self.mesh_dir / "skill_transfers.json"

    @property
    def _recommendations_file(self) -> Path:
        return self.mesh_dir / "recommendations.json"

    @property
    def _config_file(self) -> Path:
        return self.mesh_dir / "config.json"

    # ── Generic helpers ─────────────────────────────────────────

    def _read_json(self, path: Path, default: Any = None) -> Any:
        if not path.exists():
            return default if default is not None else {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"Failed to read {path}: {e}")
            return default if default is not None else {}

    def _write_json(self, path: Path, data: Any) -> bool:
        """Write ``data`` atomically: a crash mid-write leaves the old file."""
        try:
            write_json_atomic(path, json.loads(json.dumps(data, default=str)))
            return True
        except OSError as e:
            logger.warning(f"Failed to write {path}: {e}")
            return False

    def _read_list(
        self, path: Path, key: str, build: Callable[[dict[str, Any]], T]
    ) -> list[T]:
        """The records under ``key``; a record that no longer loads is skipped.

        One hand-edited or older-format record must not hide all the others.
        """
        data = self._read_json(path, {key: []})
        records = data.get(key) if isinstance(data, dict) else None
        if not isinstance(records, list):
            return []
        loaded: list[T] = []
        for record in records:
            try:
                loaded.append(build(record))
            except (TypeError, ValueError, AttributeError) as e:
                logger.warning(f"Skipped an unreadable record in {path}: {e}")
        return loaded

    # ── Config ──────────────────────────────────────────────────

    def load_config(self) -> ContextMeshConfig:
        data = self._read_json(self._config_file, {})
        if not isinstance(data, dict) or not data:
            return ContextMeshConfig()
        return ContextMeshConfig.from_dict(data)

    def save_config(self, config: ContextMeshConfig) -> bool:
        return self._write_json(self._config_file, config.to_dict())

    # ── Projects ────────────────────────────────────────────────

    def get_projects(self) -> list[ProjectSummary]:
        return self._read_list(
            self._projects_file, "projects", ProjectSummary.from_dict
        )

    def save_project(self, project: ProjectSummary) -> bool:
        projects = self.get_projects()
        existing = next(
            (p for p in projects if p.project_path == project.project_path), None
        )
        if existing:
            idx = projects.index(existing)
            projects[idx] = project
        else:
            projects.append(project)
        return self._write_json(
            self._projects_file, {"projects": [p.to_dict() for p in projects]}
        )

    def remove_project(self, project_path: str) -> bool:
        projects = self.get_projects()
        projects = [p for p in projects if p.project_path != project_path]
        return self._write_json(
            self._projects_file, {"projects": [p.to_dict() for p in projects]}
        )

    # ── Patterns ────────────────────────────────────────────────

    def get_patterns(self) -> list[CrossProjectPattern]:
        return self._read_list(
            self._patterns_file, "patterns", CrossProjectPattern.from_dict
        )

    def save_patterns(self, patterns: list[CrossProjectPattern]) -> bool:
        return self._write_json(
            self._patterns_file, {"patterns": [p.to_dict() for p in patterns]}
        )

    def add_pattern(self, pattern: CrossProjectPattern) -> bool:
        patterns = self.get_patterns()
        existing = next(
            (p for p in patterns if p.pattern_id == pattern.pattern_id), None
        )
        if existing:
            idx = patterns.index(existing)
            patterns[idx] = pattern
        else:
            patterns.append(pattern)
        return self.save_patterns(patterns)

    def remove_pattern(self, pattern_id: str) -> bool:
        patterns = self.get_patterns()
        patterns = [p for p in patterns if p.pattern_id != pattern_id]
        return self.save_patterns(patterns)

    # ── Handbook ─────────────────────────────────────────────────

    def get_handbook_entries(self) -> list[HandbookEntry]:
        return self._read_list(self._handbook_file, "entries", HandbookEntry.from_dict)

    def save_handbook_entries(self, entries: list[HandbookEntry]) -> bool:
        return self._write_json(
            self._handbook_file, {"entries": [e.to_dict() for e in entries]}
        )

    def add_handbook_entry(self, entry: HandbookEntry) -> bool:
        entries = self.get_handbook_entries()
        existing = next((e for e in entries if e.entry_id == entry.entry_id), None)
        if existing:
            idx = entries.index(existing)
            entries[idx] = entry
        else:
            entries.append(entry)
        return self.save_handbook_entries(entries)

    def remove_handbook_entry(self, entry_id: str) -> bool:
        entries = self.get_handbook_entries()
        entries = [e for e in entries if e.entry_id != entry_id]
        return self.save_handbook_entries(entries)

    # ── Skill Transfers ──────────────────────────────────────────

    def get_skill_transfers(self) -> list[SkillTransfer]:
        return self._read_list(
            self._transfers_file, "transfers", SkillTransfer.from_dict
        )

    def save_skill_transfers(self, transfers: list[SkillTransfer]) -> bool:
        return self._write_json(
            self._transfers_file, {"transfers": [s.to_dict() for s in transfers]}
        )

    def update_skill_transfer_status(self, transfer_id: str, status: str) -> bool:
        transfers = self.get_skill_transfers()
        for t in transfers:
            if t.transfer_id == transfer_id:
                t.status = status
                return self.save_skill_transfers(transfers)
        return False

    # ── Recommendations ──────────────────────────────────────────

    def get_recommendations(
        self, target_project: str | None = None
    ) -> list[ContextualRecommendation]:
        recs = self._read_list(
            self._recommendations_file,
            "recommendations",
            ContextualRecommendation.from_dict,
        )
        if target_project:
            recs = [r for r in recs if r.target_project == target_project]
        return recs

    def save_recommendations(
        self, recommendations: list[ContextualRecommendation]
    ) -> bool:
        return self._write_json(
            self._recommendations_file,
            {"recommendations": [r.to_dict() for r in recommendations]},
        )

    def update_recommendation_status(self, recommendation_id: str, status: str) -> bool:
        recs = self.get_recommendations()
        for r in recs:
            if r.recommendation_id == recommendation_id:
                r.status = status
                return self.save_recommendations(recs)
        return False

    # ── Reports ──────────────────────────────────────────────────

    def save_report(self, report: MeshAnalysisReport) -> bool:
        return self._write_json(self.mesh_dir / "last_report.json", report.to_dict())

    def get_last_report(self) -> MeshAnalysisReport | None:
        data = self._read_json(self.mesh_dir / "last_report.json", None)
        if not isinstance(data, dict) or not data:
            return None
        try:
            return MeshAnalysisReport.from_dict(data)
        except (TypeError, ValueError, AttributeError) as e:
            logger.warning(f"Unreadable last report: {e}")
            return None

    # ── Summary ──────────────────────────────────────────────────

    def get_summary(self) -> dict[str, Any]:
        """Get an overview summary of the mesh state."""
        projects = self.get_projects()
        patterns = self.get_patterns()
        handbook = self.get_handbook_entries()
        transfers = self.get_skill_transfers()
        recs = self.get_recommendations()

        return {
            "project_count": len(projects),
            "pattern_count": len(patterns),
            "handbook_entry_count": len(handbook),
            "skill_transfer_count": len(transfers),
            "recommendation_count": len(recs),
            "active_recommendations": len([r for r in recs if r.status == "active"]),
            "pending_transfers": len([t for t in transfers if t.status == "pending"]),
            "projects": [
                {"name": p.project_name, "path": p.project_path} for p in projects
            ],
        }
