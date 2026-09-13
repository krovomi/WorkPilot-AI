"""rtk — the CLI proxy that condenses command output before a model reads it.

Upstream: https://github.com/rtk-ai/rtk (Apache-2.0). rtk runs the command you
asked for and prints a filtered version of its output: same behaviour, same
exit code, a fraction of the bytes. WorkPilot's agents spend most of their
input budget reading the output of commands they ran, so this is wired in at
the two places that output can come from, and nowhere else.

| Module      | Answers                                                       |
|-------------|---------------------------------------------------------------|
| `runtime`   | is there an rtk here, is it new enough, what is missing        |
| `settings`  | has the user turned it on, in the environment or in settings   |
| `rewrite`   | what would rtk run instead — delegated to `rtk rewrite`        |
| `hook`      | the PreToolUse hook every agent Bash call passes through       |
| `prompt`    | the paragraph that stops a model re-running condensed output   |
| `capture`   | WorkPilot's own commands, when their output goes into a prompt |
| `stats`     | what rtk has actually saved, from rtk's own ledger             |
| `api`       | `GET /api/rtk/status`                                          |

Everything is optional and everything fails open. On a machine without rtk,
every entry point answers in a `shutil.which` and the product behaves exactly
as it did before.
"""

from __future__ import annotations

from .capture import Capture, capture_for_model
from .hook import rtk_rewrite_hook
from .prompt import awareness_section
from .rewrite import Rewrite, rewrite_command, unwrap_rtk
from .runtime import Report, doctor, is_usable, reset_cache, rtk_binary, rtk_version
from .settings import (
    apply_project_env,
    is_enabled,
    model_facing_enabled,
    project_env,
)
from .stats import Savings, read_savings

__all__ = [
    "Capture",
    "Report",
    "Rewrite",
    "Savings",
    "apply_project_env",
    "awareness_section",
    "capture_for_model",
    "doctor",
    "is_enabled",
    "is_usable",
    "model_facing_enabled",
    "project_env",
    "read_savings",
    "reset_cache",
    "rewrite_command",
    "rtk_binary",
    "rtk_rewrite_hook",
    "rtk_version",
    "unwrap_rtk",
]
