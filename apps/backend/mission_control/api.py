"""
Mission Control API — FastAPI routes for the Mission Control dashboard.

Provides REST endpoints for:
- Session management (start/stop)
- Agent CRUD (create/remove/update)
- Agent control (start/pause/resume/stop)
- State queries (full state, individual agent, decision tree)
- Live event updates (for agent processes to report state)
"""

import logging
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, HTTPException
from foundation.api_safety import SpecAddressError, resolve_spec_dir, validated_dir
from pydantic import BaseModel, Field

from . import metrics
from .composition import CompositionError, suggest_composition
from .orchestrator import get_mission_control
from .refine import parse_hints
from .session_plan import MAX_PLAN_PROVIDERS
from .signals import read_signals, read_spec_text
from .templates import TEMPLATES

logger = logging.getLogger(__name__)

# Constants
AGENT_NOT_FOUND = "Agent not found"

router = APIRouter(prefix="/api/mission-control", tags=["mission-control"])


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class CreateAgentRequest(BaseModel):
    name: str
    role: str = "custom"
    provider: str = ""
    model: str = ""
    model_label: str = ""
    # A composed crew's agent: ``auto``, with the tokens its composition expected.
    origin: str = Field(default="manual", pattern="^(manual|auto)$")
    estimated_tokens: int = Field(default=0, ge=0, le=10_000_000_000)


class UpdateAgentConfigRequest(BaseModel):
    provider: str | None = None
    model: str | None = None
    model_label: str | None = None
    name: str | None = None
    role: str | None = None


class StartAgentRequest(BaseModel):
    task: str = ""
    # The same task again after a rebalancing (``/rebalance``).
    rebalanced: bool = False


class RebalanceRequest(BaseModel):
    """How a run ended; the error is classified, never acted on."""

    error: str = Field(default="", max_length=2_000)
    rate_limited: bool = False
    # The Claude profile system has another profile to run on.
    alternate_profile: bool = False


class SessionPlanRequest(BaseModel):
    """A crew's providers and budget, or the automatic rebalancing switch."""

    providers: list[Annotated[str, Field(max_length=64)]] | None = Field(
        default=None, max_length=MAX_PLAN_PROVIDERS
    )
    budget_usd: float | None = Field(default=None, gt=0, le=1_000_000)
    budget_tokens: int | None = Field(default=None, gt=0, le=10_000_000_000)
    auto_rebalance: bool | None = None


class AgentStateUpdateRequest(BaseModel):
    """Used by agent processes to push live state updates."""

    thinking: str | None = None
    tool_name: str | None = None
    tool_input: str | None = None
    file_path: str | None = None
    file_operation: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    progress: float | None = None
    current_step: str | None = None
    # A chunk of the answer, appended to what the agent already said.
    output_delta: str | None = Field(default=None, max_length=20_000)
    status: str | None = None
    error: str | None = Field(default=None, max_length=2_000)


class StartSessionRequest(BaseModel):
    name: str = "Mission Control"


class CompositionRequest(BaseModel):
    """What a crew is suggested from; the main process resolves the project."""

    prompt: str = Field(default="", max_length=20_000)
    project_dir: str | None = Field(default=None, max_length=4_096)
    spec_id: str | None = Field(default=None, max_length=200)
    template: str | None = Field(default=None, max_length=40)
    providers: list[Annotated[str, Field(max_length=64)]] = Field(
        min_length=1, max_length=8
    )
    budget_usd: float | None = Field(default=None, gt=0, le=1_000_000)
    budget_tokens: int | None = Field(default=None, gt=0, le=10_000_000_000)
    # Ask for the light model's request (``refine.py``); its answer comes back
    # in ``model_hints`` on a second call.
    refine: bool = False
    model_hints: str | None = Field(default=None, max_length=8_000)


# ---------------------------------------------------------------------------
# Session endpoints
# ---------------------------------------------------------------------------


@router.post("/session/start")
async def start_session(req: StartSessionRequest):
    """Start a new Mission Control session."""
    mc = get_mission_control()
    info = mc.start_session()
    return {"success": True, "session": info}


@router.post("/session/stop")
async def stop_session():
    """Stop the current Mission Control session."""
    mc = get_mission_control()
    mc.stop_session()
    return {"success": True}


@router.post("/session/plan")
async def set_session_plan(req: SessionPlanRequest):
    """Where rebalanced agents may go and the budget the session holds to."""
    mc = get_mission_control()
    plan = mc.set_plan(
        providers=req.providers,
        budget_usd=req.budget_usd,
        budget_tokens=req.budget_tokens,
        auto_rebalance=req.auto_rebalance,
    )
    return {"success": True, "plan": plan}


@router.get("/metrics")
async def get_metrics():
    """Auto-compose adoption, tokens, rebalancings and budget overruns."""
    return {"success": True, "metrics": metrics.summary()}


