"""The brain as a graph, in the format Graphify writes.

Graphify's ``graph.json`` is networkx's node-link document — ``nodes`` with
``id``, ``label``, ``file_type``, ``source_file``, ``metadata``, and ``links``
with ``source`` and ``target`` — and it is the file the ``graph-first-recall``
skill queries before opening anything. Writing the brain's graph in that exact
shape is what makes the skill, Graphify's own MCP server and any tool that
reads node-link JSON work on the brain unchanged.

Building it costs no model call: notes are nodes, ``[[links]]`` and tags are
edges, frontmatter is metadata. That is also why it can be rebuilt after every
write.

**A graph Graphify built is not ours to overwrite.** A person may run Graphify
over the vault (or over a codebase) into the same file. Every node written here
carries ``metadata.origin = "workpilot-brain"``; a rebuild replaces those and
keeps every other node and every link between them, so the two builders share
one file instead of taking turns destroying it.
"""

from __future__ import annotations

import json
import os
import tempfile
from collections import deque
from dataclasses import dataclass
from datetime import date, time
from pathlib import Path
from typing import Any

from .home import graph_path
from .notes import iter_notes, read_note

__all__ = [
    "ORIGIN",
    "BrainGraph",
    "build_graph",
    "write_graph",
    "load_graph",
    "rebuild",
]

ORIGIN = "workpilot-brain"


def _plain(value: Any) -> Any:
    """*value* as something ``json`` writes: frontmatter is a person's YAML.

    Obsidian writes ``date: 2024-01-01`` and ``created: 2024-01-01T10:00``
    into daily notes, templates and properties, and YAML reads both as
    ``date``/``datetime`` objects. One such note in a vault a person plugged
    in made the graph unwritable, and every write, sync and settings save
    after it answered 500.
    """
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, (date, time)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_plain(v) for v in value]
    return str(value)


def _str_list(value: Any) -> list[str]:
    """``tasks`` and ``agents`` as the list every reader treats them as."""
    if value is None or value == "":
        return []
    items = value if isinstance(value, (list, tuple, set)) else [value]
    return [str(_plain(item)) for item in items if item is not None]


def _is_ours(node: dict[str, Any]) -> bool:
    meta = node.get("metadata")
    return isinstance(meta, dict) and meta.get("origin") == ORIGIN


def build_graph(root: Path) -> dict[str, Any]:
    """Nodes and links for every note under *root*, in node-link form."""
    notes = []
    for rel in iter_notes(root):
        try:
            notes.append(read_note(root, rel))
        except OSError:
            continue

    by_stem: dict[str, str] = {}
    by_title: dict[str, str] = {}
    nodes: list[dict[str, Any]] = []
    for note in notes:
        node_id = note.rel[:-3] if note.rel.endswith(".md") else note.rel
        by_stem.setdefault(note.stem.lower(), node_id)
        by_stem.setdefault(node_id.lower(), node_id)
        by_title.setdefault(note.title.lower(), node_id)
        meta = {
            "origin": ORIGIN,
            "kind": note.kind,
            "tags": note.tags,
        }
        for key in (
            "status",
            "tasks",
            "agents",
            "updated",
            "created",
            "scope",
            "description",
        ):
            if key in note.meta:
                value = note.meta[key]
                meta[key] = (
                    _str_list(value) if key in ("tasks", "agents") else _plain(value)
                )
        nodes.append(
            {
                "id": node_id,
                "label": note.title,
                "file_type": "document",
                "source_file": note.rel,
                "metadata": meta,
            }
        )

    links: list[dict[str, Any]] = []
    tag_nodes: dict[str, dict[str, Any]] = {}
    missing: dict[str, dict[str, Any]] = {}
    for note, node in zip(notes, nodes):
        for target in note.links:
            key = target.lower().removesuffix(".md")
            dest = by_stem.get(key) or by_title.get(key)
            if dest is None:
                # Obsidian draws an unresolved link as a ghost node; so do we,
                # because "something references X and nobody wrote X" is a fact
                # recall should be able to answer.
                dest = f"missing:{target}"
                missing.setdefault(
                    dest,
                    {
                        "id": dest,
                        "label": target,
                        "file_type": "missing",
                        "source_file": None,
                        "metadata": {"origin": ORIGIN, "kind": "missing"},
                    },
                )
            if dest != node["id"]:
                links.append(
                    {"source": node["id"], "target": dest, "relation": "links_to"}
                )
        for tag in note.tags:
            tag_id = f"tag:{tag}"
            tag_nodes.setdefault(
                tag_id,
                {
                    "id": tag_id,
                    "label": f"#{tag}",
                    "file_type": "tag",
                    "source_file": None,
                    "metadata": {"origin": ORIGIN, "kind": "tag"},
                },
            )
            links.append({"source": node["id"], "target": tag_id, "relation": "tagged"})

    return {
        "directed": True,
        "multigraph": False,
        "graph": {"generator": ORIGIN},
        "nodes": nodes + list(tag_nodes.values()) + list(missing.values()),
        "links": links,
    }


