""".NET migrations (8 → 9 → 10 → 11) and C# 15 for the projects WorkPilot builds.

The `migrate-dotnet8-to-dotnet9`, `migrate-dotnet9-to-dotnet10` and
`migrate-dotnet10-to-dotnet11` skills (`skills/dotnet/`) reach a task in three
places, each narrow on purpose:

| Where | What |
|---|---|
| `preflight.run_preflight` | before planning: decides which hops the task needs and copies their skills under ``<spec_dir>/dotnet-upgrade/`` |
| `prompt.dotnet_section` | the planner, every coding subtask, QA and the workflow phases: a short pointer to the staged files, "" otherwise |
| the Kanban palette | the commands themselves, each listed only for a project on its source or target release (`slash_commands.api`) |

See docs/architecture/dotnet-upgrade.md.
"""

from .detect import (
    project_areas,
    project_dotnet_version,
    requested_target,
    task_asks_for_dotnet11,
)
from .preflight import HOPS, SKILL_NAME, PreflightResult, read_result, run_preflight
from .prompt import dotnet_section

__all__ = [
    "HOPS",
    "SKILL_NAME",
    "PreflightResult",
    "dotnet_section",
    "project_areas",
    "project_dotnet_version",
    "read_result",
    "requested_target",
    "run_preflight",
    "task_asks_for_dotnet11",
]
