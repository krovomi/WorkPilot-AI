"""
Bounty Board core — orchestrate N contestants competing on the same spec.

Each contestant runs in its own isolated git worktree with a configurable
(provider, model, prompt_override) triple, concurrently. When they are done the
judge measures what each one left on disk and the highest-scoring worktree is
proposed as the winner.

Provider-agnostic: the contestant runner is pluggable, and the default one
(`runner.default_contestant_runner`) dispatches through
`core.client.create_agent_client`, which takes an explicit provider — so any
provider WorkPilot supports can be fielded without a branch here.

The parts of the job live apart on purpose, and the dependencies point one way:

| Module       | Answers                                                    | Imports |
|--------------|------------------------------------------------------------|---------|
| `models.py`  | what a contestant and a result *are*                       | nothing |
| `signals.py` | what a contestant produced — diff, tests; no model involved | nothing |
| `runner.py`  | how one contestant is run                                   | models |
| `judge.py`   | what that is worth                                          | models, signals |
| `board.py`   | orchestration                                               | all of them |

They were one file, and the consequence was not tidiness: the judge read the
contestant's *answer text*, because that was the object in front of it, and
scored a contest on prose length while the diffs went unread.

`models.py` is separate for a second reason. With the dataclasses in this file,
`judge` and `runner` reached back up for `Contestant` and the graph described a
cycle — harmless at runtime, since the reach was under `if TYPE_CHECKING`, and
still the wrong direction. The shared type belongs underneath both sides.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from pathlib import Path

from .judge import evidence_judge, summarize_criteria
from .models import (
    BountyResult,
    Contestant,
    ContestantRunner,
    ContestantSpec,
    Judge,
)
from .runner import contestant_prompt, default_contestant_runner
from .signals import Evidence, collect_evidence, discover_test_command, is_git_repo

logger = logging.getLogger(__name__)

__all__ = [
    "BountyBoard",
    "BountyResult",
    "Contestant",
    "ContestantSpec",
    "contestant_prompt",
    "default_contestant_runner",
    "run_bounty",
]


# ─── Orchestrator ──────────────────────────────────────────────────────────────


class BountyBoard:
    """Orchestrates a single bounty run."""

    def __init__(
        self,
        spec_dir: Path,
        project_path: Path,
        contestants: list[ContestantSpec],
        runner: ContestantRunner | None = None,
        judge: Judge | None = None,
        *,
        run_tests: bool = True,
        use_model_judge: bool = True,
    ) -> None:
        if not contestants:
            raise ValueError("At least one contestant is required")
        self.spec_dir = Path(spec_dir)
        self.project_path = Path(project_path)
        self.runner = runner or default_contestant_runner
        self.judge = judge or evidence_judge
        self.run_tests = run_tests
        self.use_model_judge = use_model_judge
        self.contestants: list[Contestant] = [
            _materialize(spec, idx, self.spec_dir)
            for idx, spec in enumerate(contestants)
        ]
        self.bounty_id = f"bounty-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
        self.warnings: list[str] = []

    async def run(self) -> BountyResult:
        spec_prompt = _load_spec_prompt(self.spec_dir)
        _prepare_worktrees(
            self.project_path, self.bounty_id, self.contestants, self.warnings
        )

        # Run all contestants in parallel. `return_exceptions` keeps one
        # contestant's crash from cancelling the others mid-flight; the runner
        # already records its own failures, so anything arriving here is a bug
        # in a custom runner rather than a contestant outcome.
        outcomes = await asyncio.gather(
            *[
                self.runner(c, spec_prompt, Path(c.worktree_path or self.project_path))
                for c in self.contestants
            ],
            return_exceptions=True,
        )
        for contestant, outcome in zip(self.contestants, outcomes, strict=False):
            if isinstance(outcome, BaseException) and contestant.status != "error":
                contestant.status = "error"
                contestant.error = f"{type(outcome).__name__}: {outcome}"

        evidences = await self._collect_evidence()

        winner_id, rationale = await self.judge(
            self.contestants,
            evidences,
            spec_prompt,
            self.project_path,
            self.spec_dir,
            use_model_judge=self.use_model_judge,
        )

        for c in self.contestants:
            c.status = (
                "winner"
                if c.id == winner_id
                else ("archived" if c.status == "completed" else c.status)
            )

        result = BountyResult(
            id=self.bounty_id,
            spec_id=self.spec_dir.name,
            project_path=str(self.project_path),
            contestants=self.contestants,
            winner_id=winner_id or None,
            judge_report=_format_judge_report(
                self.contestants, winner_id, rationale, self.warnings
            ),
            judge_rationale=rationale,
            scoring=summarize_criteria(self.contestants),
            warnings=list(self.warnings),
            completed_at=int(time.time() * 1000),
            status="completed",
        )
        _persist_result(self.spec_dir, result)
        return result

    async def _collect_evidence(self) -> dict[str, Evidence]:
        """Measure every contestant's worktree.

        Sequential on purpose: these run the project's test suite, and N suites
        racing each other over the same ports, temp files and package caches
        measures the contention rather than the contestants.
        """
        test_command = (
            discover_test_command(self.project_path) if self.run_tests else None
        )
        if self.run_tests and not test_command:
            self.warnings.append(
                "No test command discovered for this project — the tests criterion "
                "was not measured and its weight was redistributed."
            )

        evidences: dict[str, Evidence] = {}
        for contestant in self.contestants:
            if not contestant.worktree_path:
                evidences[contestant.id] = Evidence()
                continue
            evidences[contestant.id] = await collect_evidence(
                Path(contestant.worktree_path),
                contestant.base_ref or "HEAD",
                test_command,
                run_test_suite=self.run_tests,
            )
        return evidences


# ─── Helpers ───────────────────────────────────────────────────────────────────


def _materialize(spec: ContestantSpec, idx: int, spec_dir: Path) -> Contestant:
    label = spec.label or chr(ord("A") + idx)
    return Contestant(
        id=f"c-{uuid.uuid4().hex[:8]}",
        label=label,
        provider=spec.provider,
        model=spec.model,
        profile_id=spec.profile_id,
        # Carried through rather than dropped: this is the per-entry strategy
        # the UI offers, and until now nothing downstream ever received it.
        prompt_override=spec.prompt_override,
        spec_dir=str(spec_dir),
    )


def _load_spec_prompt(spec_dir: Path) -> str:
    """Load the spec content. We look for `spec.md`, falling back to the directory name."""
    spec_md = spec_dir / "spec.md"
    if spec_md.exists():
        try:
            return spec_md.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""
    return f"Spec {spec_dir.name}"


def _prepare_worktrees(
    project_path: Path,
    bounty_id: str,
    contestants: list[Contestant],
    warnings: list[str],
) -> None:
    """Give each contestant an isolated checkout to work in.

    Real `git worktree`s when the project is a git repository, because the diff
    each contestant leaves behind is what the judge scores — without one there
    is no diff, and the board is back to grading prose. Created sequentially:
    `git worktree add` prunes and writes repository-global state, so N of them
    racing is how two contestants end up sharing a branch.

    A project that is not a git repository still runs, in plain directories,
    and the missing signal is recorded as a warning rather than quietly scored
    as zero.
    """
    base = project_path / ".workpilot" / "bounty" / bounty_id
    base.mkdir(parents=True, exist_ok=True)

    if not is_git_repo(project_path):
        warnings.append(
            "Project is not a git repository — contestants ran in plain directories, "
            "so no diff could be measured and the spec-fit criterion was dropped."
        )
        for c in contestants:
            path = base / c.label
            path.mkdir(parents=True, exist_ok=True)
            c.worktree_path = str(path)
        return

    try:
        from core.worktree import WorktreeManager
    except ImportError:
        warnings.append(
            "WorktreeManager unavailable — contestants share the project tree."
        )
        for c in contestants:
            c.worktree_path = str(project_path)
        return

    manager = WorktreeManager(project_path)
    for c in contestants:
        name = f"{bounty_id}-{c.label}"
        try:
            info = manager.create_worktree(name)
            c.worktree_path = str(info.path)
            c.branch = info.branch
            c.base_ref = info.base_branch
        except Exception as exc:  # noqa: BLE001 - one contestant, not the board
            logger.warning("Worktree for contestant %s failed: %s", c.label, exc)
            warnings.append(f"Contestant {c.label}: worktree creation failed ({exc}).")
            c.status = "error"
            c.error = f"worktree creation failed: {exc}"


def _format_judge_report(
    contestants: list[Contestant],
    winner_id: str | None,
    rationale: dict[str, str],
    warnings: list[str],
) -> str:
    lines = ["# Judge report", ""]
    if not winner_id:
        lines += [
            "**No winner.** No contestant scored above zero, or the top score was tied.",
            "",
        ]
    for c in sorted(
        contestants, key=lambda x: x.score if x.score is not None else -1, reverse=True
    ):
        marker = " 🏆" if c.id == winner_id else ""
        score = f"{c.score:.1f}" if c.score is not None else "—"
        lines.append(
            f"- **{c.label}** ({c.provider}:{c.model}) — score: {score}{marker}"
        )
        if reason := rationale.get(c.id):
            lines.append(f"  - {reason}")
    if warnings:
        lines += ["", "## Warnings", ""]
        lines += [f"- {w}" for w in warnings]
    return "\n".join(lines)


def _persist_result(spec_dir: Path, result: BountyResult) -> None:
    try:
        out_dir = spec_dir / "bounty"
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"{result.id}.json").write_text(
            json.dumps(result.to_dict(), indent=2), encoding="utf-8"
        )
    except OSError as exc:
        logger.warning("Could not persist bounty result: %s", exc)


# ─── Convenience ───────────────────────────────────────────────────────────────


async def run_bounty(
    spec_dir: Path,
    project_path: Path,
    contestants: list[ContestantSpec],
    runner: ContestantRunner | None = None,
    judge: Judge | None = None,
    *,
    run_tests: bool = True,
    use_model_judge: bool = True,
) -> BountyResult:
    """One-shot helper to run a bounty from inputs."""
    board = BountyBoard(
        spec_dir,
        project_path,
        contestants,
        runner=runner,
        judge=judge,
        run_tests=run_tests,
        use_model_judge=use_model_judge,
    )
    return await board.run()
