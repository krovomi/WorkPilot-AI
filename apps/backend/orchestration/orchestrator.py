"""
Multi-Repo Orchestrator
========================
The analysis side of a multi-repo orchestration.

A multi-repo task is run by the desktop main process
(``apps/frontend/src/main/multi-repo/``): every repository becomes an ordinary
Kanban task of its own WorkPilot project, so it gets the whole pipeline
(spec, planner, coder, QA, human review, PR). The main process starts those
tasks one after the other and asks this module three things:

1. ``analyze``: read every repo, build the dependency graph, compute the
   execution order (providers first, consumers last), write the master spec;
2. ``brief``: the description of one repo's task, with what its providers
   changed so far;
3. ``check``: after a repo completed, the breaking changes its diff makes for
   the repos that depend on it.

Each step prints ``[MULTI_REPO] {json}`` lines that the main process parses.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from .breaking_changes import BreakingChange, BreakingChangeDetector
from .cross_repo_spec import CrossRepoSpecManager, MultiRepoManifest
from .repo_graph import RepoDependencyGraph

logger = logging.getLogger(__name__)

# What an upstream diff summary may weigh in a downstream task's description.
_MAX_DIFF_STAT_CHARS = 4000


def _emit_progress(event: str, data: dict[str, Any]) -> None:
    """Emit a progress event to stdout for the frontend to parse."""
    payload = json.dumps({"event": event, **data})
    print(f"[MULTI_REPO] {payload}", flush=True)


def _quote_repo_content(text: str, source: str) -> str:
    """Repo-derived text is data for the agent, never an instruction (S2)."""
    from security.untrusted import quote_untrusted

    return quote_untrusted(text, kind="diff", source=source)


class MultiRepoOrchestrator:
    """Analysis, briefs and breaking-change checks of one orchestration."""

    def __init__(
        self,
        master_spec_dir: Path,
        repos: list[dict[str, str]],
        task_description: str,
    ):
        """
        Args:
            master_spec_dir: The orchestration directory (holds the manifest)
            repos: List of repo dicts with 'repo' and 'repo_path' keys
            task_description: The cross-repo task description
        """
        self.master_spec_dir = master_spec_dir
        self.repos = repos
        self.task_description = task_description
        self.spec_manager = CrossRepoSpecManager(master_spec_dir)

    # ------------------------------------------------------------------
    # analyze
    # ------------------------------------------------------------------

    async def analyze(self) -> MultiRepoManifest | None:
        """Graph, execution order and master spec. None on a dependency cycle."""
        _emit_progress(
            "status",
            {"status": "analyzing", "message": "Analyzing repositories..."},
        )
        analyses = await self._analyze_repos()

        graph = RepoDependencyGraph.from_analysis(analyses)
        for repo_info in self.repos:
            graph.add_repo(repo_info["repo"])

        try:
            execution_order = graph.topological_sort()
        except ValueError as e:
            _emit_progress("error", {"code": "cycle", "message": str(e)})
            return None

        manifest = self.spec_manager.create_master_spec(
            task_description=self.task_description,
            repos=self.repos,
            dependency_graph=graph.to_dict(),
            execution_order=execution_order,
        )
        _emit_progress(
            "graph",
            {"graph": graph.to_dict(), "execution_order": execution_order},
        )
        return manifest

    async def _analyze_repos(self) -> dict[str, dict[str, Any]]:
        """Analyze all target repositories."""
        analyses: dict[str, dict[str, Any]] = {}
        for repo_info in self.repos:
            repo_name = repo_info["repo"]
            _emit_progress("repo_analyzing", {"repo": repo_name})
            analyses[repo_name] = await self._analyze_single_repo(
                repo_name, Path(repo_info["repo_path"])
            )
        return analyses

    async def _analyze_single_repo(
        self, repo_name: str, repo_path: Path
    ) -> dict[str, Any]:
        """
        Analyze a single repo to extract dependency and structure info.

        Uses heuristic analysis (package.json, requirements.txt, etc.)
        to detect dependencies and published packages.
        """
        analysis: dict[str, Any] = {
            "repo": repo_name,
            "path": str(repo_path),
            "dependencies": [],
            "published_packages": [],
            "services": [],
            "project_type": "unknown",
        }

        if not repo_path.exists():
            logger.warning(f"Repo path does not exist: {repo_path}")
            return analysis

        # Detect Node.js projects
        package_json = repo_path / "package.json"
        if package_json.exists():
            try:
                with open(package_json, encoding="utf-8") as f:
                    pkg = json.load(f)
                analysis["project_type"] = "node"
                if pkg.get("name"):
                    analysis["published_packages"].append(pkg["name"])
                for dep_section in [
                    "dependencies",
                    "devDependencies",
                    "peerDependencies",
                ]:
                    for dep_name in pkg.get(dep_section, {}):
                        analysis["dependencies"].append(dep_name)
            except (OSError, ValueError, AttributeError):
                logger.debug("unreadable package.json in %s", repo_path)

        # Detect Python projects
        for pyfile in ["requirements.txt", "pyproject.toml", "setup.py"]:
            pypath = repo_path / pyfile
            if pypath.exists():
                analysis["project_type"] = "python"
                if pyfile == "requirements.txt":
                    try:
                        content = pypath.read_text(encoding="utf-8")
                    except OSError:
                        content = ""
                    for line in content.strip().split("\n"):
                        line = line.strip()
                        if line and not line.startswith("#"):
                            pkg_name = (
                                line.split("==")[0]
                                .split(">=")[0]
                                .split("<=")[0]
                                .split("[")[0]
                                .strip()
                            )
                            if pkg_name:
                                analysis["dependencies"].append(pkg_name)
                break

        # Detect monorepo indicators
        monorepo_indicators = [
            "pnpm-workspace.yaml",
            "lerna.json",
            "nx.json",
            "turbo.json",
            "rush.json",
        ]
        for indicator in monorepo_indicators:
            if (repo_path / indicator).exists():
                analysis["project_type"] = "monorepo"
                break

        # Detect workspace packages in monorepo
        for workspace_dir in [repo_path / "packages", repo_path / "apps"]:
            if workspace_dir.is_dir():
                for child in workspace_dir.iterdir():
                    child_pkg = child / "package.json"
                    if child.is_dir() and child_pkg.exists():
                        try:
                            with open(child_pkg, encoding="utf-8") as f:
                                cpkg = json.load(f)
                        except (OSError, ValueError):
                            continue
                        if isinstance(cpkg, dict) and cpkg.get("name"):
                            analysis["published_packages"].append(cpkg["name"])

        return analysis

    # ------------------------------------------------------------------
    # check
    # ------------------------------------------------------------------

    def _load(self) -> tuple[MultiRepoManifest, RepoDependencyGraph]:
        manifest = self.spec_manager.load_manifest()
        if manifest is None:
            raise FileNotFoundError("multi_repo_manifest.json is missing")
        return manifest, RepoDependencyGraph.from_dict(manifest.dependency_graph)

    async def check_breaking_changes(self) -> list[BreakingChange]:
        """Breaking changes of the completed repos, new ones only, saved."""
        manifest, graph = self._load()
        completed = manifest.get_completed_repos()
        if not completed:
            return []

        repo_paths = {sub.repo: Path(sub.repo_path) for sub in manifest.repos}
        worktrees = {
            sub.repo: Path(sub.worktree_path)
            for sub in manifest.repos
            if sub.worktree_path and Path(sub.worktree_path).exists()
        }
        ranges = {
            sub.repo: BreakingChangeDetector.diff_range_for(sub.base_branch)
            for sub in manifest.repos
            if sub.repo in worktrees
        }
        detector = BreakingChangeDetector(repo_paths)
        found = await detector.detect_breaking_changes(
            completed, graph, worktrees, ranges
        )

        def key(bc: dict[str, Any]) -> tuple[str, str, str, str]:
            return (
                bc.get("source_repo", ""),
                bc.get("target_repo", ""),
                bc.get("change_type", ""),
                bc.get("file_path", ""),
            )

        known = {key(bc) for bc in manifest.breaking_changes}
        new = [bc for bc in found if key(bc.to_dict()) not in known]
        if new:
            manifest.breaking_changes.extend(bc.to_dict() for bc in new)
            self.spec_manager.save_manifest(manifest)
        _emit_progress(
            "breaking_changes",
            {
                "changes": [bc.to_dict() for bc in new],
                "summary": detector.build_detection_summary(new),
            },
        )
        return new

    # ------------------------------------------------------------------
    # brief
    # ------------------------------------------------------------------

    def build_brief(self, repo_name: str) -> str:
        """The description of `repo_name`'s Kanban task."""
        manifest, graph = self._load()
        if manifest.get_sub_spec(repo_name) is None:
            raise KeyError(f"{repo_name} is not part of this orchestration")

        order = manifest.execution_order or [sub.repo for sub in manifest.repos]
        lines = [
            manifest.task_description,
            "",
            "## Multi-repo change",
            "",
            f"This task is the **{repo_name}** part of a change that spans "
            f"{len(order)} repositories, worked in this order: "
            + ", ".join(order)
            + ".",
            f"Implement only what belongs in {repo_name}. The other repositories "
            "have tasks of their own: do not change them.",
        ]

        providers = [d for d in graph.dependencies if d.source_repo == repo_name]
        consumers = [d for d in graph.dependencies if d.target_repo == repo_name]
        if providers or consumers:
            lines.extend(["", "## Dependencies", ""])
            for dep in providers:
                detail = f" ({dep.details})" if dep.details else ""
                lines.append(
                    f"- {repo_name} depends on {dep.target_repo}: "
                    f"{dep.dependency_type.value}{detail}"
                )
            for dep in consumers:
                detail = f" ({dep.details})" if dep.details else ""
                lines.append(
                    f"- {dep.source_repo} depends on {repo_name}: "
                    f"{dep.dependency_type.value}{detail}. Keep it working."
                )

        # Every repo done before this one, not only its detected providers: a
        # frontend calling a backend over HTTP shares no package with it.
        done = [
            sub
            for sub in manifest.repos
            if sub.status == "completed" and sub.repo != repo_name
        ]
        if done:
            lines.extend(["", "## What the repositories done before it changed", ""])
            for sub in done:
                lines.append(f"### {sub.repo}")
                if sub.branch_name:
                    lines.append(f"- Branch: `{sub.branch_name}`")
                if sub.pr_url:
                    lines.append(f"- Pull request: {sub.pr_url}")
                stat = self._upstream_diff_stat(sub.worktree_path, sub.base_branch)
                if stat:
                    lines.extend(
                        [
                            "- Files changed:",
                            "",
                            _quote_repo_content(stat, source=f"diff:{sub.repo}"),
                        ]
                    )
                lines.append("")

        breaks = [
            BreakingChange.from_dict(bc)
            for bc in manifest.breaking_changes
            if bc.get("target_repo") == repo_name
        ]
        if breaks:
            summary = BreakingChangeDetector({}).build_detection_summary(breaks)
            lines.extend(
                [
                    "",
                    "## Breaking changes to address",
                    "",
                    _quote_repo_content(summary, source="breaking_changes"),
                ]
            )

        return "\n".join(lines).rstrip() + "\n"

    @staticmethod
    def _upstream_diff_stat(worktree_path: str, base_branch: str) -> str:
        if not worktree_path or not Path(worktree_path).exists():
            return ""
        detector = BreakingChangeDetector({})
        stat = detector.diff_stat(
            Path(worktree_path), BreakingChangeDetector.diff_range_for(base_branch)
        ).strip()
        if len(stat) > _MAX_DIFF_STAT_CHARS:
            stat = stat[:_MAX_DIFF_STAT_CHARS] + "\n…"
        return stat
