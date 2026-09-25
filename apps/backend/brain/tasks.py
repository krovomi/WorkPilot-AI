"""Which Kanban task a note belongs to — names only, no I/O.

Its own module because everything else needs it: `learn` files builds under
these names, `runtime` stamps what an agent writes during a build, `vault`
links a note to its task's build note. Kept free of every other brain module,
so none of them has to import another to agree on a name — the circular
imports that sharing it through `learn` created.
"""

from __future__ import annotations

from pathlib import Path, PurePath

from .notes import slugify

__all__ = [
    "project_name",
    "project_name_from",
    "project_rel",
    "build_rel",
    "split_task",
    "build_note_id",
    "task_ref",
]


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


def project_rel(project: str) -> Path:
    return Path("knowledge") / "projects" / slugify(project) / "index.md"


def build_rel(project: str, spec_id: str) -> Path:
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
    return build_rel(project, spec).with_suffix("").as_posix()


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
