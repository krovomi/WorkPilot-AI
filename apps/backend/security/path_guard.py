"""Where an agent may write, and the hook that holds it to it.

The isolation this product describes — "all work happens in isolated git
worktrees so the main branch stays safe" — was, on the write path, a
convention. `bash_security_hook` judges what an agent *runs*; nothing judged
where it *writes*. The only hook registered on `Write` and `Edit` was
`_make_guardrails_hook`, and `guardrails.evaluate` returns "no opinion" when
`.workpilot/guardrails.yaml` does not exist, which is the default. So the
write path was open to wherever the process could reach: `~/.bashrc`,
`~/.ssh/authorized_keys`, `~/.claude/settings.json` — which redefines the
agent's own permissions for the next run — or the main checkout instead of the
worktree the build was given.

`coder.validate_subtask_files` already refuses a planned file that resolves
outside the project. That is the same rule, applied to the plan; this applies
it to the act. Checking the plan and not the write is checking the half that
was written down by the planner rather than the half chosen by the model
mid-session.

What is allowed
---------------
Three roots, and each is somewhere the build was *given*:

``project_dir``
    The checkout or worktree this build runs in. In worktree mode this is the
    worktree, so a write into the main checkout is refused by the same rule
    that refuses a write into `$HOME` — which is the isolation the product
    promises, enforced rather than assumed.

``spec_dir``
    Where the spec, the plan, the QA report and the ledgers live. It is
    normally under `.workpilot/specs/` inside the project, and it is named
    separately because nothing requires it to be.

``<tempdir>/workpilot``
    One scratch directory, not the whole of `/tmp`. Scratch files are
    ordinary — a diff to inspect, a fixture a test harness reads back — but
    the system temp directory is shared with every other process on the
    machine, and a build whose worktree happens to live under `/tmp` would
    have had the whole of it opened back up by a root meant for scratch. A
    named subdirectory keeps the convenience and not the reach. Nothing
    creates it; it is permitted, and the tool that writes there makes it.

`WORKPILOT_WRITE_ROOTS` adds more, separated by `os.pathsep`, for a build that
legitimately spans checkouts. It only ever **adds**: there is no switch that
turns this off, because a control an agent can talk a user into disabling is
not one the user can rely on, and a build that needs another directory can
name that directory.

Symlinks are resolved before the comparison, so a link planted inside the
worktree is judged by where it points. A link planted *between* this check and
the write is not covered — that race is the kernel's to lose, and closing it
would mean opening the file here, which is the write.

What is refused inside the roots
--------------------------------
The files that decide what an agent may do live in the project, so "inside
the roots" was not enough. `.workpilot-allowlist` and
`.workpilot-security.json` are the command allowlist, which
`security.profile.get_security_profile` reloads as soon as their mtime
changes; `.workpilot/guardrails.*` is the user's own policy;
`.claude_settings.json` and `.claude/settings*.json` are the SDK's
permissions. An agent that could write one could widen its own rights for its
next command. `protected_config_target` names them, and the same table serves
the non-SDK executor (`core.runtimes.tool_executor`) and the Bash validator
(`security.config_write_validators`), so the three barriers cannot disagree on
what they protect.
"""

from __future__ import annotations

import fnmatch
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

__all__ = [
    "GUARDED_WRITE_TOOLS",
    "PROTECTED_CONFIG_DIRS",
    "PROTECTED_CONFIG_NAMES",
    "make_write_path_hook",
    "protected_config_refusal",
    "protected_config_target",
    "resolve_write_roots",
    "workpilot_scratch_dir",
]

#: The tools that name a file they are about to write. The same four
#: `watermarks.CLEANED_TOOLS` names, and for the same reason: `MultiEdit` and
#: `NotebookEdit` are rarely reached in a WorkPilot build, and leaving them out
#: would be a silent hole the day one is enabled.
GUARDED_WRITE_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")

#: Where each tool keeps the path it is about to write.
_PATH_FIELDS = ("file_path", "notebook_path")

#: Extra roots, `os.pathsep`-separated. Additive only.
WRITE_ROOTS_ENV_VAR = "WORKPILOT_WRITE_ROOTS"

