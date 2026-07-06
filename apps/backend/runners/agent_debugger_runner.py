"""
Agent Debugger Runner
=====================

Thin JSON-over-stdout wrapper around the **persistent** debugger store
(:mod:`agents.debugger_store`) so the Electron main process can attach, list
breakpoints, resume frames, etc.

Each IPC call spawns this runner as a one-shot process, so the debugger state
must live on disk (not in process memory) to survive between calls — see
``agents/debugger_store.py`` for the rationale.

Protocol (one line JSON responses)::

    python agent_debugger_runner.py --action <name> [--session-id <id>] [--payload JSON]

Actions:
  - ``attach``        create/get a session, returns {session_id, ok}
  - ``detach``        remove a session
  - ``list_bp``       list breakpoints
  - ``add_bp``        payload: {id, tool, path_pattern?, content_pattern?,
                               command_pattern?} → adds a breakpoint
  - ``remove_bp``     payload: {id}
  - ``list_frames``   list paused frames awaiting resume
  - ``resume``        payload: {frame_id, action, tool_input?, reason?}
  - ``list_sessions`` list all persisted sessions (no session-id required)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from agents import debugger_store  # noqa: E402


def _emit(payload: object) -> None:
    print(json.dumps(payload, default=str), flush=True)


def _action_attach(session_id: str, _payload: dict) -> dict:
    summary = debugger_store.attach(session_id)
    return {"session_id": session_id, "ok": True, **summary}


def _action_detach(session_id: str, _payload: dict) -> dict:
    ok = debugger_store.detach(session_id)
    return {"session_id": session_id, "ok": ok}


def _action_list_bp(session_id: str, _payload: dict) -> dict:
    return {"breakpoints": debugger_store.list_breakpoints(session_id)}


def _action_add_bp(session_id: str, payload: dict) -> dict:
    bp_id = debugger_store.add_breakpoint(session_id, payload)
    return {"ok": True, "breakpoint_id": bp_id}


def _action_remove_bp(session_id: str, payload: dict) -> dict:
    ok = debugger_store.remove_breakpoint(session_id, str(payload.get("id") or ""))
    return {"ok": ok}


def _action_list_frames(session_id: str, _payload: dict) -> dict:
    return {"frames": debugger_store.list_frames(session_id)}


def _action_resume(session_id: str, payload: dict) -> dict:
    frame_id = str(payload.get("frame_id") or "")
    decision = {
        "action": payload.get("action", "continue"),
        "tool_input": payload.get("tool_input"),
        "reason": payload.get("reason"),
    }
    ok = debugger_store.resume(session_id, frame_id, decision)
    return {"ok": ok, "reason": "unknown_frame" if not ok else None}


def _action_list_sessions(_session_id: str, _payload: dict) -> dict:
    return {"sessions": debugger_store.list_sessions()}


_ACTIONS = {
    "attach": _action_attach,
    "detach": _action_detach,
    "list_bp": _action_list_bp,
    "add_bp": _action_add_bp,
    "remove_bp": _action_remove_bp,
    "list_frames": _action_list_frames,
    "resume": _action_resume,
    "list_sessions": _action_list_sessions,
}

# Actions that operate without a specific session id.
_SESSIONLESS_ACTIONS = {"list_sessions"}


def main() -> None:
    parser = argparse.ArgumentParser(description="Agent Debugger Runner")
    parser.add_argument("--action", required=True, choices=sorted(_ACTIONS))
    parser.add_argument("--session-id", default="")
    parser.add_argument("--payload", default="{}")
    args = parser.parse_args()

    if not args.session_id and args.action not in _SESSIONLESS_ACTIONS:
        _emit({"error": f"--session-id is required for action '{args.action}'"})
        sys.exit(1)

    try:
        payload = json.loads(args.payload) if args.payload else {}
    except json.JSONDecodeError as exc:
        _emit({"error": f"invalid payload JSON: {exc}"})
        sys.exit(1)

    handler = _ACTIONS[args.action]
    try:
        result = handler(args.session_id, payload)
        _emit(result)
    except Exception as exc:  # noqa: BLE001
        _emit({"error": str(exc)})
        sys.exit(1)


if __name__ == "__main__":
    main()