@router.get("/session")
async def get_session():
    """Get current session info."""
    mc = get_mission_control()
    return {"success": True, "session": mc.get_session_info()}


# ---------------------------------------------------------------------------
# Full state
# ---------------------------------------------------------------------------


@router.get("/state")
async def get_full_state():
    """Get the complete Mission Control state (all agents, trees, events)."""
    mc = get_mission_control()
    return {"success": True, "state": mc.get_full_state()}


# ---------------------------------------------------------------------------
# Agent CRUD
# ---------------------------------------------------------------------------


@router.post("/agents")
async def create_agent(req: CreateAgentRequest):
    """Create a new agent slot."""
    mc = get_mission_control()
    slot = mc.create_agent(
        name=req.name,
        role=req.role,
        provider=req.provider,
        model=req.model,
        model_label=req.model_label,
        origin=req.origin,
        estimated_tokens=req.estimated_tokens,
    )
    return {"success": True, "agent": slot.to_dict()}


@router.get("/agents")
async def list_agents():
    """List all agent slots."""
    mc = get_mission_control()
    return {"success": True, "agents": mc.get_all_agents()}


@router.get("/agents/{agent_id}", responses={404: {"description": AGENT_NOT_FOUND}})
async def get_agent(agent_id: str):
    """Get a specific agent slot."""
    mc = get_mission_control()
    slot = mc.get_agent(agent_id)
    if not slot:
        raise HTTPException(status_code=404, detail=AGENT_NOT_FOUND)
    return {"success": True, "agent": slot.to_dict()}


@router.put("/agents/{agent_id}", responses={404: {"description": AGENT_NOT_FOUND}})
async def update_agent(agent_id: str, req: UpdateAgentConfigRequest):
    """Update agent configuration."""
    mc = get_mission_control()
    slot = mc.update_agent_config(
        agent_id,
        provider=req.provider,
        model=req.model,
        model_label=req.model_label,
        name=req.name,
        role=req.role,
    )
    if not slot:
        raise HTTPException(status_code=404, detail=AGENT_NOT_FOUND)
    return {"success": True, "agent": slot.to_dict()}


@router.delete("/agents/{agent_id}", responses={404: {"description": AGENT_NOT_FOUND}})
async def remove_agent(agent_id: str):
    """Remove an agent slot."""
    mc = get_mission_control()
    removed = mc.remove_agent(agent_id)
    if not removed:
        raise HTTPException(status_code=404, detail=AGENT_NOT_FOUND)
    return {"success": True}


# ---------------------------------------------------------------------------
# Agent control
# ---------------------------------------------------------------------------


@router.post(
    "/agents/{agent_id}/start", responses={404: {"description": AGENT_NOT_FOUND}}
)
async def start_agent(agent_id: str, req: StartAgentRequest):
    """Start an agent with a task."""
    mc = get_mission_control()
    ok = mc.start_agent(agent_id, req.task, rebalanced=req.rebalanced)
    if not ok:
        raise HTTPException(status_code=404, detail=AGENT_NOT_FOUND)
    return {"success": True}


@router.post(
    "/agents/{agent_id}/pause", responses={404: {"description": AGENT_NOT_FOUND}}
)
async def pause_agent(agent_id: str):
    """Pause a running agent."""
    mc = get_mission_control()
    ok = mc.pause_agent(agent_id)
    if not ok:
        raise HTTPException(status_code=404, detail=AGENT_NOT_FOUND)
    return {"success": True}


@router.post(
    "/agents/{agent_id}/resume", responses={404: {"description": AGENT_NOT_FOUND}}
)
async def resume_agent(agent_id: str):
    """Resume a paused agent."""
    mc = get_mission_control()
    ok = mc.resume_agent(agent_id)
    if not ok:
        raise HTTPException(status_code=404, detail=AGENT_NOT_FOUND)
    return {"success": True}


@router.post(
    "/agents/{agent_id}/stop", responses={404: {"description": AGENT_NOT_FOUND}}
)
async def stop_agent(agent_id: str):
    """Stop an agent."""
    mc = get_mission_control()
    ok = mc.stop_agent(agent_id)
    if not ok:
        raise HTTPException(status_code=404, detail=AGENT_NOT_FOUND)
    return {"success": True}


# ---------------------------------------------------------------------------
# Live state updates (called by agent processes)
# ---------------------------------------------------------------------------


