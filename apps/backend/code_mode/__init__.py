"""Code mode for every provider of the WorkPilot loop: the ``run_script`` tool.

Instead of one model turn per tool call, the model writes a short JavaScript
script that chains the calls (in parallel where they are independent) and
returns only what it needs. Claude Code has this natively (its ``REPL`` tool);
this package gives it to the providers whose tools WorkPilot executes itself:
OpenAI, Google, Mistral, Copilot, Windsurf, the compatible and local providers,
the gateways.

- ``settings``: whether a session is offered the tool (Settings switch, then
  the task's and the phase's choice); ``off`` by default.
- ``runner``: one call, run by Node in a context with no way out but the
  session's executor, so every inner call passes the checks of an ordinary one.
- ``protocol``: the record of a script's calls, read by the safety watch.
- ``tool``: the definition the model is offered.

Design: ``docs/architecture/code-mode.md``.
"""

from .protocol import MARKER, InnerCall, inner_calls, trailer
from .settings import ENV_VAR, effective_mode, offered, switch
from .tool import TOOL_NAME, tool_definition

__all__ = [
    "ENV_VAR",
    "MARKER",
    "TOOL_NAME",
    "InnerCall",
    "effective_mode",
    "inner_calls",
    "offered",
    "switch",
    "tool_definition",
    "trailer",
]
