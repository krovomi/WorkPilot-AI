""".NET 11 and C# 15 for the projects WorkPilot builds.

The `migrate-dotnet10-to-dotnet11` skill (`skills/dotnet/`) reaches a task in
three places, each narrow on purpose:

| Where | What |
|---|---|
| `preflight.run_preflight` | before planning: decides whether the task needs the skill and copies it under ``<spec_dir>/dotnet11/`` |
| `prompt.dotnet_section` | the planner, every coding subtask, QA and the workflow phases: a short pointer to the staged files, "" otherwise |
| the Kanban palette | the command itself, listed only for a project on .NET 10 or 11 (`slash_commands.api`) |

See docs/architecture/dotnet-upgrade.md.
"""

from .detect import project_areas, project_dotnet_version, task_asks_for_dotnet11
from .preflight import SKILL_NAME, PreflightResult, read_result, run_preflight
from .prompt import dotnet_section

__all__ = [
    "SKILL_NAME",
    "PreflightResult",
    "dotnet_section",
    "project_areas",
    "project_dotnet_version",
    "read_result",
    "run_preflight",
    "task_asks_for_dotnet11",
]
