"""What the brain learns from WorkPilot itself, without asking a model.

Agents write to the brain when they notice something (`runtime.py` tells every
one of them how). That depends on a model deciding to do it. This module is the
other half: the facts WorkPilot *knows* at a given moment, recorded whether or
not any agent thought to.

| Surface | Moment | What is recorded |
|---|---|---|
| ``build`` | end of every Kanban/CLI build (`cli/build_commands._run_observe_phase`) | the task, what it asked for, what QA and the tests said, which files it touched |
| ``merge`` | a person merges the build (`cli/workspace_commands`) | the same note, marked accepted: the strongest signal there is |

Every build note links to a project note, so the graph answers "what has been
done on this project, and what was accepted" in one ``brain_recall`` — from any
agent, on any machine.

``SURFACES`` is closed for the reason `hermes.loop.SURFACES` is: the surface is
written into a note a person reads, and a free-text field fills with whatever
string each caller happened to pass.

**Nothing here can fail a build or a merge.** No brain, a malformed spec, git
offline: the function logs and returns ``None``.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from .notes import Note, inside, now_iso, read_note, slugify, write_note
from .runtime import active
from .vault import Brain

logger = logging.getLogger(__name__)

__all__ = ["SURFACES", "project_name", "record_build", "record_merge", "record"]

SURFACES = frozenset(
    {
        "build",
        "merge",
        "kanban",
        "insights",
        "ideation",
        "roadmap",
        "github",
        "self-healing",
    }
)

_MAX_FILES = 25
_MAX_SUMMARY = 700


def project_name(project_dir: Path) -> str:
    """The project a path belongs to, seen through a worktree.

    A build runs in ``<project>/.workpilot/worktrees/<spec>/``; naming the note
    after the worktree would file every task under a different "project".
    """
    parts = Path(project_dir).resolve().parts
    for marker in (".workpilot", ".worktrees"):
        if marker in parts:
            index = parts.index(marker)
            if index > 0:
                return parts[index - 1]
    return Path(project_dir).resolve().name


def _project_rel(project: str) -> Path:
    return Path("knowledge") / "projects" / slugify(project) / "index.md"


def _build_rel(project: str, spec_id: str) -> Path:
    return (
        Path("knowledge")
        / "projects"
        / slugify(project)
        / "builds"
        / f"{slugify(spec_id)}.md"
    )


def _ensure_project(root: Path, project: str) -> str:
    """The project's hub note; returns the wikilink target builds point at."""
    rel = _project_rel(project)
    if not inside(root, rel).exists():
        write_note(
            root,
            Note(
                path=rel,
                meta={
                    "kind": "knowledge",
                    "title": f"Projet {project}",
                    "tags": ["project"],
                    "created": now_iso(),
                },
                body=f"# Projet {project}\n\nTâches construites par WorkPilot : voir les notes liées.\n",
            ),
        )
    return rel.with_suffix("").as_posix()


def _spec_title_and_summary(spec_dir: Path) -> tuple[str, str]:
    title, summary = spec_dir.name, ""
    requirements = spec_dir / "requirements.json"
    try:
        data = json.loads(requirements.read_text(encoding="utf-8"))
        text = str(data.get("task_description") or "").strip()
        if text:
            summary = text
            title = text.splitlines()[0][:90]
    except (OSError, ValueError, AttributeError):
        pass
    spec = spec_dir / "spec.md"
    try:
        body = spec.read_text(encoding="utf-8", errors="replace")
    except OSError:
        body = ""
    for line in body.splitlines():
        if line.startswith("# "):
            title = (
                re.sub(
                    r"^(Specification|Spec|Spécification)\s*:\s*",
                    "",
                    line[2:].strip(),
                    flags=re.I,
                )
                or title
            )
            break
    if not summary and body:
        paragraphs = [
            p.strip()
            for p in body.split("\n\n")
            if p.strip() and not p.lstrip().startswith("#")
        ]
        summary = paragraphs[0] if paragraphs else ""
    if len(summary) > _MAX_SUMMARY:
        summary = summary[: _MAX_SUMMARY - 1].rstrip() + "…"
    return title, summary


def _verdict(value: bool | None, yes: str, no: str) -> str:
    return "non mesuré" if value is None else (yes if value else no)


