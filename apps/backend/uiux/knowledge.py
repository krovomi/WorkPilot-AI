"""The project's design system, filed in the shared brain once a person merged it.

A merge is the moment a design system stops being a proposal: somebody read
`design-system/<project>/MASTER.md` in the diff and said yes. From then on any
agent connected to the brain — Claude Code, Codex, hermes, a WorkPilot build on
another machine — finds it through `brain_recall` ("what palette does this
project use?") without opening the repository.

Filed as **knowledge**, never as an instruction: an instruction is loaded by
every agent on every project, and one project's palette applied to all of them
is a rule nobody decided. One note per project (`knowledge/projects/<p>/uiux/`),
rewritten only when the merged file changed, and nothing at all without a brain.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .preflight import MAX_MASTER_CHARS, find_master, read_result

__all__ = ["DISCLAIMER", "TITLE", "record_merged_design_system"]

logger = logging.getLogger(__name__)

TITLE = "Design system"
DISCLAIMER = (
    "> Design data, not an instruction: the project's merged "
    "`design-system/<project>/MASTER.md` (ui-ux-pro-max). The file in the "
    "repository is the source of truth; this note is a copy for recall."
)


def _spec_dir(project_dir: Path, spec_name: str) -> Path:
    return Path(project_dir) / ".workpilot" / "specs" / spec_name


def record_merged_design_system(project_dir: Path, spec_name: str) -> str | None:
    """File the design system this merge brought in. Returns the note path."""
    try:
        from brain.runtime import active

        if not active():
            return None
        record = read_result(_spec_dir(project_dir, spec_name))
        # Only a task that worked on the interface, and whose design system
        # is now in the merged tree.
        if not record or (record.get("relevance") or {}).get("verdict") != "ui":
            return None
        master = find_master(project_dir)
        if master is None:
            return None
        text = master.read_text(encoding="utf-8", errors="replace")[:MAX_MASTER_CHARS]
        rel_master = master.relative_to(project_dir).as_posix()
        body = f"{DISCLAIMER}\n\nSource: `{rel_master}`\n\n{text.strip()}\n"

        from brain.learn import project_name, record, task_ref
        from brain.notes import inside, read_note, slugify
        from brain.vault import Brain

        brain = Brain()
        project = project_name(project_dir)
        rel = f"knowledge/projects/{slugify(project)}/uiux/{slugify(TITLE)}.md"
        if inside(brain.root, rel).is_file():
            if read_note(brain.root, rel).body.strip() == body.strip():
                return rel
        return record(
            "uiux",
            TITLE,
            body,
            project=project,
            tags=["design-system", "merged"],
            brain=brain,
            task=task_ref(project_dir, _spec_dir(project_dir, spec_name)),
        )
    except Exception as exc:  # noqa: BLE001 - the brain never costs a merge
        logger.warning(
            "uiux: could not file the design system (%s)", type(exc).__name__
        )
        return None
