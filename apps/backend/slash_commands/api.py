"""Slash-command API.

Exposes the endpoints the Kanban Quick-Command bar reads:

  GET  /api/slash-commands?project_dir=<abs path>
       Returns the merged list of slash commands discovered from:
       - <project_dir>/.agents/skills/*/SKILL.md  (agnostic, primary source)
       - <project_dir>/.claude/commands/*.md       (Claude mirror, fallback)
       - ~/.claude/commands/*.md                   (user-scoped fallback)
       - bundled product skills                   (last fallback)
       Commands already covered by the agnostic source are not duplicated.
       Each entry carries the parsed YAML frontmatter so the UI can render
       a description tooltip without an extra round-trip.

  GET  /api/slash-commands/body?project_dir=<abs path>&command=<name>
       Returns a command's resolved instructions without running them.

Running a command is not a route any more (F181): the Electron main opens a
Kanban review card and runs `runners/slash_command_runner.py` in its worktree
with the app's provider and sign-in (`slash_commands/execution.py`), so what
the agent writes waits on a branch for review instead of landing in the
project folder.

The router is mounted from provider_api.py alongside the other domain APIs.

Security:
- `project_dir` must be an absolute path that points at an existing dir on
  disk; any attempt to escape via "..", symlinks pointing outside HOME, etc.
  is rejected before any filesystem read happens.
- `command` must match a simple slug regex so a malicious caller can't
  inject shell metacharacters or path traversal into the prompt.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query
from foundation.api_safety import validated_dir
from skills_registry.bundled import (
    BUNDLED_SKILLS,
    bundled_skill_dirs,
    load_bundled_skill,
)
from skills_registry.frontmatter import parse_frontmatter, workpilot_meta
from skills_registry.resolver import check_requires

logger = logging.getLogger(__name__)

router = APIRouter()

# Slug: lowercase letters / digits / hyphens / underscores / dots / colons.
# Matches both built-in commands like "compact" / "clear" and filesystem
# commands like "bmad-agent-bmm-dev".
_COMMAND_NAME_RE = re.compile(r"^[a-zA-Z0-9_./:-]{1,128}$")


def _valid_command_name(command: str) -> bool:
    """A command name, never a path: ``ns/cmd`` and ``ns:cmd`` are names,
    ``../x`` and ``/etc/x`` would be joined to a directory and leave it."""
    if not isinstance(command, str) or not _COMMAND_NAME_RE.match(command):
        return False
    return not command.startswith("/") and ".." not in command.split("/")


def _safe_project_dir(raw: str) -> Path:
    """Resolve `raw` to an absolute path and reject obviously bogus inputs.

    We accept any existing directory on disk: enforcing a tighter rule (must
    be under HOME, must be a git repo, etc.) would break legitimate dev
    setups where projects live anywhere. The .claude/commands listing itself
    is read-only, so the worst a bad path can do is return [].
    """
    try:
        return validated_dir(raw, "project_dir")
    except ValueError as exc:
        # `validated_dir` is written not to put a resolved server path in its
        # message, so this one is safe to pass on as-is.
        raise HTTPException(status_code=400, detail=str(exc)) from None


def _parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Parse a SKILL.md / command frontmatter block.

    Delegates to the shared parser so every reader in the repo agrees on what
    a frontmatter block means. The previous local implementation stripped
    quotes off the whole value, which truncated any description ending in a
    quoted phrase -- 32 of the BMAD skills lost their closing quote that way.
    """
    return parse_frontmatter(text)


def _scan_commands_dir(dir_path: Path, source: str) -> list[dict[str, Any]]:
    """Return one entry per *.md in `dir_path`. Missing dir → []."""
    if not dir_path.exists() or not dir_path.is_dir():
        return []
    items: list[dict[str, Any]] = []
    try:
        files = sorted(dir_path.glob("*.md"))
    except OSError:
        return []
    for f in files:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        meta, _ = _parse_frontmatter(text)
        items.append(
            {
                # File stem becomes the slash-command name (e.g. /bmad-agent-bmm-dev).
                "name": f.stem,
                "description": meta.get("description") or meta.get("desc") or "",
                "source": source,  # "project" | "user"
                "path": str(f),
            }
        )
    return items


# Provider/IDE-agnostic command source. Each skill lives in its own folder as
# `<project_dir>/.agents/skills/<name>/SKILL.md`. This is the single source of
# truth the Kanban uses regardless of which LLM/IDE drives the task, instead of
# the Claude-specific `.claude/commands/*.md` mirror.
_AGNOSTIC_SKILLS_SUBDIR = Path(".agents") / "skills"