def record_build(
    spec_dir: Path,
    project_dir: Path,
    *,
    qa_approved: bool | None = None,
    tests_passed: bool | None = None,
    changed_files: list[str] | None = None,
    language: str = "",
    brain: Brain | None = None,
) -> str | None:
    """File the finished build as a note, then sync. Returns its path."""
    try:
        brain = brain or Brain()
        if not active(brain.root):
            return None
        project = project_name(project_dir)
        spec_id = Path(spec_dir).name
        title, summary = _spec_title_and_summary(Path(spec_dir))
        project_link = _ensure_project(brain.root, project)
        files = sorted(changed_files or [])
        lines = [
            f"# {title}",
            "",
            f"Tâche `{spec_id}` du projet [[{project_link}|{project}]], construite par WorkPilot.",
            "",
        ]
        if summary:
            lines += ["## Demande", "", summary, ""]
        lines += [
            "## Résultat",
            "",
            f"- QA : {_verdict(qa_approved, 'approuvée', 'refusée')}",
            f"- Tests : {_verdict(tests_passed, 'verts', 'rouges')}",
        ]
        if files:
            lines += ["", "## Fichiers modifiés", ""]
            lines += [f"- `{name}`" for name in files[:_MAX_FILES]]
            if len(files) > _MAX_FILES:
                lines.append(f"- … et {len(files) - _MAX_FILES} autre(s)")
        tags = ["build", slugify(project)]
        if language:
            tags.append(slugify(language))
        rel = _build_rel(project, spec_id)
        meta: dict[str, Any] = {}
        if inside(brain.root, rel).exists():
            meta = dict(read_note(brain.root, rel).meta)
        meta.update(
            {
                "kind": "knowledge",
                "title": title,
                "surface": "build",
                "project": project,
                "spec": spec_id,
                "status": meta.get("status")
                if meta.get("status") == "merged"
                else "built",
                "qa": qa_approved,
                "tests": tests_passed,
                "tags": tags,
                "updated": now_iso(),
            }
        )
        meta.setdefault("created", now_iso())
        write_note(brain.root, Note(path=rel, meta=meta, body="\n".join(lines) + "\n"))
        brain.after_write(f"brain: build {project}/{spec_id}")
        return rel.as_posix()
    except Exception as exc:  # noqa: BLE001 - learning never fails a build
        logger.warning("brain: could not record the build: %s", exc)
        return None


def record_merge(
    project_dir: Path, spec_id: str, *, brain: Brain | None = None
) -> str | None:
    """Mark the build note accepted: a person read the diff and merged it."""
    try:
        brain = brain or Brain()
        if not active(brain.root):
            return None
        project = project_name(project_dir)
        rel = _build_rel(project, spec_id)
        if not inside(brain.root, rel).exists():
            return None
        note = read_note(brain.root, rel)
        if note.meta.get("status") == "merged":
            return rel.as_posix()
        note.meta["status"] = "merged"
        note.meta["merged"] = now_iso()
        note.meta["updated"] = now_iso()
        note.body = (
            note.body.rstrip() + "\n\n## Accepté\n\nRelu et mergé par l'utilisateur.\n"
        )
        write_note(brain.root, note)
        brain.after_write(f"brain: merged {project}/{spec_id}")
        return rel.as_posix()
    except Exception as exc:  # noqa: BLE001 - learning never fails a merge
        logger.warning("brain: could not record the merge: %s", exc)
        return None


def record(
    surface: str,
    title: str,
    body: str,
    *,
    project: str | None = None,
    tags: list[str] | None = None,
    brain: Brain | None = None,
) -> str | None:
    """A fact another feature knows, filed under its surface and its project."""
    if surface not in SURFACES:
        raise ValueError(
            f"unknown surface {surface!r} (expected one of {sorted(SURFACES)})"
        )
    try:
        brain = brain or Brain()
        if not active(brain.root):
            return None
        links = [_ensure_project(brain.root, project)] if project else []
        folder = (
            f"knowledge/projects/{slugify(project)}/{surface}"
            if project
            else f"knowledge/{surface}"
        )
        result = brain.write(
            title,
            body,
            tags=[surface, *(tags or [])],
            links=links,
            agent="workpilot",
            path=f"{folder}/{slugify(title)}.md",
        )
        return result.rel
    except Exception as exc:  # noqa: BLE001 - learning never fails the feature
        logger.warning("brain: could not record from %s: %s", surface, exc)
        return None
