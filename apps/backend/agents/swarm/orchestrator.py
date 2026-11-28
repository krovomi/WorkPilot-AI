"""
Swarm Orchestrator
==================

Main coordinator for multi-agent parallel execution.

Workflow:
1. Load the implementation plan and analyze subtask dependencies
2. Build waves of parallelizable subtasks
3. For each wave:
   a. Give each subtask its own git worktree, from the task's branch
   b. Execute the subtasks in parallel (``run.py --subtask`` in each worktree)
   c. Merge the branch of each finished subtask into the task's branch, and
      its entry into the task's plan (``subtask_worktree``); a subtask whose
      merge conflicts stays pending for the task's own coder
4. Report final status

Before each wave and each retry (the first wave included), the orchestrator
asks whether it may go on (``halt.stop_reason``): a task paused in any copy of
its spec directory, or a ``workpilot.policy.yaml`` that says stop (outside the
hours, past a token budget, invalid), ends the swarm there, phase ``paused``.
Nothing new starts; the coder loop then stops the build at that pause.

Outside a git checkout (the standalone runner's dry runs, tests) the
subtasks run in the project itself and nothing is merged.

The orchestrator emits structured events to stdout for the Electron
frontend to parse and display in the Pixel Office / Kanban board.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from core.workflow_logger import workflow_logger
from foundation.phase_event import ExecutionPhase, emit_phase

from . import halt, subtask_worktree
from .dependency_analyzer import DependencyAnalyzer
from .types import (
    SubtaskNode,
    SubtaskState,
    SwarmConfig,
    SwarmPhase,
    SwarmStatus,
    Wave,
)
from .wave_executor import WaveExecutor, WaveResult, emit_swarm_event

logger = logging.getLogger(__name__)

AGENT_NAME = "Swarm Orchestrator"


class SwarmOrchestrator:
    """
    Orchestrates multi-agent parallel execution of subtasks.

    Given a spec directory with an implementation_plan.json, this orchestrator:
    1. Analyzes subtask dependencies to determine parallelism
    2. Groups subtasks into waves (DAG-based topological scheduling)
    3. Executes each wave in parallel using subprocess agents
    4. Merges results between waves using the semantic merge system
    """

    def __init__(
        self,
        project_dir: Path,
        spec_dir: Path,
        config: SwarmConfig | None = None,
        model: str | None = None,
        python_path: str | None = None,
        source_path: str | None = None,
    ) -> None:
        self.project_dir = Path(project_dir).resolve()
        self.spec_dir = Path(spec_dir).resolve()
        self.config = config or SwarmConfig()
        self.model = model
        self.status = SwarmStatus(config=self.config)

        self._analyzer = DependencyAnalyzer(
            max_parallel=self.config.max_parallel_agents
        )
        self._executor = WaveExecutor(
            project_dir=self.project_dir,
            spec_dir=self.spec_dir,
            config=self.config,
            python_path=python_path,
            source_path=source_path,
        )
        self._trace_id: str | None = None
        self._worktrees: dict[str, subtask_worktree.SubtaskWorktree] = {}
        self._isolated = False

    async def run(self) -> SwarmStatus:
        """
        Execute the full swarm pipeline.

        Returns:
            SwarmStatus with complete execution details.
        """
        self._trace_id = workflow_logger.log_agent_start(
            AGENT_NAME,
            "swarm_execution",
            {
                "project_dir": str(self.project_dir),
                "spec_dir": str(self.spec_dir),
                "config": self.config.to_dict(),
            },
        )

        try:
            return await self._run_pipeline()
        except subtask_worktree.SubtaskWorktreeError as e:
            self.status.phase = SwarmPhase.FAILED
            self.status.error = str(e)
            self.status.completed_at = time.time()
            emit_swarm_event("swarm_failed", {"error": str(e)})
            return self.status
        except Exception as e:
            self.status.phase = SwarmPhase.FAILED
            self.status.error = str(e)
            self.status.completed_at = time.time()
            logger.error("Swarm execution failed: %s", e, exc_info=True)
            emit_swarm_event("swarm_failed", {"error": str(e)})
            return self.status
        finally:
            self._close_worktrees()
            workflow_logger.log_agent_end(
                AGENT_NAME,
                "success" if self.status.phase == SwarmPhase.COMPLETE else "failed",
                {
                    "total_subtasks": self.status.total_subtasks,
                    "completed": self.status.completed_subtasks,
                    "failed": self.status.failed_subtasks,
                    "waves": self.status.total_waves,
                    "duration_seconds": self.status.duration_seconds,
                },
                trace_id=self._trace_id,
            )

    async def _run_pipeline(self) -> SwarmStatus:
        """Core pipeline: analyze → execute waves → merge → report."""

        # ── Phase 1: Load plan and analyze dependencies ──────────────
        self.status.phase = SwarmPhase.ANALYZING_DEPENDENCIES
        # The swarm is how the coding phase runs: the card stays in coding.
        emit_phase(
            ExecutionPhase.CODING,
            "Analyzing subtask dependencies for parallel execution",
        )
        emit_swarm_event("phase_changed", {"phase": "analyzing_dependencies"})

        plan = self._load_plan()
        if not plan:
            self.status.phase = SwarmPhase.FAILED
            self.status.error = "No implementation plan found"
            return self.status

        waves, nodes = self._analyzer.analyze(plan)
        stats = self._analyzer.get_parallelism_stats(waves)
        self._isolated = subtask_worktree.is_checkout(self.project_dir)

        self.status.waves = waves
        self.status.nodes = nodes
        self.status.total_waves = len(waves)
        self.status.total_subtasks = len(nodes)

        logger.info(
            "Swarm plan: %d subtasks in %d waves (max parallelism: %d, speedup: %.1fx)",
            stats["total_subtasks"],
            stats["total_waves"],
            stats["max_parallelism"],
            stats["speedup_estimate"],
        )

        emit_swarm_event(
            "analysis_complete",
            {
                "total_subtasks": len(nodes),
                "total_waves": len(waves),
                "parallelism_stats": stats,
            },
        )

        # Check if parallelism is worthwhile
        if len(waves) == len(nodes):
            logger.info("No parallelism possible — all subtasks are sequential")
            emit_swarm_event(
                "swarm_skipped",
                {
                    "reason": "no_parallelism",
                    "message": "All subtasks have dependencies — falling back to sequential execution",
                },
            )
            # Fall through to sequential execution (waves of 1)

        # ── Phase 2: Execute waves ───────────────────────────────────
        for wave_idx, wave in enumerate(waves):
            if self._halted(f"before wave {wave_idx + 1}"):
                return self.status
            self.status.current_wave = wave_idx
            self.status.phase = SwarmPhase.EXECUTING_WAVE

            emit_phase(
                ExecutionPhase.CODING,
                f"Wave {wave_idx + 1}/{len(waves)}: executing {len(wave.subtask_ids)} subtasks in parallel",
                progress=self._calculate_progress(wave_idx, len(waves)),
                subtask=f"wave-{wave_idx + 1}",
            )

            emit_swarm_event(
                "phase_changed",
                {
                    "phase": "executing_wave",
                    "wave_index": wave_idx,
                    "wave_size": len(wave.subtask_ids),
                },
            )

            if self._isolated:
                self._open_worktrees(wave, nodes)

            # Execute the wave
            wave_result = await self._executor.execute_wave(
                wave=wave,
                nodes=nodes,
                on_subtask_started=self._on_subtask_started,
                on_subtask_completed=self._on_subtask_completed,
                on_subtask_failed=self._on_subtask_failed,
                on_subtask_log=self._on_subtask_log,
            )

            # Update counters
            self._update_counters_from_wave_result(wave_result)

            # Handle failures
            if not wave_result.all_succeeded:
                failed_ids = [
                    r.subtask_id for r in wave_result.results if not r.success
                ]
                logger.warning(
                    "Wave %d: %d subtasks failed: %s",
                    wave_idx,
                    len(failed_ids),
                    ", ".join(failed_ids),
                )

                if self.config.fail_fast:
                    self.status.phase = SwarmPhase.FAILED
                    self.status.error = f"Wave {wave_idx} failed (fail_fast=true): {', '.join(failed_ids)}"
                    self.status.completed_at = time.time()
                    await self._executor.cancel_all()
                    return self.status

                # Retry failed subtasks that haven't exceeded max retries
                await self._retry_failed_subtasks(wave, wave_result, nodes)
                if self.status.phase == SwarmPhase.PAUSED:
                    # What the wave finished is kept: the task's coder resumes on it.
                    if self._isolated:
                        self._merge_wave(wave, wave_result)
                        self.status.phase = SwarmPhase.PAUSED
                    return self.status

            # ── Phase 2b: Merge wave results ─────────────────────────
            # The next wave starts from the task's branch: it has to hold
            # this one's work first.
            if self._isolated:
                self._merge_wave(wave, wave_result)

        # ── Complete ─────────────────────────────────────────────────
        self.status.phase = SwarmPhase.COMPLETE
        self.status.completed_at = time.time()

        # Not the build's completion: QA and the review still follow.
        emit_phase(
            ExecutionPhase.CODING,
            f"Swarm complete: {self.status.completed_subtasks}/{self.status.total_subtasks} subtasks",
            progress=90,
        )

        emit_swarm_event(
            "swarm_complete",
            {
                "completed": self.status.completed_subtasks,
                "failed": self.status.failed_subtasks,
                "total": self.status.total_subtasks,
                "waves": self.status.total_waves,
                "duration_seconds": self.status.duration_seconds,
            },
        )

        return self.status

    def _halted(self, where: str) -> bool:
        """Whether the swarm stops here, the task paused or its policy saying so."""
        if self.status.phase == SwarmPhase.PAUSED:
            return True
        reason = halt.stop_reason(self.spec_dir)
        if reason is None:
            return False
        self.status.phase = SwarmPhase.PAUSED
        self.status.error = f"paused {where} ({reason})"
        self.status.completed_at = time.time()
        print(f"Swarm stopped {where}: the task is paused ({reason}).", flush=True)
        emit_swarm_event("swarm_cancelled", {"reason": reason, "where": where})
        return True

    def _load_plan(self) -> dict | None:
        """Load the implementation plan from spec directory."""
        plan_file = self.spec_dir / "implementation_plan.json"
        if not plan_file.exists():
            logger.error("No implementation_plan.json found in %s", self.spec_dir)
            return None
        try:
            with open(plan_file, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError) as e:
            logger.error("Failed to load implementation plan: %s", e)
            return None

    def _calculate_progress(self, wave_idx: int, total_waves: int) -> int:
        """Calculate overall progress percentage based on wave progress."""
        if total_waves == 0:
            return 0
        # Reserve 10% for analysis and 10% for final merge
        wave_progress_range = 80  # 10% to 90%
        per_wave = wave_progress_range / total_waves
        return int(10 + (wave_idx * per_wave))

    def _update_counters_from_wave_result(self, result: WaveResult) -> None:
        """Update status counters from a wave result."""
        for sr in result.results:
            if sr.success:
                self.status.completed_subtasks += 1
            else:
                self.status.failed_subtasks += 1
        self.status.running_subtasks = 0  # Wave done

    async def _retry_failed_subtasks(
        self,
        wave: Wave,
        result: WaveResult,
        nodes: dict[str, SubtaskNode],
    ) -> None:
        """Retry each failed subtask, up to ``max_retries_per_subtask`` times.

        A subtask that succeeds on a retry takes its place in ``result`` as a
        success, so the wave's merge includes it.
        """
        for position, sr in enumerate(result.results):
            if sr.success:
                continue

            # The executor only reports the subtasks it found in ``nodes``.
            node = nodes[sr.subtask_id]

            while node.retry_count < self.config.max_retries_per_subtask:
                if self._halted(f"before retrying {node.id}"):
                    break
                node.retry_count += 1
                node.state = SubtaskState.RETRYING

                logger.info(
                    "Retrying subtask %s (attempt %d/%d)",
                    node.id,
                    node.retry_count,
                    self.config.max_retries_per_subtask,
                )

                emit_swarm_event(
                    "subtask_retrying",
                    {
                        "subtask_id": node.id,
                        "attempt": node.retry_count,
                        "max_retries": self.config.max_retries_per_subtask,
                    },
                )

                # Re-execute as a single-subtask wave
                retry_wave = Wave(index=wave.index, subtask_ids=[node.id])
                retry_result = await self._executor.execute_wave(
                    wave=retry_wave,
                    nodes=nodes,
                    on_subtask_log=self._on_subtask_log,
                )

                if retry_result.all_succeeded:
                    # Fix counters: was counted as failed, now succeeded
                    self.status.failed_subtasks -= 1
                    self.status.completed_subtasks += 1
                    result.results[position] = retry_result.results[0]
                    break

        result.all_succeeded = all(r.success for r in result.results)
        if result.all_succeeded:
            wave.state = SubtaskState.COMPLETED

    def _open_worktrees(self, wave: Wave, nodes: dict[str, SubtaskNode]) -> None:
        """Give each subtask of ``wave`` its worktree, from the task's branch."""
        for subtask_id in wave.subtask_ids:
            node = nodes[subtask_id]
            worktree = subtask_worktree.create(
                self.project_dir, self.spec_dir, subtask_id
            )
            self._worktrees[subtask_id] = worktree
            node.worktree_path = worktree.path

    def _merge_wave(self, wave: Wave, result: WaveResult) -> None:
        """Merge the finished subtasks of ``wave`` into the task, in plan order.

        A subtask whose merge conflicts is counted as failed and stays pending
        in the task's plan; its worktree goes with the others.
        """
        self.status.phase = SwarmPhase.MERGING_WAVE
        emit_swarm_event(
            "phase_changed", {"phase": "merging_wave", "wave_index": wave.index}
        )
        succeeded = {r.subtask_id for r in result.results if r.success}
        merged: list[str] = []
        conflicted: list[str] = []
        for subtask_id in wave.subtask_ids:
            worktree = self._worktrees.get(subtask_id)
            if worktree is None or subtask_id not in succeeded:
                continue
            if subtask_worktree.finished(worktree) and subtask_worktree.merge(
                self.project_dir, self.spec_dir, worktree
            ):
                merged.append(subtask_id)
            else:
                conflicted.append(subtask_id)
                self.status.completed_subtasks -= 1
                self.status.failed_subtasks += 1
        for subtask_id in wave.subtask_ids:
            self._close_worktree(subtask_id)
        wave.merge_success = not conflicted
        emit_swarm_event(
            "wave_merged",
            {
                "wave_index": wave.index,
                "success": not conflicted,
                "merged": merged,
                "conflicted": conflicted,
            },
        )

    def _close_worktree(self, subtask_id: str) -> None:
        worktree = self._worktrees.pop(subtask_id, None)
        if worktree is not None:
            subtask_worktree.remove(self.project_dir, worktree.path, worktree.branch)

    def _close_worktrees(self) -> None:
        """Remove the worktrees a stopped swarm left (fail fast, an error)."""
        for subtask_id in list(self._worktrees):
            self._close_worktree(subtask_id)

    # ── Callbacks ────────────────────────────────────────────────────

    def _on_subtask_started(self, subtask_id: str) -> None:
        self.status.running_subtasks += 1
        logger.info("Subtask started: %s", subtask_id)

    def _on_subtask_completed(self, subtask_id: str, result: Any) -> None:
        self.status.running_subtasks = max(0, self.status.running_subtasks - 1)
        logger.info("Subtask completed: %s", subtask_id)

    def _on_subtask_failed(self, subtask_id: str, error: str | None) -> None:
        self.status.running_subtasks = max(0, self.status.running_subtasks - 1)
        logger.warning("Subtask failed: %s — %s", subtask_id, error)

    def _on_subtask_log(self, subtask_id: str, line: str) -> None:
        """Forward significant log lines."""
        # Only forward phase changes and significant events
        if any(
            marker in line
            for marker in ("__EXEC_PHASE__:", "__TASK_EVENT__:", "ERROR", "WARN")
        ):
            logger.debug("[%s] %s", subtask_id, line[:200])

    async def cancel(self) -> None:
        """Cancel all running subtasks."""
        logger.info("Cancelling swarm execution")
        await self._executor.cancel_all()
        self.status.phase = SwarmPhase.FAILED
        self.status.error = "Cancelled by user"
        self.status.completed_at = time.time()
        emit_swarm_event("swarm_cancelled", {})