@router.post(
    "/agents/{agent_id}/update", responses={404: {"description": AGENT_NOT_FOUND}}
)
async def update_agent_state(agent_id: str, req: AgentStateUpdateRequest):
    """Push a live state update from an agent process."""
    mc = get_mission_control()
    slot = mc.get_agent(agent_id)
    if not slot:
        raise HTTPException(status_code=404, detail=AGENT_NOT_FOUND)

    if req.thinking is not None:
        mc.update_agent_thinking(agent_id, req.thinking)
    if req.tool_name is not None:
        mc.update_agent_tool_call(agent_id, req.tool_name, req.tool_input or "")
    if req.file_path is not None:
        mc.update_agent_file(agent_id, req.file_path)
    if req.input_tokens is not None or req.output_tokens is not None:
        mc.update_agent_tokens(
            agent_id,
            input_tokens=req.input_tokens or 0,
            output_tokens=req.output_tokens or 0,
            cost_usd=req.cost_usd or 0.0,
        )
    if req.output_delta:
        mc.update_agent_output(agent_id, req.output_delta)
    if req.progress is not None:
        mc.update_agent_progress(agent_id, req.progress, req.current_step or "")
    if req.status is not None:
        mc.update_agent_status(agent_id, req.status, req.error or "")

    return {"success": True, "agent": slot.to_dict()}


@router.post(
    "/agents/{agent_id}/rebalance", responses={404: {"description": AGENT_NOT_FOUND}}
)
async def rebalance_agent(agent_id: str, req: RebalanceRequest):
    """What to do with a run that went wrong (``rebalance.py``), applied."""
    mc = get_mission_control()
    decision = mc.rebalance_agent(
        agent_id,
        error=req.error,
        rate_limited=req.rate_limited,
        alternate_profile=req.alternate_profile,
    )
    if decision is None:
        raise HTTPException(status_code=404, detail=AGENT_NOT_FOUND)
    slot = mc.get_agent(agent_id)
    return {"success": True, "rebalance": decision, "agent": slot and slot.to_dict()}


# ---------------------------------------------------------------------------
# Decision tree
# ---------------------------------------------------------------------------


@router.get(
    "/agents/{agent_id}/decision-tree",
    responses={404: {"description": AGENT_NOT_FOUND}},
)
async def get_decision_tree(agent_id: str):
    """Get the full decision tree for an agent."""
    mc = get_mission_control()
    tree = mc.get_decision_tree(agent_id)
    if tree is None:
        raise HTTPException(status_code=404, detail=AGENT_NOT_FOUND)
    return {"success": True, "tree": tree}


@router.get(
    "/agents/{agent_id}/decision-path",
    responses={404: {"description": AGENT_NOT_FOUND}},
)
async def get_decision_path(agent_id: str):
    """Get the flat decision path for an agent."""
    mc = get_mission_control()
    if mc.get_agent(agent_id) is None:
        raise HTTPException(status_code=404, detail=AGENT_NOT_FOUND)
    return {"success": True, "path": mc.get_decision_path(agent_id)}


# ---------------------------------------------------------------------------
# Event log
# ---------------------------------------------------------------------------


@router.get("/events")
async def get_events(limit: int = 50):
    """Get recent Mission Control events."""
    mc = get_mission_control()
    events = mc.get_event_log(limit)
    return {"success": True, "events": events}


# ---------------------------------------------------------------------------
# Composition (docs/architecture/mission-control-composition.md)
# ---------------------------------------------------------------------------


def _composition_dirs(req: CompositionRequest) -> tuple[Path | None, Path | None]:
    """The project and spec directories, resolved then checked; or a code."""
    if req.spec_id and not req.project_dir:
        raise CompositionError("invalid_spec")
    if not req.project_dir:
        return None, None
    try:
        project = validated_dir(req.project_dir, "project_dir")
    except ValueError:
        raise CompositionError("invalid_project") from None
    if not req.spec_id:
        return project, None
    try:
        spec = resolve_spec_dir(None, str(project), req.spec_id)
    except SpecAddressError:
        raise CompositionError("invalid_spec") from None
    return project, spec


@router.post("/composition")
async def suggest(req: CompositionRequest):
    """Suggest a crew for a description or a spec, within a budget.

    A refusal the person can act on (an unknown template, no usable provider,
    a spec that is not there) answers ``success: false`` with a code.
    """
    try:
        if req.template and req.template not in TEMPLATES:
            raise CompositionError("unknown_template")
        project, spec = _composition_dirs(req)
        signals = read_signals(req.prompt, project, spec)
        hints = parse_hints(req.model_hints) if req.model_hints else None
        text = "\n\n".join(
            t for t in (req.prompt.strip(), read_spec_text(spec) if spec else "") if t
        )
        composition = suggest_composition(
            signals,
            req.providers,
            template_key=req.template,
            budget_usd=req.budget_usd,
            budget_tokens=req.budget_tokens,
            hints=hints,
            hints_unusable=bool(req.model_hints) and hints is None,
            refine_text=text if req.refine and not req.model_hints else None,
            calibration=metrics.role_factors(),
        )
    except CompositionError as exc:
        return {"success": False, "error": exc.code}
    return {"success": True, "composition": composition}
