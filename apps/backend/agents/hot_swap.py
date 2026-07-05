"""
Hot LLM swap — change provider / model / thinking-effort DURING a running phase.

Design (see also the frontend TASK_HOT_SWAP handler):
  - The frontend writes a small marker file ``HOT_SWAP.json`` in the spec dir when
    the user changes a phase's provider/model/effort dropdown **while the task is
    running**. It also persists the change to ``task_metadata.json`` as usual.
  - The running agent picks the marker up at a **safe boundary** and rebuilds its
    client with the new settings, replaying the conversation log so the new model
    keeps the context the previous one accumulated:
      * Multi-turn phases (coding, qa iterations): consumed at the top of each
        loop iteration → applied on the next sub-task/iteration ("next turn").
      * Single-session phases (planning): the session loop breaks mid-stream on
        detecting the marker and the caller re-invokes with the new client.

Everything here is guarded: when no marker exists, callers observe exactly the
previous behaviour (this module never raises into the agent loop).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

HOT_SWAP_FILE = "HOT_SWAP.json"

# Config-phase keys as used in task_metadata.json (phaseModels / phaseProviders /
# phaseThinking). The execution phases that can hot-swap map 1:1 onto these.
_VALID_PHASES = {"spec", "planning", "coding", "qa"}
_VALID_EFFORTS = {"none", "low", "medium", "high", "ultrathink"}


@dataclass(frozen=True)
class HotSwapRequest:
    """A pending live change for one phase. Any field may be None (unchanged)."""

    phase: str
    provider: str | None = None
    model: str | None = None
    effort: str | None = None

    def is_empty(self) -> bool:
        return not (self.provider or self.model or self.effort)


def _marker_path(spec_dir: Path) -> Path:
    return Path(spec_dir) / HOT_SWAP_FILE


def write_hot_swap_marker(
    spec_dir: Path,
    phase: str,
    provider: str | None = None,
    model: str | None = None,
    effort: str | None = None,
) -> bool:
    """Persist a hot-swap request. Returns True on success (best-effort)."""
    if phase not in _VALID_PHASES:
        return False
    payload = {
        "phase": phase,
        "provider": (provider or None),
        "model": (model or None),
        "effort": effort if effort in _VALID_EFFORTS else None,
        "requested_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        _marker_path(spec_dir).write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
        return True
    except OSError:
        return False


def read_hot_swap_marker(spec_dir: Path) -> HotSwapRequest | None:
    """Read the marker without removing it (None if absent/invalid)."""
    path = _marker_path(spec_dir)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    phase = data.get("phase")
    if phase not in _VALID_PHASES:
        return None
    effort = data.get("effort")
    req = HotSwapRequest(
        phase=phase,
        provider=(data.get("provider") or None),
        model=(data.get("model") or None),
        effort=effort if effort in _VALID_EFFORTS else None,
    )
    return None if req.is_empty() else req


def clear_hot_swap_marker(spec_dir: Path) -> None:
    """Delete the marker file (best-effort, no-op if absent)."""
    try:
        _marker_path(spec_dir).unlink(missing_ok=True)
    except OSError:
        pass


def consume_hot_swap_marker(spec_dir: Path) -> HotSwapRequest | None:
    """Read and delete the marker (single-shot). None if absent/invalid."""
    req = read_hot_swap_marker(spec_dir)
    clear_hot_swap_marker(spec_dir)
    return req


def consume_hot_swap_for_phase(spec_dir: Path, phase: str) -> HotSwapRequest | None:
    """Return + delete the marker ONLY if it targets ``phase``; otherwise leave
    it in place (a marker for a different phase must survive until that phase
    runs). Prevents one phase from swallowing another phase's pending swap."""
    req = read_hot_swap_marker(spec_dir)
    if req is not None and req.phase == phase:
        clear_hot_swap_marker(spec_dir)
        return req
    return None


def hot_swap_differs(
    req: HotSwapRequest | None,
    current_provider: str | None,
    current_model: str | None,
    current_effort: str | None = None,
) -> bool:
    """True when the request would actually change the active (provider/model/effort).

    A field of None on the request means "leave unchanged" and never counts as a
    difference. Model comparison is loose (substring both ways) so short aliases
    and full ids of the same model don't look like a change.
    """
    if req is None:
        return False
    if req.provider and req.provider != (current_provider or ""):
        return True
    if req.model and current_model:
        a, b = req.model.lower(), str(current_model).lower()
        if a != b and a not in b and b not in a:
            return True
    elif req.model and not current_model:
        return True
    if req.effort and req.effort != (current_effort or ""):
        return True
    return False


# LogPhase value → config-phase key. planning/coding map to themselves; the
# "validation" execution phase is configured under the "qa" key.
_LOG_PHASE_TO_CONFIG = {"validation": "qa"}


def config_phase_for_log_phase(log_phase: str) -> str:
    """Map an execution/log phase name to its task_metadata config key."""
    return _LOG_PHASE_TO_CONFIG.get(log_phase, log_phase)


def should_break_for_hot_swap(
    marker: HotSwapRequest | None,
    log_phase: str,
    current_provider: str | None,
    current_model: str | None,
) -> bool:
    """Whether a running session on ``log_phase`` should stop mid-stream to apply
    ``marker``. True only when the marker targets THIS phase AND it actually
    changes the active provider/model — so a stale or other-phase marker never
    interrupts (which would otherwise loop). Pure; safe to unit-test."""
    if marker is None:
        return False
    if marker.phase != config_phase_for_log_phase(log_phase):
        return False
    return hot_swap_differs(marker, current_provider, current_model)


def apply_hot_swap_to_metadata(spec_dir: Path, req: HotSwapRequest) -> None:
    """Write the request into task_metadata.json for the target phase so the
    existing per-phase resolvers (phase_config.get_phase_*) pick it up when the
    next client is created. Best-effort; never raises.

    Mirrors the frontend's per-phase dropdown persistence: sets phaseModels /
    phaseProviders / phaseThinking for ``req.phase`` and enables the per-phase
    profile so those keys win over any single-model config.
    """
    meta_path = Path(spec_dir) / "task_metadata.json"
    try:
        meta = (
            json.loads(meta_path.read_text(encoding="utf-8"))
            if meta_path.exists()
            else {}
        )
    except (OSError, json.JSONDecodeError, ValueError):
        return
    if not isinstance(meta, dict):
        return

    if req.model:
        models = meta.get("phaseModels")
        if not isinstance(models, dict):
            models = {}
        models[req.phase] = req.model
        meta["phaseModels"] = models
        meta["isAutoProfile"] = True
    if req.provider:
        providers = meta.get("phaseProviders")
        if not isinstance(providers, dict):
            providers = {}
        providers[req.phase] = req.provider
        meta["phaseProviders"] = providers
    if req.effort:
        thinking = meta.get("phaseThinking")
        if not isinstance(thinking, dict):
            thinking = {}
        thinking[req.phase] = req.effort
        meta["phaseThinking"] = thinking

    try:
        meta_path.write_text(
            json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass


def describe_hot_swap(req: HotSwapRequest) -> str:
    """Human-readable one-liner for the activity feed."""
    parts: list[str] = []
    if req.provider:
        parts.append(f"Fournisseur → {req.provider}")
    if req.model:
        parts.append(f"Modèle → {req.model}")
    if req.effort:
        parts.append(f"Effort → {req.effort}")
    return f"🔄 Changement à chaud ({req.phase}) — " + " · ".join(parts)
