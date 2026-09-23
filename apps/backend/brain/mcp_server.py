"""The ``workpilot-brain`` MCP server: one brain, every agent.

Stdio transport, JSON-RPC 2.0, one message per line — the transport every MCP
client supports. Written against the protocol rather than an SDK: the server is
launched by *other people's* agents, with whatever Python they find, and a
dependency missing there is a brain nobody can reach. The protocol surface an
MCP tool server needs is four methods.

The tools are the recall ladder and the write path, nothing else:

| Tool | Level / effect |
|---|---|
| `brain_recall` | 1 + 2 — graph hits, their neighbours and their frontmatter |
| `query_graph`, `get_node`, `shortest_path` | 1 — Graphify's own tool names, so a skill written for Graphify's server works here |
| `brain_read_note` | 3 — one note, in full |
| `brain_instructions` | the shared instructions, to apply in addition to the agent's own |
| `brain_skill` | a skill stored in the brain (``graph-first-recall``…) |
| `brain_write_note`, `brain_remember` | write, then commit / pull / push |
| `brain_sync`, `brain_status` | pull + push now; where the brain is and how fresh |

The ``instructions`` field of ``initialize`` carries the rules of use, so an
agent that was never bridged still learns them the moment it connects.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import traceback
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .home import digest_path
from .memories import instructions as list_instructions
from .vault import Brain

__all__ = ["TOOLS", "handle", "serve", "SERVER_INSTRUCTIONS"]

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

SERVER_INSTRUCTIONS = (
    "WorkPilot Brain — le cerveau partagé de tous les agents IA de cet utilisateur "
    "(vault Obsidian + graphe Graphify, synchronisé par git).\n"
    "1. Rappel : graphe d'abord (brain_recall), fichier brut en dernier (brain_read_note) ; "
    "arrête-toi dès que tu as la réponse. Le skill complet : brain_skill('graph-first-recall').\n"
    "2. Instructions : brain_instructions renvoie des règles qui s'appliquent EN PLUS des tiennes. "
    "Similaires aux tiennes : applique les deux. Contradictoires : la plus spécifique (projet, puis agent) "
    "l'emporte.\n"
    "3. Écriture : une décision, une convention ou une préférence durable → brain_write_note ou "
    "brain_remember. Chaque écriture est poussée aux autres agents."
)

_STR = {"type": "string"}


def _schema(props: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": props,
        "required": required or [],
        "additionalProperties": False,
    }


TOOLS: list[dict[str, Any]] = [
    {
        "name": "brain_recall",
        "description": "Rappel graph-first : nœuds du graphe qui correspondent, leurs voisins et leur "
        "frontmatter — sans ouvrir les fichiers. À appeler AVANT brain_read_note.",
        "inputSchema": _schema(
            {
                "query": {**_STR, "description": "le sujet cherché"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20},
            },
            ["query"],
        ),
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "query_graph",
        "description": "Recherche dans graph.json (format Graphify) par label/tags. Niveau 1 du rappel.",
        "inputSchema": _schema(
            {"query": _STR, "limit": {"type": "integer", "minimum": 1, "maximum": 50}},
            ["query"],
        ),
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "get_node",
        "description": "Un nœud du graphe et tous ses voisins.",
        "inputSchema": _schema({"id": _STR}, ["id"]),
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "shortest_path",
        "description": "Le plus court chemin entre deux nœuds du graphe (ids).",
        "inputSchema": _schema({"source": _STR, "target": _STR}, ["source", "target"]),
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "brain_read_note",
        "description": "Niveau 3 : le contenu complet d'une note (chemin relatif = source_file).",
        "inputSchema": _schema({"path": _STR}, ["path"]),
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "brain_instructions",
        "description": "Les instructions partagées actives, à appliquer en plus des tiennes.",
        "inputSchema": _schema(
            {"agent": {**_STR, "description": "ton nom (claude-code, codex, hermes…)"}}
        ),
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "brain_skill",
        "description": "Lire un skill stocké dans le cerveau (sans nom : la liste).",
        "inputSchema": _schema({"name": _STR}),
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "brain_write_note",
        "description": "Créer ou mettre à jour une note (décision, fait, emplacement), puis git push.",
        "inputSchema": _schema(
            {
                "title": _STR,
                "body": {
                    **_STR,
                    "description": "Markdown ; utilise des [[liens]] vers les notes concernées",
                },
                "kind": {"type": "string", "enum": ["knowledge", "instruction"]},
                "tags": {"type": "array", "items": _STR},
                "links": {"type": "array", "items": _STR},
                "agent": _STR,
                "path": {
                    **_STR,
                    "description": "chemin relatif d'une note existante à mettre à jour",
                },
            },
            ["title", "body"],
        ),
    },
    {
        "name": "brain_remember",
        "description": "Ajouter une instruction partagée. Si une instruction similaire existe, elle est "
        "renforcée (ton agent y est ajouté) plutôt que dupliquée. Puis git push.",
        "inputSchema": _schema({"text": _STR, "agent": _STR}, ["text"]),
    },
    {
        "name": "brain_sync",
        "description": "Synchroniser maintenant : commit des modifications locales, git pull, git push.",
        "inputSchema": _schema({}),
    },
    {
        "name": "brain_status",
        "description": "Où est le cerveau, son remote git, le nombre de notes, la fraîcheur du graphe.",
        "inputSchema": _schema({}),
        "annotations": {"readOnlyHint": True},
    },
]


def _skills(brain: Brain, name: str | None) -> Any:
    base = brain.root / "skills"
    if not name:
        return sorted(p.parent.name for p in base.glob("*/SKILL.md"))
    path = base / Path(name).name / "SKILL.md"
    if not path.is_file():
        raise ValueError(f"no skill named {name!r} in the brain")
    return path.read_text(encoding="utf-8")


ORIGIN_ENV = "WORKPILOT_BRAIN_ORIGIN"
"""Set to ``workpilot`` on the server WorkPilot starts for its own agents.

