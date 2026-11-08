"""Mark the PR of a split part as a member of its group, on its forge.

The PR of a part (``task_split``) gets its group's title prefix
``[<group title> k/N]`` and a "PR group" section at the end of its body on
every forge. On GitHub and GitLab it also gets the label ``groupe/<group id>``
in the group's colour, the one the board shows; Azure DevOps has no PR label
a pipeline can rely on, so the prefix and the section say it there.

A label that cannot be created or put never undoes the PR: it is logged.
``gh`` and ``glab`` get argument lists, and the label name comes from a spec
folder name the board validated (rule 6).
"""

from __future__ import annotations

import logging
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from task_split.group import PartGroup, group_section, group_title, part_group

logger = logging.getLogger(__name__)

__all__ = ["PrDecoration", "append_section", "apply_group_label", "decoration_for"]

_LABEL = re.compile(r"^groupe/[A-Za-z0-9][A-Za-z0-9_-]{0,42}$")
_GITLAB_MR = re.compile(r"/-/merge_requests/(\d+)$")
_TIMEOUT = 60


@dataclass(frozen=True)
class PrDecoration:
    group: PartGroup
    section: str

    def title(self, title: str) -> str:
        return group_title(title, self.group)


def append_section(body: str | None, section: str) -> str | None:
    """``body`` with ``section`` at its end, once."""
    if not section or (body and section.strip() in body):
        return body
    return f"{(body or '').rstrip()}\n\n{section}".lstrip()


def decoration_for(spec_dir: Path) -> PrDecoration | None:
    """The group marks of the card in ``spec_dir``; None when it is not a part."""
    try:
        group = part_group(spec_dir)
    except (OSError, ValueError, TypeError) as exc:
        logger.warning("split group unreadable, PR left unmarked: %s", exc)
        return None
    if group is None:
        return None
    return PrDecoration(group, group_section(group))


def _run(args: list[str], cwd: Path) -> bool:
    try:
        result = subprocess.run(
            args,
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_TIMEOUT,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning(
            "group label: %s could not run (%s)", args[1], type(exc).__name__
        )
        return False
    if result.returncode != 0:
        logger.warning(
            "group label: %s %s failed: %s",
            args[1],
            args[2],
            (result.stderr or "").strip().splitlines()[:1],
        )
    return result.returncode == 0


def apply_group_label(
    provider: str,
    executable: str | None,
    cwd: Path,
    pr_url: str | None,
    group: PartGroup,
) -> bool:
    """Create the group's label in its colour and put it on the PR; True when put."""
    label = group.label
    if not executable or not pr_url or not _LABEL.match(label):
        return False
    description = f"WorkPilot split: {group.title}"[:100]
    if provider == "github":
        _run(
            [
                executable,
                "label",
                "create",
                label,
                "--color",
                group.color,
                "--description",
                description,
                "--force",
            ],
            cwd,
        )
        return _run([executable, "pr", "edit", pr_url, "--add-label", label], cwd)
    if provider == "gitlab":
        match = _GITLAB_MR.search(pr_url)
        if not match:
            return False
        # Created in the group's colour; "already exists" is fine.
        _run(
            [
                executable,
                "api",
                "-X",
                "POST",
                "projects/:id/labels",
                "-f",
                f"name={label}",
                "-f",
                f"color=#{group.color}",
                "-f",
                f"description={description}",
            ],
            cwd,
        )
        return _run(
            [
                executable,
                "api",
                "-X",
                "PUT",
                f"projects/:id/merge_requests/{match.group(1)}",
                "-f",
                f"add_labels={label}",
            ],
            cwd,
        )
    return False