def _scan_skills_dir(project_dir: Path, source: str) -> list[dict[str, Any]]:
    """Return one entry per `.agents/skills/*/SKILL.md`. Missing dir → []."""
    base = project_dir / _AGNOSTIC_SKILLS_SUBDIR
    if not base.exists() or not base.is_dir():
        return []
    items: list[dict[str, Any]] = []
    try:
        skill_files = sorted(base.glob("*/SKILL.md"))
    except OSError:
        return []
    for f in skill_files:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        meta, _ = _parse_frontmatter(text)
        if not _runtime_is_present(meta, project_dir):
            continue
        items.append(
            {
                # The folder name is the command name (e.g. /bmad-bmm-create-prd).
                "name": meta.get("name") or f.parent.name,
                "description": meta.get("description") or meta.get("desc") or "",
                "source": source,
                "path": str(f),
            }
        )
    return items


def _runtime_is_present(meta: dict[str, Any], project_dir: Path) -> bool:
    """Whether this skill's `requires` are satisfied here, right now.

    The build already refuses to emit a skill whose runtime is missing, so on a
    freshly generated tree this changes nothing. It matters because
    `.agents/skills/` is **committed**: a developer who bootstrapped BMAD
    locally emits its skills and commits them, and the next clone has the
    files without `_bmad/`. That is exactly the original failure — a palette
    listing 76 commands that all fail on invocation — arriving by a different
    route, so the gate is enforced at read time too.

    A malformed or unrecognised `requires` hides the command rather than
    showing it. A command that cannot run is worse than one that is missing:
    the user picks it, waits, and gets an error. The mock runtime this
    repository commits for its own build counts as missing here, for the
    same reason.
    """
    requires = workpilot_meta(meta).get("requires")
    if not requires:
        return True
    if not isinstance(requires, dict):
        logger.debug("skill has a non-mapping `requires`, hidden from the palette")
        return False
    try:
        ok, reason = check_requires(requires, project_dir, accept_mock=False)
    except Exception as exc:  # noqa: BLE001 - a bad gate hides, never crashes
        logger.debug("requires check failed, hiding command: %s", exc)
        return False
    if not ok:
        logger.debug("command hidden: %s", reason)
    return ok


def _skill_body_for_provider(proj: Path, skill_md: Path) -> str:
    """The SKILL.md body specialised for the project's active provider.

    Read through `skills_registry.overlays`, so `/verify` fired from the
    Kanban on Ollama reads the Ollama overlay and on Claude the SDK one. The
    provider is *peeked*, never consumed: resolving a body is not starting a
    run.
    """
    from skills_registry.overlays import resolve_skill_file

    root = os.path.realpath(proj / _AGNOSTIC_SKILLS_SUBDIR)
    real = os.path.realpath(skill_md)
    if not real.startswith(root + os.sep):
        raise ValueError("skill outside the project's skills directory")
    try:
        from core.client import peek_active_provider

        provider = peek_active_provider(proj)
    except Exception:  # noqa: BLE001 - no provider config means the default
        provider = None
    return resolve_skill_file(Path(real), provider).body


def _resolve_command_body(proj: Path, command: str) -> str | None:
    """Return the prompt body for `command` from the agnostic source.

    Resolution order (first hit wins):
      1. <proj>/.agents/skills/<command>/SKILL.md   (agnostic, preferred)
      2. <proj>/.claude/commands/<command>.md       (Claude mirror, fallback)
      3. ~/.claude/commands/<command>.md            (user-scoped fallback)
      4. bundled product skills                    (consumer projects)

    The frontmatter is stripped so the returned text is the raw instructions
    any provider can execute. Returns None when no definition is found.
    """
    if not _valid_command_name(command):
        return None
    candidates = [
        proj / _AGNOSTIC_SKILLS_SUBDIR / command / "SKILL.md",
        proj / ".claude" / "commands" / f"{command}.md",
        Path.home() / ".claude" / "commands" / f"{command}.md",
    ]
    for index, path in enumerate(candidates):
        try:
            if not path.is_file():
                continue
            if index == 0:
                # An agnostic skill may carry provider overlays
                # (`providers/*.md`): the body is the one the provider that
                # will execute it should follow.
                body = _skill_body_for_provider(proj, path)
            else:
                _, body = _parse_frontmatter(
                    path.read_text(encoding="utf-8", errors="replace")
                )
            body = body.strip()
            if body:
                return body
        except (OSError, ValueError):
            continue
    return _bundled_body(command)


def _bundled_body(command: str) -> str | None:
    """A bundled skill's body, told where its own files are when it has some.

    A bundled skill is not in the project: its `references/` or `scripts/` sit
    beside the SKILL.md in the release (or the checkout), and a bare
    `references/x.md` read from the project directory finds nothing.
    """
    bundled = load_bundled_skill(command)
    if bundled is None:
        return None
    body = bundled[1]
    for directory in bundled_skill_dirs(command):
        if not (directory / "SKILL.md").is_file():
            continue
        if any((directory / sub).is_dir() for sub in ("references", "scripts")):
            body = (
                f"PROCEDURE SOURCE: {directory / 'SKILL.md'} (bare paths such as "
                f"references/… resolve from {directory})\n\n{body}"
            )
        break
    return body


