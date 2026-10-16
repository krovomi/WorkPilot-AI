"""The environments a RUN task may act on, declared by the project.

`<project>/.workpilot/environments.toml`:

    [environments.staging]
    description = "the staging stack"
    health = ["curl -fsS https://staging.example.test/healthz"]
    variables = ["STAGING_DB_URL", "STAGING_API_TOKEN"]

A declaration names what a procedure may target, the commands that say it
is up, and the **names** of the variables its commands read. Never their
values: a value lives in the operator's environment (or the project's `.env`
vault) and reaches the command's process as that variable only; it is not
read, printed or journaled here (rule S1). A procedure that names an
environment the project has not declared cannot run — not "runs in the
worktree instead": the operator who wrote `Environnement : production`
meant production, and silently playing the steps elsewhere would be a
different operation.

Without the file, a RUN only ever runs in the task's worktree.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import tomllib

__all__ = ["Environment", "EnvironmentsError", "load_environments", "environment_for"]

ENVIRONMENTS_FILE = Path(".workpilot") / "environments.toml"


class EnvironmentsError(Exception):
    """The declaration is unusable, or names something the project did not."""


@dataclass(frozen=True)
class Environment:
    name: str
    description: str = ""
    health: tuple[str, ...] = ()
    variables: tuple[str, ...] = ()

    def missing_variables(self) -> list[str]:
        """The declared variable names absent from this process's environment."""
        return [v for v in self.variables if not os.environ.get(v)]

    def process_env(self, base: dict[str, str] | None = None) -> dict[str, str]:
        """What a step's process inherits: ``base`` plus the named variables.

        Values are copied from this process's environment into the child's,
        never into a return value a caller would print: the dict is handed to
        the subprocess and nothing else.
        """
        env = dict(os.environ if base is None else base)
        for name in self.variables:
            value = os.environ.get(name)
            if value:
                env[name] = value
        return env


def load_environments(project_dir: Path) -> dict[str, Environment]:
    """Every environment the project declares; ``{}`` without the file."""
    path = Path(project_dir) / ENVIRONMENTS_FILE
    if not path.is_file():
        return {}
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise EnvironmentsError(f"{path}: {exc}") from exc
    raw = data.get("environments")
    if not isinstance(raw, dict):
        raise EnvironmentsError(f"{path}: expected an [environments.<name>] table")
    out: dict[str, Environment] = {}
    for name, entry in raw.items():
        if not isinstance(entry, dict):
            raise EnvironmentsError(f"{path}: environments.{name} must be a table")
        health = entry.get("health", [])
        variables = entry.get("variables", [])
        for key, value in (("health", health), ("variables", variables)):
            if not isinstance(value, list) or not all(
                isinstance(v, str) for v in value
            ):
                raise EnvironmentsError(
                    f"{path}: environments.{name}.{key} must be a list of strings"
                )
        for var in variables:
            if not var.isidentifier():
                raise EnvironmentsError(
                    f"{path}: environments.{name}.variables names {var!r}, which is "
                    "not a variable name — the file names variables, never values"
                )
        out[str(name)] = Environment(
            name=str(name),
            description=str(entry.get("description", "")),
            health=tuple(health),
            variables=tuple(variables),
        )
    return out


def environment_for(project_dir: Path, name: str) -> Environment | None:
    """The declared environment ``name`` names, or ``None`` for the worktree.

    Raises `EnvironmentsError` for a name the project did not declare.
    """
    from .runbook import WORKTREE_ONLY

    if name == WORKTREE_ONLY:
        return None
    declared = load_environments(project_dir)
    if name not in declared:
        known = ", ".join(sorted(declared)) or "none"
        raise EnvironmentsError(
            f"environment {name!r} is not declared in {ENVIRONMENTS_FILE} "
            f"(declared: {known}); a RUN runs only where the project says it may"
        )
    return declared[name]
