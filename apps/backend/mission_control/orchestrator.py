"""
Mission Control Orchestrator — Central hub for multi-agent management.

Manages multiple AgentSlots, coordinates their execution,
broadcasts state changes via WebSocket, and provides the API
surface for the frontend Mission Control dashboard.
"""

import logging
import time
import uuid
from typing import Any

from . import metrics
from .agent_slot import AgentRole, AgentSlot, AgentStatus
from .decision_tree import DecisionTree
from .model_pick import normalise_provider
from .rebalance import detect_loop, plan_rebalance, reason_of
from .session_plan import SessionPlan, session_entry

logger = logging.getLogger(__name__)


class MissionControlOrchestrator:
    """
    Central orchestrator for Mission Control.

    Manages a pool of agent slots, tracks their state, and broadcasts
    updates to connected frontend clients via WebSocket events.
    """

    def __init__(self):
        self._slots: dict[str, AgentSlot] = {}
        self._decision_trees: dict[str, DecisionTree] = {}
        self._session_id: str = f"mc-{uuid.uuid4().hex[:8]}"
        self._created_at: float = time.time()
        self._is_active: bool = False
        self._event_log: list[dict[str, Any]] = []
        self._plan = SessionPlan()
        self._rebalances = 0
        self._recorded = False

    # ---------------------------------------------------------------
    # Session lifecycle
    # ---------------------------------------------------------------

    def start_session(self) -> dict[str, Any]:
        """Start a new Mission Control session."""
        if self._is_active:
            self._record()
        self._plan = SessionPlan()
        self._rebalances = 0
        self._recorded = False
        self._is_active = True
        self._created_at = time.time()
        self._session_id = f"mc-{uuid.uuid4().hex[:8]}"
        self._event_log = []
        logger.info(f"Mission Control session started: {self._session_id}")
        return self.get_session_info()

    def stop_session(self):
        """Stop the current session and reset all agents."""
        self._is_active = False
        for slot in self._slots.values():
            if slot.status == AgentStatus.RUNNING:
                slot.complete()
        self._record()
        logger.info(f"Mission Control session stopped: {self._session_id}")

    def _record(self) -> None:
        """Leave the session's line in the metrics ledger, once."""
        if self._recorded:
            return
        self._recorded = True
        entry = session_entry(list(self._slots.values()), self._plan, self._rebalances)
        if entry is not None:
            metrics.record_session(entry)

    def _totals(self) -> tuple[int, float]:
        slots = self._slots.values()
        tokens = sum(s.tokens.total_tokens for s in slots)
        return tokens, sum(s.tokens.estimated_cost_usd for s in slots)

    def over_budget(self) -> bool:
        return self._plan.over_budget(*self._totals())

    def set_plan(
        self,
        *,
        providers: list[str] | None = None,
        budget_usd: float | None = None,
        budget_tokens: int | None = None,
        auto_rebalance: bool | None = None,
    ) -> dict[str, Any]:
        """A crew's providers and budget (both replaced), or the rebalancing switch."""
        if providers is not None:
            order: list[str] = []
            for raw in providers:
                name = normalise_provider(raw)
                if name and name not in order:
                    order.append(name)
            self._plan.providers = order
            self._plan.budget_usd = budget_usd
            self._plan.budget_tokens = budget_tokens
        if auto_rebalance is not None:
            self._plan.auto_rebalance = auto_rebalance
        return self._plan.to_dict()

    def get_session_info(self) -> dict[str, Any]:
        """Get current session information."""
        tokens, cost = self._totals()
        return {
            "session_id": self._session_id,
            "is_active": self._is_active,
            "created_at": self._created_at,
            "agent_count": len(self._slots),
            "running_count": sum(
                1 for s in self._slots.values() if s.status == AgentStatus.RUNNING
            ),
            "total_tokens": tokens,
            "total_cost_usd": round(cost, 6),
            "elapsed_seconds": round(time.time() - self._created_at, 1),
            "plan": self._plan.to_dict(),
            "over_budget": self._plan.over_budget(tokens, cost),
            "rebalance_count": self._rebalances,
        }

    # ---------------------------------------------------------------
    # Agent slot management
    # ---------------------------------------------------------------

    def create_agent(
        self,
        name: str,
        role: str = "custom",
        provider: str = "",
        model: str = "",
        model_label: str = "",
        origin: str = "manual",
        estimated_tokens: int = 0,
    ) -> AgentSlot:
        """Create a new agent slot; ``origin`` ``auto`` for a composed crew's."""
        try:
            agent_role = AgentRole(role)
        except ValueError:
            agent_role = AgentRole.CUSTOM

        slot = AgentSlot(
            name=name,
            role=agent_role,
            provider=provider,
            model=model,
            model_label=model_label or model,
            origin="auto" if origin == "auto" else "manual",
            estimated_tokens=max(0, estimated_tokens),
        )
        self._slots[slot.id] = slot
        self._decision_trees[slot.id] = DecisionTree(slot.id)

        self._log_event(
            "agent_created",
            {
                "agent_id": slot.id,
                "name": name,
                "role": role,
                "provider": provider,
                "model": model,
            },
        )
        logger.info(f"Agent created: {slot.id} ({name}, {role}, {provider}:{model})")
        return slot

    def remove_agent(self, agent_id: str) -> bool:
        """Remove an agent slot."""
        if agent_id not in self._slots:
            return False
        slot = self._slots[agent_id]
        if slot.status == AgentStatus.RUNNING:
            slot.fail("Removed while running")
        del self._slots[agent_id]
        self._decision_trees.pop(agent_id, None)
        self._log_event("agent_removed", {"agent_id": agent_id})
        return True

    def get_agent(self, agent_id: str) -> AgentSlot | None:
        """Get a specific agent slot."""
        return self._slots.get(agent_id)

    def get_all_agents(self) -> list[dict[str, Any]]:
        """Get all agent slots as dicts."""
        return [slot.to_dict() for slot in self._slots.values()]

    def update_agent_config(
        self,
        agent_id: str,
        provider: str | None = None,
        model: str | None = None,
        model_label: str | None = None,
        name: str | None = None,
        role: str | None = None,
    ) -> AgentSlot | None:
        """Update agent configuration (provider, model, name, role)."""
        slot = self._slots.get(agent_id)
        if not slot:
            return None

        if provider is not None:
            slot.provider = provider
        if model is not None:
            slot.model = model
        if model_label is not None:
            slot.model_label = model_label
        if name is not None:
            slot.name = name
        if role is not None:
            try:
                slot.role = AgentRole(role)
            except ValueError:
                pass

        self._log_event(
            "agent_config_updated",
            {
                "agent_id": agent_id,
                "provider": slot.provider,
                "model": slot.model,
            },
        )
        return slot

    # ---------------------------------------------------------------
    # Agent control (pause / resume / start / stop)
    # ---------------------------------------------------------------

    def start_agent(
        self, agent_id: str, task: str = "", *, rebalanced: bool = False
    ) -> bool:
        """Mark an agent running on ``task``; a restart without one reuses the last.

        ``rebalanced``: the same work again after ``rebalance_agent``; the tree
        goes on, and the rebalancings of this task still count.

        This only records the state. The model call itself runs in the Electron
        main process (``main/mission-control/``), which has the user's provider
        credentials, and reports back through ``/agents/{id}/update``.
        """
        slot = self._slots.get(agent_id)
        if not slot:
            return False
        task = task or slot.current_task
        if not rebalanced:
            slot.rebalances = 0
            slot.tried_providers = []
        slot.start(task)
        tree = self._decision_trees.get(agent_id)
        if tree and not rebalanced:
            tree.create_root(f"Task: {task[:80]}" if task else "Start")
        self._log_event(
            "agent_started",
            {
                "agent_id": agent_id,
                "task": task,
            },
        )
        return True

    def pause_agent(self, agent_id: str) -> bool:
        """Pause a running agent."""
        slot = self._slots.get(agent_id)
        if not slot:
            return False
        before = slot.status
        slot.pause()
        if slot.status != before:
            self._log_event("agent_paused", {"agent_id": agent_id})
        return True

    def resume_agent(self, agent_id: str) -> bool:
        """Resume a paused agent."""
        slot = self._slots.get(agent_id)
        if not slot:
            return False
        before = slot.status
        slot.resume()
        if slot.status != before:
            self._log_event("agent_resumed", {"agent_id": agent_id})
        return True

    def stop_agent(self, agent_id: str) -> bool:
        """Stop an agent (mark as completed)."""
        slot = self._slots.get(agent_id)
        if not slot:
            return False
        slot.complete()
        self._log_event("agent_stopped", {"agent_id": agent_id})
        return True

    # ---------------------------------------------------------------
    # Live state updates (called from agent processes)
    # ---------------------------------------------------------------

    def update_agent_thinking(self, agent_id: str, thinking: str):
        """Update agent's current thinking/reasoning."""
        slot = self._slots.get(agent_id)
        if not slot:
            return
        slot.current_thinking = thinking[:500]
        tree = self._decision_trees.get(agent_id)
        if tree:
            tree.add_thinking(thinking)

    def update_agent_tool_call(
        self,
        agent_id: str,
        tool_name: str,
        tool_input: str = "",
    ):
        """Record a tool call from the agent."""
        slot = self._slots.get(agent_id)
        if not slot:
            return
        slot.last_tool_call = tool_name
        slot.last_tool_input = tool_input[:300]
        tree = self._decision_trees.get(agent_id)
        if tree:
            tree.add_tool_call(tool_name, tool_input)

    def update_agent_file(self, agent_id: str, file_path: str):
        """Track file changes by the agent."""
        slot = self._slots.get(agent_id)
        if not slot:
            return
        if file_path not in slot.active_files:
            slot.active_files.append(file_path)
            # Keep last 20 files
            if len(slot.active_files) > 20:
                slot.active_files = slot.active_files[-20:]

    def update_agent_tokens(
        self,
        agent_id: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cost_usd: float = 0.0,
    ):
        """Update token consumption for an agent."""
        slot = self._slots.get(agent_id)
        if not slot:
            return
        slot.tokens.add(input_tokens, output_tokens, cost_usd)

    def update_agent_progress(
        self,
        agent_id: str,
        progress: float,
        current_step: str = "",
    ):
        """Update agent progress (0.0 to 1.0)."""
        slot = self._slots.get(agent_id)
        if not slot:
            return
        slot.progress = max(0.0, min(1.0, progress))
        if current_step:
            slot.current_step = current_step

    def update_agent_output(self, agent_id: str, text: str):
        """Append a chunk of the agent's answer, while it is still running."""
        slot = self._slots.get(agent_id)
        if not slot or slot.status != AgentStatus.RUNNING:
            return
        slot.append_output(text)
        if not slot.loop_detected and detect_loop(slot.output):
            # The main process reads it in its next update and stops the run.
            slot.loop_detected = True
            self._log_event("agent_loop_detected", {"agent_id": agent_id})

    def rebalance_agent(
        self,
        agent_id: str,
        *,
        error: str = "",
        rate_limited: bool = False,
        alternate_profile: bool = False,
    ) -> dict[str, str] | None:
        """Decide what to do with a run that went wrong, and apply it to the slot.

        The main process calls it before reporting the failure; on an action
        other than ``none`` it starts the same task again on the new model.
        """
        slot = self._slots.get(agent_id)
        if not slot:
            return None
        reason = reason_of(error, rate_limited=rate_limited, loop=slot.loop_detected)
        if not self._plan.auto_rebalance:
            decision = {"action": "none", "reason": reason, "skipped": "disabled"}
        else:
            decision = plan_rebalance(
                role=slot.role.value,
                provider=slot.provider,
                model=slot.model,
                reason=reason,
                providers=self._plan.fallback_providers(self._slots.values()),
                tried=set(slot.tried_providers),
                count=slot.rebalances,
                over_budget=self.over_budget(),
                alternate_profile=alternate_profile,
            ).to_dict()
        if decision["action"] == "none":
            self._log_event(
                "agent_rebalance_skipped",
                {
                    "agent_id": agent_id,
                    "reason": reason,
                    "skipped": decision["skipped"],
                },
            )
            return decision
        before = slot.model_label or slot.model or slot.provider
        current = normalise_provider(slot.provider)
        if decision["provider"] != current and current not in slot.tried_providers:
            slot.tried_providers.append(current)
        slot.provider = decision["provider"]
        slot.model = decision["model"]
        slot.model_label = decision["model_label"]
        slot.rebalances += 1
        self._rebalances += 1
        after = slot.model_label or slot.model or slot.provider
        # A slot and its tree are created and removed together.
        self._decision_trees[agent_id].add_result(
            "Rebalanced", f"{reason}: {before} -> {after}", success=False
        )
        self._log_event(
            "agent_rebalanced",
            {
                "agent_id": agent_id,
                "reason": reason,
                "action": decision["action"],
                "from": before,
                "to": after,
                "provider": slot.provider,
            },
        )
        return decision

    def update_agent_status(self, agent_id: str, status: str, error: str = ""):
        """Update agent status; an end of run stops its clock and closes its tree."""
        slot = self._slots.get(agent_id)
        if not slot:
            return
        try:
            new_status = AgentStatus(status)
        except ValueError:
            return
        if new_status in (AgentStatus.COMPLETED, AgentStatus.ERROR):
            self._finish_agent(slot, new_status, error)
            return
        slot.status = new_status
        if error:
            slot.error_message = error

    def _finish_agent(self, slot: AgentSlot, status: AgentStatus, error: str):
        """Record the end of a run once; a stopped agent is not reopened by it."""
        if slot.status != AgentStatus.RUNNING:
            return
        tree = self._decision_trees.get(slot.id)
        if status == AgentStatus.COMPLETED:
            slot.complete()
            if tree:
                tree.add_result("Answer", slot.output, success=True)
            self._log_event("agent_completed", {"agent_id": slot.id})
            return
        slot.fail(error)
        if tree:
            tree.add_result("Error", error, success=False)
        self._log_event("agent_failed", {"agent_id": slot.id, "error": error[:300]})

    # ---------------------------------------------------------------
    # Decision tree access
    # ---------------------------------------------------------------

    def get_decision_tree(self, agent_id: str) -> dict[str, Any] | None:
        """Get the decision tree for a specific agent."""
        tree = self._decision_trees.get(agent_id)
        if not tree:
            return None
        return tree.to_dict()

    def get_decision_path(self, agent_id: str) -> list[dict[str, Any]]:
        """Get the flat decision path for a specific agent."""
        tree = self._decision_trees.get(agent_id)
        if not tree:
            return []
        return tree.get_flat_path()

    # ---------------------------------------------------------------
    # Full state snapshot
    # ---------------------------------------------------------------

    def get_full_state(self) -> dict[str, Any]:
        """Get the complete Mission Control state for the frontend."""
        return {
            "session": self.get_session_info(),
            "agents": self.get_all_agents(),
            "decision_trees": {
                aid: tree.to_dict() for aid, tree in self._decision_trees.items()
            },
            "recent_events": self._event_log[-50:],
        }

    # ---------------------------------------------------------------
    # Event logging
    # ---------------------------------------------------------------

    def _log_event(self, event_type: str, data: dict[str, Any]):
        """Log an internal event."""
        event = {
            "type": event_type,
            "timestamp": time.time(),
            "data": data,
        }
        self._event_log.append(event)
        # Keep last 200 events
        if len(self._event_log) > 200:
            self._event_log = self._event_log[-200:]

    def get_event_log(self, limit: int = 50) -> list[dict[str, Any]]:
        """The ``limit`` most recent events (none for 0 or less)."""
        if limit <= 0:
            return []
        return self._event_log[-limit:]


# ---------------------------------------------------------------------------
# Singleton access
# ---------------------------------------------------------------------------

_mission_control: MissionControlOrchestrator | None = None


def get_mission_control() -> MissionControlOrchestrator:
    """Get or create the global Mission Control orchestrator."""
    global _mission_control
    if _mission_control is None:
        _mission_control = MissionControlOrchestrator()
    return _mission_control
