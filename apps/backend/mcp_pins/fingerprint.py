"""What a tool and a server are, for pinning: a hash of what the model reads.

A tool's fingerprint covers its name, its description, its input schema (the
descriptions of its parameters are read by the model too, and are where a
poisoned instruction hides as easily) and its annotations, in canonical JSON.
A server's configuration fingerprint covers what decides which program
answers (command, arguments, URL) and the *names* of its environment
variables and headers, never their values: those are credentials.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

__all__ = ["ToolSnapshot", "config_digest", "schema_text", "tool_snapshot"]


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ToolSnapshot:
    name: str
    description: str
    input_schema: dict = field(default_factory=dict)
    annotations: dict = field(default_factory=dict)

    @property
    def digest(self) -> str:
        return _sha(
            _canonical(
                {
                    "name": self.name,
                    "description": self.description,
                    "inputSchema": self.input_schema,
                    "annotations": self.annotations,
                }
            )
        )

    def as_record(self) -> dict:
        return {
            "digest": self.digest,
            "description": self.description,
            "inputSchema": self.input_schema,
        }


def tool_snapshot(tool: Any) -> ToolSnapshot | None:
    """A listed MCP tool (SDK object or dict) as a snapshot; None without a name."""

    def get(*names: str) -> Any:
        for name in names:
            value = (
                tool.get(name) if isinstance(tool, dict) else getattr(tool, name, None)
            )
            if value is not None:
                return value
        return None

    name = get("name")
    if not isinstance(name, str) or not name:
        return None
    schema = get("inputSchema", "input_schema")
    annotations = get("annotations")
    if annotations is not None and not isinstance(annotations, dict):
        dump = getattr(annotations, "model_dump", None)
        annotations = dump(exclude_none=True) if callable(dump) else {}
    return ToolSnapshot(
        name=name,
        description=str(get("description") or ""),
        input_schema=schema if isinstance(schema, dict) else {},
        annotations=annotations or {},
    )


def schema_text(schema: Any) -> str:
    """Every string a schema holds (titles, descriptions, enum values), joined."""
    found: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, str):
            found.append(node)
        elif isinstance(node, dict):
            for key, value in node.items():
                found.append(str(key))
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(schema)
    return "\n".join(found)


def config_digest(config: dict) -> str:
    """Which program answers for this server, credentials left out."""
    return _sha(
        _canonical(
            {
                "type": config.get("type") or "command",
                "command": config.get("command") or "",
                "args": [str(a) for a in config.get("args") or []],
                "url": config.get("url") or "",
                "env": sorted((config.get("env") or {}).keys()),
                "headers": sorted((config.get("headers") or {}).keys()),
            }
        )
    )