Those agents read issues, PRs and web pages in the same session they write
from, so what they write is untrusted (`Brain.write`): knowledge yes,
instructions only as proposals. A person's own agent — Claude Code, Codex,
hermes connected by `connect.py` — has no such variable and writes as the
person."""


TASK_ENV = "WORKPILOT_BRAIN_TASK"
"""``<project>/<spec-id>`` of the Kanban task the server was started for, so
what an agent writes during a build shows up on that task's card."""


def _trusted_default() -> bool:
    return os.environ.get(ORIGIN_ENV, "").strip().lower() != "workpilot"


def _call(
    brain: Brain,
    name: str,
    args: dict[str, Any],
    *,
    trusted: bool | None = None,
    task: str | None = None,
) -> Any:
    if trusted is None:
        trusted = _trusted_default()
    if task is None:
        task = os.environ.get(TASK_ENV, "").strip() or None
    graph_tools: dict[str, Callable[[], Any]] = {
        "query_graph": lambda: brain.graph().query(
            args["query"], limit=int(args.get("limit", 8))
        ),
        "get_node": lambda: brain.graph().get_node(args["id"]),
        "shortest_path": lambda: brain.graph().shortest_path(
            args["source"], args["target"]
        ),
    }
    if name in graph_tools:
        brain.before_read()
        return graph_tools[name]()
    if name == "brain_recall":
        return brain.recall(args["query"], limit=int(args.get("limit", 5)))
    if name == "brain_read_note":
        return brain.read(args["path"])
    if name == "brain_instructions":
        brain.before_read()
        who = args.get("agent")
        return [
            {**item.to_dict(), "yours": bool(who and who in item.agents)}
            for item in list_instructions(brain.root)
        ]
    if name == "brain_skill":
        brain.before_read()
        return _skills(brain, args.get("name"))
    if name == "brain_write_note":
        return brain.write(
            args["title"],
            args["body"],
            kind=args.get("kind", "knowledge"),
            tags=args.get("tags"),
            links=args.get("links"),
            agent=args.get("agent"),
            path=args.get("path"),
            trusted=trusted,
            task=task,
        ).to_dict()
    if name == "brain_remember":
        return brain.remember(
            args["text"],
            agent=args.get("agent") or "brain",
            trusted=trusted,
            task=task,
        )
    if name == "brain_sync":
        return brain.sync().to_dict()
    if name == "brain_status":
        return brain.status()
    raise KeyError(name)


