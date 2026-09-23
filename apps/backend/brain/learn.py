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
from pathlib import Path, PurePath
from typing import Any

from .notes import Note, inside, now_iso, read_note, slugify, write_note
from .runtime import active
from .vault import Brain

logger = logging.getLogger(__name__)

__all__ = [
    "SURFACES",
    "project_name",
    "task_ref",
    "split_task",
    "build_note_id",
    "record_build",
    "record_merge",
    "record",
    "task_learning",
]

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
    return project_name_from(str(Path(project_dir).resolve()))


def project_name_from(path: str) -> str:
    """`project_name` on a string alone, touching no file system.

    What the HTTP API uses: a client-supplied path is read as a name there,
    never resolved or opened.
    """
    parts = PurePath(path.replace("\\", "/")).parts
    for marker in (".workpilot", ".worktrees"):
        if marker in parts:
            index = parts.index(marker)
            if index > 0:
                return parts[index - 1]
    return parts[-1] if parts else ""


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


def split_task(task: str) -> tuple[str, str]:
    """``project/spec`` -> ``(project, spec)``; ``ValueError`` for anything else."""
    project, sep, spec = (task or "").rpartition("/")
    if not sep or not project or not spec:
        raise ValueError(f"not a task reference: {task!r}")
    return project, spec


def build_note_id(task: str) -> str:
    """The graph id of a task's build note — the node its notes link to."""
    project, spec = split_task(task)
    return _build_rel(project, spec).with_suffix("").as_posix()


def task_ref(project_dir: Path | str | None, spec_dir: Path | str | None) -> str | None:
    """``<project>/<spec-id>`` for a spec directory, else ``None``.

    Only a real spec (``…/.workpilot/specs/<id>``) names a task: several
    features hand `create_client` a directory that is not one, and stamping
    their notes with it would invent a task.
    """
    if not spec_dir or not project_dir:
        return None
    spec = Path(spec_dir)
    if spec.parent.name != "specs":
        return None
    return f"{project_name(Path(project_dir))}/{spec.name}"


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
    except (OSError, ValueError, AttributeError) as exc:
        # No requirements.json, or one without a description: spec.md below
        # still names the task, and the spec id is the last resort.
        logger.debug("brain: no task description in %s: %s", requirements, exc)
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
        # The surface, title and project come from the request: only the
        # error's type goes to the log, never a caller-supplied string.
        logger.warning(
            "brain: could not record a feature note (%s)", type(exc).__name__
        )
        return None


def _note_summary(
    root: Path, rel: str, meta: dict[str, Any], title: str | None = None
) -> dict[str, Any]:
    agents = meta.get("agents") or []
    return {
        "path": rel,
        "absPath": str(inside(root, rel)),
        "title": title or meta.get("title") or Path(rel).stem,
        "kind": meta.get("kind") or "note",
        "status": meta.get("status"),
        "agents": [str(a) for a in agents]
        if isinstance(agents, list)
        else [str(agents)],
        "updated": meta.get("updated"),
    }


def task_learning(
    project: str, spec_id: str, *, brain: Brain | None = None
) -> dict[str, Any]:
    """What the brain holds about one Kanban task: its build note, and every
    note an agent wrote while working on it.

    Read from the graph (its nodes carry each note's ``tasks``), so opening a
    task panel does not read every file of a large vault. No pull: a panel
    opening is not a reason to wait on the network — the next write or sync
    brings the remote in.
    """
    brain = brain or Brain()
    if not active(brain.root):
        return {
            "active": False,
            "task": f"{project}/{spec_id}",
            "build": None,
            "notes": [],
            "proposals": [],
        }
    if brain.graph_is_stale():
        brain._refresh()
    ref = f"{project}/{spec_id}"
    build_rel = _build_rel(project, spec_id).as_posix()
    build = None
    if inside(brain.root, build_rel).is_file():
        meta = read_note(brain.root, build_rel).meta
        build = {
            **_note_summary(brain.root, build_rel, meta),
            "qa": meta.get("qa"),
            "tests": meta.get("tests"),
            "merged": meta.get("merged"),
        }
    notes = []
    for node in brain.graph().nodes.values():
        meta = node.get("metadata") or {}
        source = node.get("source_file")
        if not source or source == build_rel or ref not in (meta.get("tasks") or []):
            continue
        notes.append(_note_summary(brain.root, source, meta, node.get("label")))
    notes.sort(key=lambda n: (str(n.get("updated") or ""), n["path"]), reverse=True)
    proposals = [
        n for n in notes if n["kind"] == "instruction" and n["status"] == "proposed"
    ]
    return {
        "active": True,
        "task": ref,
        "root": str(brain.root),
        "build": build,
        "notes": notes,
        "proposals": proposals,
    }
