"""
Multi-Repo Orchestration Runner
=================================
The analysis steps of a multi-repo orchestration, called by the desktop main
process (``apps/frontend/src/main/multi-repo/``), which runs each repository
as a Kanban task of its own project. See ``orchestration/orchestrator.py``.

Usage:
    python runners/multi_repo_runner.py analyze --spec-dir DIR \
        --task "Add auth across services" \
        --repos "frontend::/path/to/frontend,backend::/path/to/backend"

    python runners/multi_repo_runner.py brief --spec-dir DIR --repo frontend

    python runners/multi_repo_runner.py check --spec-dir DIR

Every step prints ``[MULTI_REPO] {json}`` lines; exit code 0 on success.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from orchestration import MultiRepoOrchestrator

logger = logging.getLogger(__name__)


def _emit(event: str, **data: object) -> None:
    print(f"[MULTI_REPO] {json.dumps({'event': event, **data})}", flush=True)


def parse_repos(repos_str: str) -> list[dict[str, str]]:
    """
    Parse comma-separated repo specifications.

    Formats supported:
    - name::/path/to/repo               (explicit name + local path)
    - /path/to/repo                     (local path only, name inferred)
    """
    repos = []
    for entry in repos_str.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if "::" in entry:
            name, path = entry.split("::", 1)
            repos.append({"repo": name.strip(), "repo_path": path.strip()})
        else:
            path = Path(entry).resolve()
            repos.append({"repo": path.name, "repo_path": str(path)})
    return repos


def _orchestrator(spec_dir: Path) -> MultiRepoOrchestrator:
    """An orchestrator for an existing manifest (brief, check)."""
    manifest_path = spec_dir / "multi_repo_manifest.json"
    with open(manifest_path, encoding="utf-8") as f:
        data = json.load(f)
    repos = [
        {"repo": r.get("repo", ""), "repo_path": r.get("repo_path", "")}
        for r in data.get("repos", [])
    ]
    return MultiRepoOrchestrator(spec_dir, repos, data.get("task_description", ""))


def run_analyze(args: argparse.Namespace) -> int:
    repos = parse_repos(args.repos)
    if len(repos) < 2:
        _emit("error", code="too_few_repos", message="At least 2 repositories")
        return 1
    for repo_info in repos:
        if not Path(repo_info["repo_path"]).is_dir():
            _emit("error", code="repo_not_found", repo=repo_info["repo"])
            return 1
    orchestrator = MultiRepoOrchestrator(args.spec_dir, repos, args.task)
    manifest = asyncio.run(orchestrator.analyze())
    return 0 if manifest is not None else 1


def run_brief(args: argparse.Namespace) -> int:
    brief = _orchestrator(args.spec_dir).build_brief(args.repo)
    _emit("brief", repo=args.repo, description=brief)
    return 0


def run_check(args: argparse.Namespace) -> int:
    asyncio.run(_orchestrator(args.spec_dir).check_breaking_changes())
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Analysis steps of a multi-repo orchestration"
    )
    parser.add_argument("--verbose", action="store_true", help="Verbose logging")
    sub = parser.add_subparsers(dest="command", required=True)

    analyze = sub.add_parser("analyze", help="Dependency graph and execution order")
    analyze.add_argument("--spec-dir", type=Path, required=True)
    analyze.add_argument("--task", type=str, required=True)
    analyze.add_argument(
        "--repos",
        type=str,
        required=True,
        help="Comma-separated name::path specifications",
    )
    analyze.set_defaults(handler=run_analyze)

    brief = sub.add_parser("brief", help="Description of one repo's task")
    brief.add_argument("--spec-dir", type=Path, required=True)
    brief.add_argument("--repo", type=str, required=True)
    brief.set_defaults(handler=run_brief)

    check = sub.add_parser("check", help="Breaking changes of the completed repos")
    check.add_argument("--spec-dir", type=Path, required=True)
    check.set_defaults(handler=run_check)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )
    try:
        return args.handler(args)
    except (OSError, ValueError, KeyError) as e:
        logger.exception("multi-repo %s failed", args.command)
        _emit("error", code="step_failed", message=str(e))
        return 1


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(main())
