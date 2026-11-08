"""Write the cards a split plan becomes, and close the card it came from.

Each slice becomes a sibling spec directory, ``<parent>-part<k>``: a copy of
the parent's spec (what the person asked, the context the pipeline found),
with an implementation plan that holds only the slice's phases, a note at the
top of ``spec.md`` that says which part this is, and in ``task_metadata.json``
the group it belongs to (``splitGroup``) and the part it waits for
(``blockedBy``). The children are approved for build, since the parent's spec
was (the build only runs past its approval check), and queued.

The parent keeps the original spec and plan, gets ``splitGroup`` with its
children, and is archived with its plan settled ``done``: its work is now its
children's, and an archived card is off the board and out of the queue's
counts while staying readable from the archive.

Everything is plain files, in the project's ``.workpilot/specs``: the desktop
board, the server's index and the phone read the same directories.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from review.state import ReviewState
from tasks.classify import classify

from .policy import resolve_policy
from .slices import Slice, plan_slices

__all__ = ["CHILD_SUFFIX", "SplitResult", "child_spec_id", "split_spec"]

CHILD_SUFFIX = "-part"
_SPEC_NAME_MAX = 128
#: What follows ``NNN-`` in a server card id.
_CARD_TAIL_MAX = 81
PLAN_FILE = "implementation_plan.json"
METADATA_FILE = "task_metadata.json"

#: What a build writes into a spec directory: never copied into a child.
_BUILD_OUTPUTS = {
    PLAN_FILE,
    METADATA_FILE,
    "review_state.json",
    "task_logs.json",
    "pause_state.json",
    "goal_result.json",
    "qa_report.md",
    "QA_FIX_REQUEST.md",
    "build-progress.txt",
    "attempt_history.json",
    "best_of_n.json",
    "memory",
    "logs",
    "plans",
    "events.jsonl",
}
#: Card state the parent has and its children must not inherit.
_PARENT_ONLY_KEYS = (
    "archivedAt",
    "archivedInVersion",
    "prUrl",
    "paused",
    "splitGroup",
    "bestOfN",
    "blockedBy",
    "stackParent",
    "stackParentSha",
    "stackTrunk",
    "useLocalBranch",
    "duplicatedFrom",
    "abandoned",
    "abandonedAt",
    "abandonedReason",
)
#: Status fields of a plan, written by the board: a child starts from none.
_PLAN_STATE_KEYS = (
    "status",
    "planStatus",
    "xstateState",
    "executionPhase",
    "reviewReason",
    "errorMessage",
    "qa_signoff",
    "recoveryNote",
    "lastEvent",
    "stagedInMainProject",
    "stagedAt",
)


class SplitError(RuntimeError):
    """A split that cannot be written; the card is then built whole."""


@dataclass
class SplitChild:
    spec_id: str
    title: str
    name: str
    index: int
    lines: int
    after: str | None


@dataclass
class SplitResult:
    parent: str
    title: str
    max_lines: int
    children: list[SplitChild] = field(default_factory=list)

    def to_event(self) -> dict[str, Any]:
        """The ``TASK_SPLIT`` payload the board reads."""
        return {
            "parent": self.parent,
            "total": len(self.children),
            "maxLines": self.max_lines,
            "children": [
                {
                    "specId": c.spec_id,
                    "index": c.index,
                    "name": c.name,
                    "lines": c.lines,
                    "after": c.after,
                }
                for c in self.children
            ],
        }


def child_spec_id(parent: str, index: int) -> str:
    """``<parent>-part<k>``, a card id the server board accepts too.

    The server's card ids are ``^\\d{3,4}-[a-z0-9][a-z0-9-]{0,80}$``
    (``board_mcp.server.CARD_ID``): the parent's name is cut so that the
    suffix fits, and a cut never leaves a trailing dash.
    """
    suffix = f"{CHILD_SUFFIX}{index}"
    head, _, tail = parent.partition("-")
    room = (_CARD_TAIL_MAX if head.isdigit() and tail else _SPEC_NAME_MAX) - len(suffix)
    if head.isdigit() and tail:
        return f"{head}-{tail[:room].rstrip('-')}{suffix}"
    return parent[:room].rstrip("-") + suffix


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json(path: Path, data: dict) -> None:
    partial = path.with_name(path.name + ".partial")
    partial.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(partial, path)


def _title(spec_dir: Path, plan: dict) -> str:
    requirements = _read_json(spec_dir / "requirements.json")
    for value in (
        requirements.get("display_title"),
        plan.get("feature"),
        plan.get("title"),
    ):
        if isinstance(value, str) and value.strip():
            return " ".join(value.split())[:160]
    try:
        spec = (spec_dir / "spec.md").read_text(encoding="utf-8")
    except OSError:
        spec = ""
    match = re.search(r"^#\s+(?:Quick Spec:|Specification:)?\s*(.+)$", spec, re.M)
    return match.group(1).strip()[:160] if match else spec_dir.name


def _scope_note(index: int, total: int, title: str, parent: str, item: Slice) -> str:
    names = ", ".join(
        f"**{str(p.get('name') or p.get('id') or '?').strip()}**" for p in item.phases
    )
    return (
        f'> **Part {index} of {total}** of the task "{title}" (`{parent}`), '
        "split so that each pull request stays small enough to review.\n"
        f"> This card builds only the phases of its implementation plan: {names}. "
        "The other parts are separate cards and pull requests: do not implement "
        "them here, and do not count what they cover as missing.\n\n"
    )


def _child_plan(plan: dict, item: Slice, title: str, index: int, total: int) -> dict:
    child = {k: v for k, v in plan.items() if k not in _PLAN_STATE_KEYS}
    keys = {
        str(p.get("id") if p.get("id") is not None else p.get("phase"))
        for p in item.phases
    }
    phases = []
    for phase in item.phases:
        phase = dict(phase)
        refs = phase.get("depends_on")
        if isinstance(refs, list):
            # Only the phases of this card: the others are its blocker's.
            phase["depends_on"] = [r for r in refs if str(r) in keys]
        phase.pop("chunks", None)
        subtasks = []
        for subtask in phase.get("subtasks") or []:
            subtask = dict(subtask)
            subtask["status"] = "pending"
            subtasks.append(subtask)
        phase["subtasks"] = subtasks
        phases.append(phase)
    child.update(
        {
            "feature": f"{title} ({index}/{total}): {item.name}",
            "phases": phases,
            "status": "queue",
            "planStatus": "queued",
            "created_at": datetime.now(UTC).isoformat(),
        }
    )
    child.pop("updated_at", None)
    return child


def _copy_spec(parent_dir: Path, child_dir: Path) -> None:
    for entry in parent_dir.rglob("*"):
        if entry.is_symlink():
            raise SplitError(
                f"the spec contains a symbolic link ({entry.relative_to(parent_dir)})"
            )

    def ignore(directory: str, names: list[str]) -> set[str]:
        if Path(directory) == parent_dir:
            return {n for n in names if n in _BUILD_OUTPUTS or n.endswith(".partial")}
        return set()

    shutil.copytree(parent_dir, child_dir, ignore=ignore)


def _write_child(
    parent_dir: Path,
    child_dir: Path,
    *,
    plan: dict,
    metadata: dict,
    item: Slice,
    title: str,
    total: int,
    after: str | None,
) -> SplitChild:
    _copy_spec(parent_dir, child_dir)
    child_title = f"{title} ({item.index}/{total}): {item.name}"
    spec = child_dir / "spec.md"
    try:
        original = spec.read_text(encoding="utf-8")
    except OSError:
        original = ""
    spec.write_text(
        _scope_note(item.index, total, title, parent_dir.name, item) + original,
        encoding="utf-8",
    )
    requirements = _read_json(child_dir / "requirements.json")
    if requirements:
        requirements["display_title"] = child_title
        _write_json(child_dir / "requirements.json", requirements)
    child_metadata = {k: v for k, v in metadata.items() if k not in _PARENT_ONLY_KEYS}
    child_metadata["splitGroup"] = {
        "parent": parent_dir.name,
        "title": title,
        "index": item.index,
        "total": total,
        "name": item.name,
    }
    if after:
        child_metadata["blockedBy"] = [after]
    _write_json(child_dir / METADATA_FILE, child_metadata)
    _write_json(
        child_dir / PLAN_FILE, _child_plan(plan, item, title, item.index, total)
    )
    ReviewState().approve(child_dir, approved_by="auto-split")
    return SplitChild(
        child_dir.name, child_title, item.name, item.index, item.lines, after
    )


def split_spec(
    spec_dir: Path,
    *,
    plan_dir: Path | None = None,
    env: dict[str, str] | None = None,
) -> SplitResult | None:
    """Split the card of ``spec_dir`` when its plan is too big; None otherwise.

    ``spec_dir`` is the card's directory in the project's specs; ``plan_dir``
    the copy the plan was written in, when the build runs in a worktree (it is
    closed too, so the worktree's copy does not say the card is still to do).
    Raises ``SplitError`` when the children cannot be written; whatever was
    written is removed first.
    """
    spec_dir = Path(spec_dir)
    metadata = _read_json(spec_dir / METADATA_FILE)
    if metadata.get("splitGroup") or metadata.get("bestOfN"):
        return None
    plan = _read_json((plan_dir or spec_dir) / PLAN_FILE)
    kind = (
        metadata.get("kind")
        or classify(_title(spec_dir, plan), "", metadata).kind.value
    )
    policy = resolve_policy(metadata, env, kind=str(kind))
    slices = plan_slices(plan, policy)
    if not slices:
        return None
    total = len(slices)
    ids = {s.index: child_spec_id(spec_dir.name, s.index) for s in slices}
    root = spec_dir.parent
    taken = [i for i in ids.values() if (root / i).exists() or (root / i).is_symlink()]
    if taken:
        raise SplitError(f"{taken[0]} already exists; remove it to split this task")
    title = _title(spec_dir, plan)
    result = SplitResult(spec_dir.name, title, policy.max_lines)
    try:
        for item in slices:
            result.children.append(
                _write_child(
                    spec_dir,
                    root / ids[item.index],
                    plan=plan,
                    metadata=metadata,
                    item=item,
                    title=title,
                    total=total,
                    after=ids[item.after] if item.after else None,
                )
            )
    except (OSError, SplitError) as exc:
        for spec_id in ids.values():
            shutil.rmtree(root / spec_id, ignore_errors=True)
        raise SplitError(f"the parts could not be written: {exc}") from exc

    now = datetime.now(UTC).isoformat()
    metadata["splitGroup"] = {
        "children": [c.spec_id for c in result.children],
        "total": total,
        "maxLines": policy.max_lines,
        "source": policy.source,
        "kind": policy.kind,
        "splitAt": now,
    }
    metadata["archivedAt"] = now
    _write_json(spec_dir / METADATA_FILE, metadata)
    for directory in {spec_dir, plan_dir or spec_dir}:
        settled = _read_json(directory / PLAN_FILE) or plan
        settled.update(
            {
                "status": "done",
                "planStatus": "completed",
                "xstateState": "done",
                "split": result.to_event(),
                "updated_at": now,
            }
        )
        _write_json(directory / PLAN_FILE, settled)
        if directory != spec_dir and (directory / METADATA_FILE).is_file():
            _write_json(directory / METADATA_FILE, metadata)
    return result
