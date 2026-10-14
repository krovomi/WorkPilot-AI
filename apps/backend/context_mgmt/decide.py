"""Which context action to take, and when. Pure functions, table-tested.

Two actions exist on every provider:

* **compact** — keep the thread, replace its history by a summary plus the
  most recent turns. Keeps the working memory of a task still in progress.
  Native on Claude and Codex (the provider summarises itself), emulated
  elsewhere (WorkPilot summarises the conversation log and replays that).
* **clear** — a fresh thread, seeded with a handoff note. Cheapest from then
  on, and the right call when what came before is finished: another subtask,
  another QA pass.

``auto`` picks between them from the situation, the way a person would.
"""

from __future__ import annotations

from dataclasses import dataclass

from .policy import ContextPolicy


@dataclass(frozen=True)
class Situation:
    """Where the session stands when a decision is asked for."""

    # A new subtask (or QA pass) starts with history from a finished one.
    at_task_boundary: bool = False
    # Compactions already applied to the current subtask.
    compactions_in_subtask: int = 0
    # Share of the history made of tool output (0..1), when known.
    tool_output_ratio: float = 0.0
    # The provider rejected the prompt as too long.
    prompt_too_long: bool = False
    # Fill of a thread that replayed nothing, at its first measured turn (0
    # when unknown): a reset brings the next thread back to at least this.
    floor_pct: float = 0.0


def recommended_action(situation: Situation) -> str:
    """What ``auto`` would do in ``situation``: "compact" or "clear"."""
    if situation.prompt_too_long or situation.at_task_boundary:
        return "clear"
    if situation.compactions_in_subtask >= 2:
        # Summaries of summaries lose the thread; start clean with a handoff.
        return "clear"
    if situation.tool_output_ratio >= 0.7:
        # Mostly command output: little reasoning worth keeping verbatim.
        return "clear"
    return "compact"


def action_for_policy(policy: ContextPolicy, situation: Situation) -> str:
    """The action the policy asks for, whatever the fill. Pure."""
    if policy.mode in ("compact", "clear"):
        # A prompt that no longer fits cannot be compacted in place.
        return "clear" if situation.prompt_too_long else policy.mode
    return recommended_action(situation)


@dataclass(frozen=True)
class Decision:
    action: str  # "compact" | "clear"
    trigger: str  # "auto" | "manual"
    reason: str


def decide(
    percent: float,
    policy: ContextPolicy,
    situation: Situation,
    *,
    handoff_ready: bool,
    native_compact: bool,
    manual: str | None = None,
) -> Decision | None:
    """Whether to act now, at a safe point, and how. Pure.

    * A manual request always acts, at the next safe point.
    * ``off`` never acts on its own.
    * Under the soft threshold nothing happens.
    * Past it, the action waits for the background handoff unless the hard
      threshold is reached too — the handoff then is the deterministic one.
    * Compaction on a provider that compacts natively is left to it below the
      hard threshold: the provider does it in place, without a restart.
    * A thread whose floor is already past the threshold would come back past
      it after a reset, to be cut again at its first safe point: it is cut at
      the hard threshold only, and only if that leaves it room to work.
    """
    if manual in ("compact", "clear"):
        return Decision(manual, "manual", "requested from the task panel")
    if situation.prompt_too_long and policy.enabled:
        return Decision("clear", "auto", "prompt too long for the context window")
    if not policy.enabled or percent < policy.threshold_pct:
        return None
    if situation.floor_pct >= policy.threshold_pct and (
        percent < policy.hard_threshold_pct
        or situation.floor_pct >= policy.hard_threshold_pct
    ):
        return None
    action = action_for_policy(policy, situation)
    if action == "compact" and native_compact and percent < policy.hard_threshold_pct:
        # Left to the provider — unless it let the window reach the hard
        # threshold anyway, in which case WorkPilot compacts itself.
        return None
    if (
        not handoff_ready
        and policy.prepare_handoff
        and percent < policy.hard_threshold_pct
    ):
        return None
    reason = f"context at {percent:.0f}% (threshold {policy.threshold_pct}%)"
    return Decision(action, "auto", reason)


def should_prepare_handoff(percent: float, policy: ContextPolicy) -> bool:
    """Whether to start the background handoff now. Pure."""
    return policy.enabled and policy.prepare_handoff and percent >= policy.threshold_pct
