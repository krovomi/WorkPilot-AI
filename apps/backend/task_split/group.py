"""What tells a person that a PR belongs to a split group, on every surface.

The parts of one split share a colour, a label and a written mark, the same
on the board, the phone and the forge:

- the colour: one of six charter tones, picked by a hash of the group's id
  (the split task's spec folder), so every machine and every surface agrees
  without storing it; ``task-split.ts`` and the phone use the same hash;
- the label: ``groupe/<group id>`` on GitHub and GitLab, in that colour;
- the title: ``[<group title> k/N] <part name>``;
- a section of the PR body that lists the group's parts and their PRs.

Pure apart from reading the part's and its siblings' ``task_metadata.json``.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

__all__ = [
    "GROUP_COLORS",
    "GROUP_TONES",
    "LABEL_PREFIX",
    "PartGroup",
    "group_label",
    "group_section",
    "group_title",
    "group_tone",
    "part_group",
]

#: The charter's tones a group can take, in the order the hash indexes them
#: (``components/charter``; red is kept for errors, the accent for actions).
GROUP_TONES = ("blue", "violet", "green", "amber", "pink", "orange")
#: The charter's light values, for a forge label (no ``#``, as GitHub wants).
GROUP_COLORS = {
    "blue": "2f6fd6",
    "violet": "7b55e0",
    "green": "0f8f6a",
    "amber": "b07a00",
    "pink": "c2416b",
    "orange": "d9581f",
}
LABEL_PREFIX = "groupe/"
#: GitHub refuses a label name above 50 characters.
_LABEL_MAX = 50
_TITLE_MAX = 40


def group_tone(group_id: str) -> str:
    """The group's tone: FNV-1a (32 bits) of its id's UTF-8 bytes, modulo six."""
    value = 0x811C9DC5
    for byte in str(group_id).encode("utf-8"):
        value ^= byte
        value = (value * 0x01000193) & 0xFFFFFFFF
    return GROUP_TONES[value % len(GROUP_TONES)]


def group_label(group_id: str) -> str:
    return (LABEL_PREFIX + str(group_id))[:_LABEL_MAX].rstrip("-")


@dataclass(frozen=True)
class Sibling:
    index: int
    spec_id: str
    name: str
    pr_url: str | None


@dataclass(frozen=True)
class PartGroup:
    """A part of a split, and the group it belongs to."""

    group_id: str
    title: str
    index: int
    total: int
    name: str
    after: str | None = None
    siblings: list[Sibling] = field(default_factory=list)

    @property
    def tone(self) -> str:
        return group_tone(self.group_id)

    @property
    def color(self) -> str:
        return GROUP_COLORS[self.tone]

    @property
    def label(self) -> str:
        return group_label(self.group_id)


def _metadata(spec_dir: Path) -> dict[str, Any]:
    try:
        data = json.loads((spec_dir / "task_metadata.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _clip(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _url(value: Any) -> str | None:
    text = str(value or "")
    return text if text.startswith("https://") and " " not in text else None


def part_group(spec_dir: Path) -> PartGroup | None:
    """The group of the card in ``spec_dir``, or None when it is not a part."""
    spec_dir = Path(spec_dir)
    metadata = _metadata(spec_dir)
    group = metadata.get("splitGroup")
    if not isinstance(group, dict):
        return None
    parent, index, total = group.get("parent"), group.get("index"), group.get("total")
    if not (
        isinstance(parent, str)
        and parent
        and isinstance(index, int)
        and isinstance(total, int)
        and 1 <= index <= total
    ):
        return None
    blocked = metadata.get("blockedBy")
    after = blocked[0] if isinstance(blocked, list) and blocked else None
    children = _metadata(spec_dir.parent / parent).get("splitGroup", {})
    siblings: list[Sibling] = []
    names = children.get("children") if isinstance(children, dict) else None
    for spec_id in names if isinstance(names, list) else []:
        if not isinstance(spec_id, str) or "/" in spec_id or "\\" in spec_id:
            continue
        sibling = _metadata(spec_dir.parent / spec_id)
        info = sibling.get("splitGroup")
        if not isinstance(info, dict) or not isinstance(info.get("index"), int):
            continue
        siblings.append(
            Sibling(
                info["index"],
                spec_id,
                _clip(info.get("name"), 80),
                _url(sibling.get("prUrl")),
            )
        )
    siblings.sort(key=lambda s: s.index)
    return PartGroup(
        parent,
        _clip(group.get("title") or parent, 200),
        index,
        total,
        _clip(group.get("name"), 80),
        after if isinstance(after, str) else None,
        siblings,
    )


def group_title(title: str, group: PartGroup) -> str:
    """``[<group title> k/N] <rest>``, once; the part's own title says the rest."""
    short = _clip(group.title, _TITLE_MAX)
    prefix = f"[{short} {group.index}/{group.total}]"
    title = " ".join(str(title or "").split())
    if title.startswith(prefix):
        return title
    # A part's title is "<group title> (k/N): <name>": keep only the name.
    head = f"{group.title} ({group.index}/{group.total})"
    if title.startswith(head):
        title = title[len(head) :].lstrip(" :-") or group.name
    return f"{prefix} {title or group.name}".strip()


_STRINGS = {
    "en": {
        "heading": "PR group",
        "intro": "This PR is part {index} of {total} of “{title}” (label `{label}`).",
        "after": "It builds on part {after}: review that one first.",
        "part": "Part",
        "task": "Task",
        "pr": "PR",
        "this": "this PR",
        "none": "not opened yet",
    },
    "fr": {
        "heading": "Groupe de PR",
        "intro": "Cette PR est la partie {index} sur {total} de « {title} » (label `{label}`).",
        "after": "Elle s'appuie sur la partie {after} : relisez celle-là d'abord.",
        "part": "Partie",
        "task": "Tâche",
        "pr": "PR",
        "this": "cette PR",
        "none": "pas encore ouverte",
    },
}


def group_section(group: PartGroup, language: str | None = None) -> str:
    """The body section that lists the group's parts, in the app's language."""
    lang = (language or os.environ.get("APP_LANGUAGE") or "en").split("-")[0]
    s = _STRINGS.get(lang, _STRINGS["en"])
    title = group.title.replace("`", "'").replace("|", "/")
    lines = [
        f"## {s['heading']}",
        "",
        s["intro"].format(
            index=group.index, total=group.total, title=title, label=group.label
        ),
    ]
    before = next((x for x in group.siblings if x.spec_id == group.after), None)
    if before is not None:
        lines.append(s["after"].format(after=before.index))
    if group.siblings:
        lines += ["", f"| {s['part']} | {s['task']} | {s['pr']} |", "|---|---|---|"]
        for sibling in group.siblings:
            name = sibling.name.replace("|", "/") or sibling.spec_id
            if sibling.index == group.index:
                link = f"**{s['this']}**"
            else:
                link = sibling.pr_url or s["none"]
            lines.append(f"| {sibling.index}/{group.total} | {name} | {link} |")
    return "\n".join(lines) + "\n"
