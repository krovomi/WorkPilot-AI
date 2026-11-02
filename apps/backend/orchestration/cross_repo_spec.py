"""
Cross-Repo Spec Manager
========================
The manifest of a multi-repo orchestration and the master spec that goes with it.

Each repository of an orchestration becomes an ordinary Kanban task of its own
project; the manifest records which one (``project_id`` / ``task_id``), where
its worktree is, and how far it got. The desktop main process writes those
fields while it drives the tasks; the runner writes the graph, the execution
order and the breaking changes. Both use this one schema.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


@dataclass
class RepoSubSpec:
    """Spec for a single repository within a multi-repo orchestration."""

    repo: str  # display name (the repo's WorkPilot project name)
    repo_path: str  # Local filesystem path to the repo
    project_id: str = ""  # WorkPilot project that holds the repo's task
    task_id: str = ""  # Kanban task created for this repo
    worktree_path: str = ""  # Worktree path once created
    status: str = (
        "pending"  # pending | planning | coding | qa | completed | failed | skipped
    )
    pr_url: str = ""
    branch_name: str = ""
    base_branch: str = ""  # Branch the task's worktree started from
    progress: float = 0.0  # 0-100
    current_phase: str = ""
    error_message: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "repo": self.repo,
            "repo_path": self.repo_path,
            "project_id": self.project_id,
            "task_id": self.task_id,
            "worktree_path": self.worktree_path,
            "status": self.status,
            "pr_url": self.pr_url,
            "branch_name": self.branch_name,
            "base_branch": self.base_branch,
            "progress": self.progress,
            "current_phase": self.current_phase,
            "error_message": self.error_message,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RepoSubSpec:
        return cls(
            repo=data["repo"],
            repo_path=data.get("repo_path", ""),
            project_id=data.get("project_id", ""),
            task_id=data.get("task_id", ""),
            worktree_path=data.get("worktree_path", ""),
            status=data.get("status", "pending"),
            pr_url=data.get("pr_url", ""),
            branch_name=data.get("branch_name", ""),
            base_branch=data.get("base_branch", ""),
            progress=data.get("progress", 0.0),
            current_phase=data.get("current_phase", ""),
            error_message=data.get("error_message", ""),
        )


@dataclass
class MultiRepoManifest:
    """
    Master manifest for a multi-repo orchestration.

    Stored as multi_repo_manifest.json in the master spec directory.
    """

    task_description: str
    repos: list[RepoSubSpec] = field(default_factory=list)
    dependency_graph: dict[str, Any] = field(default_factory=dict)
    execution_order: list[str] = field(default_factory=list)
    status: str = (
        "pending"  # pending | analyzing | executing | completed | failed | stopped
    )
    status_message: str = ""  # i18n key of why the run stopped or waits
    status_repo: str = ""  # the repo that status is about
    created_at: str = ""
    updated_at: str = ""
    breaking_changes: list[dict[str, Any]] = field(default_factory=list)

    def __post_init__(self):
        if not self.created_at:
            self.created_at = datetime.now(UTC).isoformat()
        self.updated_at = datetime.now(UTC).isoformat()

    def get_sub_spec(self, repo: str) -> RepoSubSpec | None:
        """Get sub-spec for a repository."""
        for sub in self.repos:
            if sub.repo == repo:
                return sub
        return None

    def update_sub_spec_status(self, repo: str, status: str, **kwargs: Any) -> None:
        """Update status and optional fields for a repo sub-spec."""
        sub = self.get_sub_spec(repo)
        if sub:
            sub.status = status
            for key, value in kwargs.items():
                if hasattr(sub, key):
                    setattr(sub, key, value)
            self.updated_at = datetime.now(UTC).isoformat()

    def get_completed_repos(self) -> list[str]:
        """Get list of repos that have completed successfully."""
        return [sub.repo for sub in self.repos if sub.status == "completed"]

    def get_overall_progress(self) -> float:
        """Calculate overall orchestration progress (0-100)."""
        if not self.repos:
            return 0.0
        total = sum(sub.progress for sub in self.repos)
        return total / len(self.repos)

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_description": self.task_description,
            "repos": [sub.to_dict() for sub in self.repos],
            "dependency_graph": self.dependency_graph,
            "execution_order": self.execution_order,
            "status": self.status,
            "status_message": self.status_message,
            "status_repo": self.status_repo,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "breaking_changes": self.breaking_changes,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> MultiRepoManifest:
        manifest = cls(
            task_description=data.get("task_description", ""),
            dependency_graph=data.get("dependency_graph", {}),
            execution_order=data.get("execution_order", []),
            status=data.get("status", "pending"),
            status_message=data.get("status_message", ""),
            status_repo=data.get("status_repo", ""),
            created_at=data.get("created_at", ""),
            updated_at=data.get("updated_at", ""),
            breaking_changes=data.get("breaking_changes", []),
        )
        manifest.repos = [RepoSubSpec.from_dict(r) for r in data.get("repos", [])]
        return manifest


class CrossRepoSpecManager:
    """
    Manages the directory of one orchestration.

    Directory structure (``<project>/.workpilot/multi-repo/<id>/``)::

        spec.md                      # Master spec: task, repos, execution order
        multi_repo_manifest.json     # Orchestration state (shared with the main process)

    It lives outside ``.workpilot/specs/`` on purpose: a spec directory is a
    Kanban card, and an orchestration is not one. Its repos' cards live in
    their own projects.
    """

    MANIFEST_FILE = "multi_repo_manifest.json"

    def __init__(self, master_spec_dir: Path):
        self.master_spec_dir = master_spec_dir

    def create_master_spec(
        self,
        task_description: str,
        repos: list[dict[str, str]],
        dependency_graph: dict[str, Any],
        execution_order: list[str],
    ) -> MultiRepoManifest:
        """
        Write the master spec and the manifest.

        A manifest already in the directory (the one the main process wrote
        when the orchestration was created, or a previous analysis) keeps its
        per-repo fields: the project, task and worktree a repo already has
        are not forgotten by a second analysis.

        Args:
            task_description: The cross-repo task description
            repos: List of repo dicts with 'repo' and 'repo_path' keys
            dependency_graph: Serialized RepoDependencyGraph
            execution_order: Topological order for execution
        """
        self.master_spec_dir.mkdir(parents=True, exist_ok=True)
        previous = self.load_manifest()

        sub_specs = []
        for repo_info in repos:
            repo_name = repo_info["repo"]
            known = previous.get_sub_spec(repo_name) if previous else None
            if known is not None:
                known.repo_path = repo_info.get("repo_path", known.repo_path)
                sub_specs.append(known)
            else:
                sub_specs.append(
                    RepoSubSpec(
                        repo=repo_name,
                        repo_path=repo_info.get("repo_path", ""),
                        project_id=repo_info.get("project_id", ""),
                    )
                )

        manifest = MultiRepoManifest(
            task_description=task_description,
            repos=sub_specs,
            dependency_graph=dependency_graph,
            execution_order=execution_order,
            created_at=previous.created_at if previous else "",
            breaking_changes=previous.breaking_changes if previous else [],
        )

        spec_content = self._generate_master_spec_md(
            task_description, repos, execution_order
        )
        (self.master_spec_dir / "spec.md").write_text(spec_content, encoding="utf-8")
        self.save_manifest(manifest)
        return manifest

    def _generate_master_spec_md(
        self,
        task_description: str,
        repos: list[dict[str, str]],
        execution_order: list[str],
    ) -> str:
        """Generate the master spec markdown document."""
        lines = [
            "# Multi-Repo Orchestration Spec",
            "",
            "## Task Description",
            "",
            task_description,
            "",
            "## Target Repositories",
            "",
        ]
        for repo_info in repos:
            repo = repo_info["repo"]
            path = repo_info.get("repo_path", "N/A")
            lines.append(f"- **{repo}** — `{path}`")

        lines.extend(["", "## Execution Order", ""])
        for i, repo in enumerate(execution_order, 1):
            lines.append(f"{i}. {repo}")

        lines.extend(
            [
                "",
                "## Cross-Repo Coordination Notes",
                "",
                "- Each repository gets a Kanban task of its own project",
                "- Providers run first; a consumer starts once its providers passed QA",
                "- A consumer's task describes what its providers changed",
                "- Breaking changes are detected after each repository completes",
            ]
        )

        return "\n".join(lines) + "\n"

    def save_manifest(self, manifest: MultiRepoManifest) -> None:
        """Save manifest to disk."""
        manifest.updated_at = datetime.now(UTC).isoformat()
        manifest_path = self.master_spec_dir / self.MANIFEST_FILE
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest.to_dict(), f, indent=2)

    def load_manifest(self) -> MultiRepoManifest | None:
        """Load manifest from disk. Returns None if not found."""
        manifest_path = self.master_spec_dir / self.MANIFEST_FILE
        if not manifest_path.exists():
            return None
        with open(manifest_path, encoding="utf-8") as f:
            return MultiRepoManifest.from_dict(json.load(f))
