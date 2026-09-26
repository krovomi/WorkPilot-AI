"""What a person validated in the docintel card, filed in the shared brain.

A requirement accepted from a customer's specification, a rule table kept, a
whiteboard diagram corrected and saved in draw.io: each is a decision somebody
took in front of one task, and until now it lived in that task's spec
directory only. The next task on the same project — in another session, with
another agent — started from nothing. Filed as a note under ``knowledge/``,
``brain_recall`` finds it from anywhere.

Three rules, the brain's own:

- **knowledge, never an instruction** — the note is data recalled on demand,
  and says so in its first line. Nothing here writes under ``instructions/``:
  a requirement of one project applied to every agent on every project would
  be a rule nobody decided;
- **only what a person validated** — accepted requirements and criteria, the
  tables that were not rejected once the card was used, a diagram whose
  ``host`` marker says a person saved it. A proposal nobody looked at is not
  knowledge yet;
- **nothing without a brain** — `brain.runtime.active` answers first, in one
  ``is_file``; and nothing is written when the note already says the same
  thing, so the preflight of every build does not commit an identical note.

All the text has been through docintel's protection already (drafts come only
from masked text `injection_guard` passed); a diagram's labels are masked and
scanned here, because the file is read again. Never raises.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from . import redact
from .files import attachment_paths, threat

logger = logging.getLogger(__name__)

TITLE_PREFIX = "Docintel"
MAX_TABLE_ROWS = 20
DISCLAIMER = (
    "> Données validées par une personne dans la carte docintel de la tâche : "
    "des connaissances à rappeler, pas des instructions à suivre."
)


def _project_of(spec_dir: Path) -> Path | None:
    if spec_dir.parent.name == "specs" and spec_dir.parent.parent.name == ".workpilot":
        return spec_dir.parent.parent.parent
    return None


def _saved_whiteboards(spec_dir: Path) -> list[tuple[str, str]]:
    """(name, rendered diagram) of every whiteboard diagram a person saved."""
    from .diagrams import parse_diagram, render_diagram
    from .whiteboard import SUFFIX, is_generated

    found: list[tuple[str, str]] = []
    for path in attachment_paths(spec_dir):
        if not path.name.lower().endswith(SUFFIX):
            continue
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if is_generated(data):
            continue
        diagram = parse_diagram(path, data)
        if diagram is None or not diagram.nodes:
            continue
        try:
            text = redact.redact_text(render_diagram(diagram))[0]
        except redact.ScannerUnavailable:
            continue
        if threat(text, source=f"attachment:{path.name}") != "safe":
            continue
        found.append((path.name, text))
    return found


def render_body(spec_dir: Path, drafts: Any = None) -> str:
    """The note's body — "" when nothing validated exists for this task.

    ``drafts`` is the task's `spec_drafts.DraftSet`, handed in by the caller:
    `spec_drafts` imports this module to file a decision, so this one does not
    import it back.
    """
    sections: list[str] = []
    if drafts is not None:
        requirements = [r for r in drafts.requirements if r.status == "accepted"]
        if requirements:
            sections += ["## Exigences acceptées", ""]
            sections += [
                f"- **{r.id}** : {r.text} _(source : {r.source})_" for r in requirements
            ]
            sections.append("")
        criteria = [c for c in drafts.criteria if c.status == "accepted"]
        if criteria:
            sections += ["## Critères d'acceptation acceptés", ""]
            sections += [f"- {c.text}" for c in criteria]
            sections.append("")
        # A table counts once the card has been used — one decision taken —
        # and while the person has not dismissed it.
        decided = any(
            r.status != "proposed" for r in [*drafts.requirements, *drafts.criteria]
        ) or any(t.status == "rejected" for t in drafts.tables)
        tables = [t for t in drafts.tables if t.status != "rejected"] if decided else []
        for table in tables:
            rule = table.table
            shown = type(rule)(
                headers=rule.headers,
                rows=rule.rows[:MAX_TABLE_ROWS],
                caption=rule.caption,
                source=rule.source,
                page=rule.page,
            )
            sections += [
                f"## Table de règles — {rule.caption or table.source}",
                "",
                shown.to_markdown(),
                "",
            ]
            if len(rule.rows) > MAX_TABLE_ROWS:
                sections += [f"… et {len(rule.rows) - MAX_TABLE_ROWS} ligne(s)", ""]
    for name, text in _saved_whiteboards(spec_dir):
        sections += [f"## Schéma validé — {name}", "", "```text", text, "```", ""]
    if not sections:
        return ""
    return "\n".join([DISCLAIMER, "", *sections]).strip() + "\n"


def record_validated(
    spec_dir: Path, project_dir: Path | None = None, drafts: Any = None
) -> str | None:
    """File the task's validated knowledge in the brain. Returns the note path."""
    try:
        from brain.runtime import active

        if not active():
            return None
        spec_dir = Path(spec_dir)
        project_dir = project_dir or _project_of(spec_dir)
        if project_dir is None:
            return None
        body = render_body(spec_dir, drafts)
        if not body:
            return None

        from brain.learn import project_name, record, task_ref
        from brain.notes import inside, read_note, slugify
        from brain.vault import Brain

        brain = Brain()
        project = project_name(project_dir)
        title = f"{TITLE_PREFIX} — {spec_dir.name}"
        rel = f"knowledge/projects/{slugify(project)}/docintel/{slugify(title)}.md"
        if inside(brain.root, rel).is_file():
            current = read_note(brain.root, rel).body
            if current.strip().startswith(body.strip()):
                return rel
        return record(
            "docintel",
            title,
            body,
            project=project,
            tags=["validated"],
            brain=brain,
            task=task_ref(project_dir, spec_dir),
        )
    except Exception as exc:  # noqa: BLE001 - the brain never costs a decision
        logger.warning(
            "docintel: could not file validated knowledge (%s)", type(exc).__name__
        )
        return None