#: Security configuration recognised by its file name, wherever it sits:
#: `.workpilot-security.json` is kept in the spec directory as often as at the
#: project root (`ProjectAnalyzer.get_profile_path`), and a worktree carries its
#: own copies (`workspace_setup`).
PROTECTED_CONFIG_NAMES: tuple[str, ...] = (
    ".workpilot-allowlist",
    ".workpilot-security.json",
    ".claude_settings.json",
    # The task's definition of done (`goal/spec.py`): an agent that could
    # rewrite it would make `true` its goal.
    ".workpilot-goal.json",
)

#: Security configuration recognised by its directory *and* its name:
#: `.workpilot/guardrails.yaml` is the user's policy, `config/guardrails.yaml`
#: is the project's own business. Names are `fnmatch` patterns.
PROTECTED_CONFIG_DIRS: dict[str, tuple[str, ...]] = {
    ".workpilot": ("guardrails.yaml", "guardrails.yml", "guardrails.json"),
    ".claude": ("settings*.json",),
}

_GLOB_CHARS = frozenset("*?[")


def _fold(component: str) -> str:
    """A path component as the file system that will receive it compares it.

    Windows and macOS compare names without case, Windows drops trailing dots
    and spaces, and NTFS reads `name:stream` as `name`. Folding all three on
    every platform costs a false refusal on Linux for a name nobody uses, and
    saves a bypass where the name is the same file.
    """
    return component.split(":", 1)[0].rstrip(" .").casefold()


def _component_matches(component: str, pattern: str, *, glob: bool) -> bool:
    folded = _fold(component)
    if glob and _GLOB_CHARS.intersection(folded):
        # The shell does not let a wildcard match a leading dot: `*` is not
        # `.workpilot-allowlist`, `.*` is.
        if pattern.startswith(".") and not folded.startswith("."):
            return False
        return fnmatch.fnmatchcase(pattern, folded)
    return fnmatch.fnmatchcase(folded, pattern)


def _lexical_parts(path: str) -> list[str]:
    """The components of `path`, `..` folded in, on either separator.

    Lexical on purpose: the shell hands a validator text, and `/` or `\\`
    separate components on whichever platform the line will run.
    """
    parts: list[str] = []
    for part in re.split(r"[\\/]+", path):
        if part in ("", "."):
            continue
        if part == ".." and parts and parts[-1] != "..":
            parts.pop()
            continue
        parts.append(part)
    return parts


def protected_config_target(
    path: str | Path,
    *,
    glob: bool = False,
    directories: bool = False,
) -> str | None:
    """The security configuration file `path` names, or ``None``.

    Judged on the text alone; `glob=True` also answers for a shell wildcard
    that would expand to one (`.workpilot-allow*`, `.claude/*`), and
    `directories=True` for the directory that holds one (`rm -rf .claude`),
    which a shell can replace whole. The answer is the file as the path
    spells it, for the refusal message.
    """
    parts = _lexical_parts(str(path))
    if not parts:
        return None

    name = parts[-1]
    if any(_component_matches(name, p, glob=glob) for p in PROTECTED_CONFIG_NAMES):
        return name
    if directories and any(
        _component_matches(name, d, glob=glob) for d in PROTECTED_CONFIG_DIRS
    ):
        return f"{name}/"

    if len(parts) >= 2:
        for directory, patterns in PROTECTED_CONFIG_DIRS.items():
            if not _component_matches(parts[-2], directory, glob=glob):
                continue
            if any(_component_matches(name, p, glob=glob) for p in patterns):
                return f"{parts[-2]}/{name}"
    return None


def protected_config_refusal(path: str, base: Path | None) -> str | None:
    """Why an agent may not write `path`, or ``None`` when it may.

    Judged twice: on the path as written, and on where it resolves, so a link
    planted in the worktree (`notes.txt -> .workpilot-allowlist`) or a
    directory reached through one is judged by what it points at.
    """
    target = protected_config_target(path)
    if target is None:
        candidate = Path(path).expanduser()
        if not candidate.is_absolute() and base is not None:
            candidate = base / candidate
        resolved = _resolved(candidate)
        if resolved is not None:
            target = protected_config_target(resolved)
    if target is None:
        return None
    return (
        f"Refusing to write '{path}': {target} is security configuration — it "
        "decides which commands and writes this build's agents are allowed, "
        "and an agent does not change its own rights. If the task needs a "
        "command or a permission it does not have, say so in your output and "
        "leave the change to the user."
    )


