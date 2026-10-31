"""Foundation: the backend's lowest layer.

Utilities every unit may import because they import nothing of the backend
back: route-input safety (``api_safety``), the platform layer (``platform``),
atomic file writes, the git executable, the phase-event protocol, the vendored
manifest reader and the ``.workpilot/`` layout. Since the plan of 29 October
(A1) also the logging toolbox (``debug``, ``colored_logs``, ``log_redaction``),
a task's base branch (``base_branch``), the build's control signals
(``build_signals``, ``pause_state``), the forge parser (``git_provider``), the
utility model settings (``model_config``) and the per-LLM log slug
(``llm_slug``): each used to tie its readers to ``core`` and to the agents'
import cycle.

``core`` used to hold them, and ``core`` is also the composition root that
imports ``agents``, ``security`` and a dozen more. A unit that only wanted
``safe_error`` therefore sat in the same import cycle as the agents (audit of
17 October, lot M10). Keep it that way round: nothing here imports ``core`` or
any other unit, which ``tests/test_import_contracts.py`` checks.
"""