def load_graph(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"nodes": [], "links": []}
    if not isinstance(data, dict):
        return {"nodes": [], "links": []}
    data.setdefault("nodes", [])
    data.setdefault("links", data.pop("edges", []))
    return data


def write_graph(root: Path, fresh: dict[str, Any]) -> Path:
    """Merge *fresh* over whatever else is in the file, and write it atomically."""
    path = graph_path(root)
    existing = load_graph(path) if path.is_file() else {"nodes": [], "links": []}
    foreign = [
        n for n in existing.get("nodes", []) if isinstance(n, dict) and not _is_ours(n)
    ]
    ours_ids = {
        n["id"]
        for n in existing.get("nodes", [])
        if isinstance(n, dict) and _is_ours(n)
    }
    kept_links = [
        link
        for link in existing.get("links", [])
        if isinstance(link, dict)
        and link.get("source") not in ours_ids
        and link.get("target") not in ours_ids
    ]
    merged = dict(existing)
    merged.update({k: v for k, v in fresh.items() if k not in ("nodes", "links")})
    merged["nodes"] = foreign + fresh["nodes"]
    merged["links"] = kept_links + fresh["links"]

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".graph-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            # ``default=str``: a graph Graphify wrote, merged in above, is not
            # ours to vet, and a node it cannot encode must not lose the file.
            json.dump(merged, handle, ensure_ascii=False, indent=1, default=str)
            handle.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return path


def rebuild(root: Path) -> Path:
    return write_graph(root, build_graph(root))


@dataclass
class BrainGraph:
    """Read-side of the graph: the queries the recall skill runs, as methods.

    Named after Graphify's own MCP tools (``query_graph``, ``get_node``,
    ``shortest_path``) so a skill written against either answers the same way.
    """

    data: dict[str, Any]

    @classmethod
    def load(cls, root: Path) -> BrainGraph:
        return cls(load_graph(graph_path(root)))

    def __post_init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {
            str(n["id"]): n
            for n in self.data.get("nodes", [])
            if isinstance(n, dict) and "id" in n
        }
        self.adj: dict[str, list[tuple[str, str]]] = {}
        for link in self.data.get("links", []):
            if not isinstance(link, dict):
                continue
            src, dst = str(link.get("source")), str(link.get("target"))
            rel = str(link.get("relation") or "links_to")
            self.adj.setdefault(src, []).append((dst, rel))
            self.adj.setdefault(dst, []).append((src, f"~{rel}"))

    def neighbors(self, node_id: str, limit: int = 12) -> list[dict[str, Any]]:
        out = []
        for other, rel in self.adj.get(node_id, [])[:limit]:
            node = self.nodes.get(other, {"id": other, "label": other})
            out.append(
                {"id": other, "label": node.get("label", other), "relation": rel}
            )
        return out

    def query(self, text: str, limit: int = 8) -> list[dict[str, Any]]:
        """Nodes whose label, id or tags match every word of *text*."""
        words = [w for w in text.lower().split() if w]
        if not words:
            return []
        scored = []
        for node in self.nodes.values():
            if node.get("file_type") in ("tag", "missing"):
                continue
            meta = node.get("metadata") or {}
            label = str(node.get("label", "")).lower()
            hay = " ".join(
                [
                    label,
                    str(node.get("id", "")).lower(),
                    " ".join(map(str, meta.get("tags") or [])),
                ]
            )
            if not all(w in hay for w in words):
                continue
            score = (
                sum(3 if w in label else 1 for w in words)
                + min(len(self.adj.get(node["id"], [])), 10) / 10
            )
            scored.append((score, node))
        scored.sort(key=lambda pair: (-pair[0], str(pair[1].get("id"))))
        return [
            {
                "id": node["id"],
                "label": node.get("label"),
                "source_file": node.get("source_file"),
                "kind": (node.get("metadata") or {}).get("kind"),
                "neighbors": self.neighbors(node["id"], limit=8),
            }
            for _, node in scored[:limit]
        ]

    def get_node(self, node_id: str) -> dict[str, Any] | None:
        node = self.nodes.get(node_id)
        if node is None:
            return None
        return {**node, "neighbors": self.neighbors(node_id, limit=50)}

    def shortest_path(
        self, source: str, target: str, max_depth: int = 8
    ) -> list[str] | None:
        if source not in self.nodes or target not in self.nodes:
            return None
        prev: dict[str, str | None] = {source: None}
        queue = deque([(source, 0)])
        while queue:
            current, depth = queue.popleft()
            if current == target:
                path = [current]
                while prev[path[-1]] is not None:
                    path.append(prev[path[-1]])  # type: ignore[arg-type]
                return list(reversed(path))
            if depth >= max_depth:
                continue
            for other, _ in self.adj.get(current, []):
                if other not in prev:
                    prev[other] = current
                    queue.append((other, depth + 1))
        return None