def _result(msg_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _error(msg_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def handle(brain: Brain, message: dict[str, Any]) -> dict[str, Any] | None:
    """One JSON-RPC message in, at most one out (notifications get none)."""
    method = message.get("method")
    msg_id = message.get("id")
    is_notification = "id" not in message
    params = message.get("params") or {}

    if method == "initialize":
        asked = params.get("protocolVersion")
        version = asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        if not brain.exists:
            brain.init()
        return _result(
            msg_id,
            {
                "protocolVersion": version,
                "capabilities": {
                    "tools": {"listChanged": False},
                    "resources": {"listChanged": False},
                },
                "serverInfo": {"name": "workpilot-brain", "version": "1.0.0"},
                "instructions": SERVER_INSTRUCTIONS,
            },
        )
    if is_notification:
        return None
    if method == "ping":
        return _result(msg_id, {})
    if method == "tools/list":
        return _result(msg_id, {"tools": TOOLS})
    if method == "resources/list":
        resources = [
            {
                "uri": "brain://INSTRUCTIONS.md",
                "name": "Instructions partagées",
                "mimeType": "text/markdown",
            }
        ]
        resources += [
            {
                "uri": f"brain://skills/{name}",
                "name": f"skill {name}",
                "mimeType": "text/markdown",
            }
            for name in _skills(brain, None)
        ]
        return _result(msg_id, {"resources": resources})
    if method == "resources/read":
        uri = str(params.get("uri", ""))
        try:
            if uri == "brain://INSTRUCTIONS.md":
                brain.before_read()
                text = digest_path(brain.root).read_text(encoding="utf-8")
            elif uri.startswith("brain://skills/"):
                text = _skills(brain, uri.removeprefix("brain://skills/"))
            else:
                return _error(msg_id, -32602, f"unknown resource {uri}")
        except (OSError, ValueError) as exc:
            return _error(msg_id, -32602, str(exc))
        return _result(
            msg_id,
            {"contents": [{"uri": uri, "mimeType": "text/markdown", "text": text}]},
        )
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if not any(tool["name"] == name for tool in TOOLS):
            return _error(msg_id, -32602, f"unknown tool {name}")
        try:
            payload = _call(brain, str(name), args)
        except (KeyError, ValueError, OSError) as exc:
            detail = (
                f"missing argument {exc}" if isinstance(exc, KeyError) else str(exc)
            )
            return _result(
                msg_id, {"content": [{"type": "text", "text": detail}], "isError": True}
            )
        text = (
            payload
            if isinstance(payload, str)
            else json.dumps(payload, ensure_ascii=False, indent=1, default=str)
        )
        return _result(
            msg_id, {"content": [{"type": "text", "text": text}], "isError": False}
        )
    return _error(msg_id, -32601, f"method not found: {method}")


def _utf8(stream):
    """The stdio stream, in UTF-8 with bare ``\n`` line ends.

    MCP's stdio transport is UTF-8, and the platform default is not: on
    Windows it is cp1252, so the first reply carrying an accent or an arrow
    raised ``UnicodeEncodeError`` and the server died before answering
    ``initialize`` — to every agent on the machine.
    """
    try:
        stream.reconfigure(encoding="utf-8", errors="replace", newline="\n")
    except (AttributeError, ValueError) as exc:
        # Not a TextIOWrapper (a test's StringIO): already text, nothing to do.
        logging.getLogger(__name__).debug("stdio left as is: %s", exc)
    return stream


def serve(brain: Brain | None = None, stdin=None, stdout=None) -> None:
    """Read JSON-RPC lines from stdin until EOF. Logs go to stderr, never stdout."""
    brain = brain or Brain()
    if stdin is None:
        stdin = _utf8(sys.stdin)
    if stdout is None:
        stdout = _utf8(sys.stdout)
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            reply: dict[str, Any] | None = _error(None, -32700, "parse error")
        else:
            try:
                reply = (
                    handle(brain, message)
                    if isinstance(message, dict)
                    else _error(None, -32600, "invalid request")
                )
            except Exception as exc:  # noqa: BLE001 - one bad call must not kill every agent's brain
                traceback.print_exc(file=sys.stderr)
                reply = _error(
                    message.get("id") if isinstance(message, dict) else None,
                    -32603,
                    str(exc),
                )
        if reply is not None:
            stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            stdout.flush()