def workpilot_scratch_dir() -> Path:
    """The one directory under the system temp root a build may write to.

    Kept narrow deliberately: `tempfile.gettempdir()` is shared with every
    process on the machine, and naming it as a root would also re-open a
    worktree that happens to sit under it.
    """
    return Path(tempfile.gettempdir()) / "workpilot"


def _resolved(path: Path | str) -> Path | None:
    try:
        return Path(path).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return None


def resolve_write_roots(
    project_dir: Path | str | None,
    spec_dir: Path | str | None = None,
) -> list[Path]:
    """The directories a build may write into, resolved and de-duplicated.

    Returned as a list rather than a set so the refusal message can name them
    in a stable order — the project first, which is the one the reader is
    almost always looking for.
    """
    roots: list[Path] = []

    for candidate in (project_dir, spec_dir, workpilot_scratch_dir()):
        if not candidate:
            continue
        resolved = _resolved(candidate)
        if resolved is not None and resolved not in roots:
            roots.append(resolved)

    for entry in os.environ.get(WRITE_ROOTS_ENV_VAR, "").split(os.pathsep):
        entry = entry.strip()
        if not entry:
            continue
        resolved = _resolved(entry)
        if resolved is not None and resolved not in roots:
            roots.append(resolved)

    return roots


def _target_paths(tool_input: dict[str, Any]) -> list[str]:
    """Every path this call would write. Usually one; never assumed to be."""
    paths: list[str] = []
    for field in _PATH_FIELDS:
        value = tool_input.get(field)
        if isinstance(value, str) and value.strip():
            paths.append(value)
    return paths


def is_within_roots(path: str, roots: list[Path], base: Path | None) -> bool:
    """Whether `path` lands inside one of `roots`.

    A relative path is resolved against `base` — the directory the agent is
    working in — rather than against the process's cwd, which in a worktree
    build is not necessarily the same thing.
    """
    candidate = Path(path).expanduser()
    if not candidate.is_absolute() and base is not None:
        candidate = base / candidate

    resolved = _resolved(candidate)
    if resolved is None:
        return False

    return any(resolved == root or resolved.is_relative_to(root) for root in roots)


def make_write_path_hook(
    project_dir: Path | str | None,
    spec_dir: Path | str | None = None,
):
    """Bind the build's roots into a PreToolUse hook.

    The factory shape is the one `make_watermarks_hook` and
    `_make_guardrails_hook` already use: the SDK calls hooks with a fixed
    signature, so anything the hook needs about *this build* is closed over.

    The roots are resolved once, at client construction, rather than per call:
    they cannot change during a session, and the hook runs on every write.
    """
    roots = resolve_write_roots(project_dir, spec_dir)
    base = _resolved(project_dir) if project_dir else None

    async def _hook(
        input_data: dict[str, Any],
        tool_use_id: str | None = None,
        context: Any | None = None,
    ) -> dict[str, Any]:
        tool_name = input_data.get("tool_name")
        if tool_name not in GUARDED_WRITE_TOOLS:
            return {}

        tool_input = input_data.get("tool_input")
        if not isinstance(tool_input, dict):
            # Malformed input is the guardrails hook's to refuse, with its own
            # message. Answering here would race it with a worse one.
            return {}

        targets = _target_paths(tool_input)
        if not targets:
            return {}

        for target in targets:
            if roots and not is_within_roots(target, roots, base):
                listed = ", ".join(str(root) for root in roots)
                logger.warning("write refused outside build roots: %s", target)
                return _deny(
                    f"Refusing to write '{target}': it resolves outside "
                    f"this build's directories ({listed}). A build writes "
                    "in its own checkout — edit a file there, or have the "
                    "user add the directory to "
                    f"{WRITE_ROOTS_ENV_VAR} if it really belongs to this "
                    "build."
                )

            # Not conditional on the roots: what the file decides does not
            # depend on where the build was told it may write.
            if refusal := protected_config_refusal(target, base):
                logger.warning("write refused on security configuration: %s", target)
                return _deny(refusal)

        if not roots:
            # Nothing to confine against means the caller gave neither a
            # project nor a spec directory. Refusing every write would break a
            # build over a wiring mistake; saying so once is the honest answer.
            logger.warning(
                "write path guard inactive for %s: no roots resolved", tool_name
            )

        return {}

    return _hook


def _deny(reason: str) -> dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