def _bundled_applies(meta: dict[str, Any], proj: Path) -> bool:
    """A bundled skill pinned to a toolchain is offered only to a project on it.

    `migrate-dotnet10-to-dotnet11` declares `dotnet: ">=10.0 <12.0"`: a Python
    project's palette has no use for it. A skill that declares no target is
    offered everywhere, as before. Read the way the build reads a project
    (`.workpilot/skills.toml` first, then detection).
    """
    targets = workpilot_meta(meta).get("targets")
    if not isinstance(targets, dict) or not targets:
        return True
    from skills_registry.project import load_project_config
    from skills_registry.targets import targets_match

    try:
        ok, reason = targets_match(targets, load_project_config(proj).targets)
    except (OSError, ValueError) as exc:
        ok, reason = False, str(exc)
    if not ok:
        logger.debug("bundled command hidden: %s", reason)
    return ok


# Built-in commands of the Quick-Command bar. Commands that operate on a
# persistent conversation (/compact, /clear, /save, /resume…) are omitted:
# each run starts a fresh agent with an empty transcript. `/review` has its
# instructions in `slash_commands.execution` (any provider runs them); `/help`
# is answered by the bar from this list.
_BUILT_IN_COMMANDS: list[dict[str, str]] = [
    {
        "name": "review",
        "description": "Run the bundled code review skill on the current branch",
    },
    {
        "name": "help",
        "description": "Show built-in slash command help",
    },
]


# Built-in commands with no file behind them. Their instructions are written
# here so that every provider can run them, rather than relying on Claude
# Code's own `/review`. `/help` is answered by the bar itself (it already has
# the list) and never reaches a runner.
_BUILT_IN_BODIES: dict[str, str] = {
    "review": (
        "Review the code of this repository's current branch.\n\n"
        "1. Find the base branch (`git rev-parse --abbrev-ref origin/HEAD`, "
        "else `develop`, else `main`) and read `git diff <base>...HEAD`.\n"
        "2. When that diff is empty, review the last five commits instead "
        "(`git log -5 -p`).\n"
        "3. Report correctness bugs first, then security issues, then "
        "maintainability, each with its file and line and a concrete fix.\n\n"
        "Do not modify any file: this is a review, not a fix."
    ),
}


def resolve_command_instructions(proj: Path, command: str) -> str | None:
    """A command's instructions: its file (`_resolve_command_body`), else a built-in's."""
    return _resolve_command_body(proj, command) or _BUILT_IN_BODIES.get(command)


@router.get("/api/slash-commands")
def list_slash_commands(project_dir: Annotated[str, Query()]):
    """List discovered slash commands for a project.

    Order: agnostic project skills first, then any Claude-only mirror commands,
    then user commands, then bundled skills and built-ins. Commands provided by the
    agnostic `.agents/skills/` source are not repeated from `.claude/commands`
    (the Claude mirror is a fallback for non-skill commands only).
    """
    proj = _safe_project_dir(project_dir)

    # Primary, provider/IDE-agnostic source.
    skill_cmds = _scan_skills_dir(proj, "project")
    seen = {c["name"] for c in skill_cmds}

    # Claude-specific mirror, kept only for commands not already covered above.
    project_cmds = [
        c
        for c in _scan_commands_dir(proj / ".claude" / "commands", "project")
        if c["name"] not in seen
    ]
    seen.update(c["name"] for c in project_cmds)
    user_cmds = [
        c
        for c in _scan_commands_dir(Path.home() / ".claude" / "commands", "user")
        if c["name"] not in seen
    ]
    seen.update(c["name"] for c in user_cmds)
    bundled_cmds = []
    for name in BUNDLED_SKILLS:
        if name in seen:
            continue
        skill = load_bundled_skill(name)
        if skill is not None and _bundled_applies(skill[0], proj):
            bundled_cmds.append(
                {
                    "name": name,
                    "description": skill[0].get("description", ""),
                    "source": "built-in",
                    "path": "",
                }
            )
    built_ins = [
        {**cmd, "source": "built-in", "path": ""} for cmd in _BUILT_IN_COMMANDS
    ]

    return {
        "success": True,
        "commands": skill_cmds + project_cmds + user_cmds + bundled_cmds + built_ins,
    }


@router.get("/api/slash-commands/body")
def get_slash_command_body(
    project_dir: Annotated[str, Query()],
    command: Annotated[str, Query()],
):
    """Return a command's resolved instruction body WITHOUT executing it.

    Used by the Kanban "Run as task" action: it seeds a real, interactive task
    with these instructions (rather than the bar's run on a review card), so the
    command flows through the normal task pipeline (planning, plan-approval,
    conversation). Resolution mirrors `_resolve_command_body`.
    """
    if not _valid_command_name(command):
        raise HTTPException(
            status_code=400, detail=f"invalid command name: {command!r}"
        )
    proj = _safe_project_dir(project_dir)
    body = resolve_command_instructions(proj, command)
    if body is None:
        raise HTTPException(status_code=404, detail=f"command not found: {command}")
    return {"success": True, "name": command, "body": body}
