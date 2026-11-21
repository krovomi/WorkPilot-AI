"""The render loop's corrections, answered in a forced schema (#379).

A correction's answer is a list of edits. Where ``core`` can carry a picture
and impose the shape of the answer, the model is not asked for JSON in its
text: the Claude subscription goes through ``core.simple_client`` with the
composite picture as an image block and ``output_format`` set to the edits'
JSON schema, which the SDK validates and retries (its structured output is a
forced tool call). The structured answer is returned as JSON text, so
``feedback.parse_answer`` checks it as it checks any answer; a model that
answers in text anyway is read the same way.

The other routes keep the JSON-in-text answer of the service's vision calls:
``core``'s agent clients send text prompts only, and the SDK path needs the
Claude Code sign-in, which an API key alone is not.

The client is ``commit_message``'s type: no tool at all, so nothing the model
reads on the picture can make it open a file or run a command.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from design_to_code.budget import Usage, read_usage

EDITS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "edits": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "find": {"type": "string"},
                    "replace": {"type": "string"},
                },
                "required": ["path", "find", "replace"],
            },
        },
        "notes": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["edits"],
}
#: The SDK's structured output: validated against the schema, retried once.
OUTPUT_FORMAT: dict[str, Any] = {"type": "json_schema", "schema": EDITS_SCHEMA}
#: The structured output is a tool call, then its result: two turns.
MAX_TURNS = 2
#: Routes answered here (the others keep the service's text calls).
SCHEMA_ROUTES = frozenset({"claude_subscription"})


@dataclass(frozen=True)
class EditAnswer:
    """The answer as text (the structured output as JSON when there was one)."""

    text: str
    usage: Usage | None
    structured: bool


async def ask_claude_for_edits(
    model: str, prompt: str, png: bytes, *, project_path: Path | str
) -> EditAnswer:
    """One correction through the Claude Code sign-in, its answer in the schema."""
    from core.simple_client import create_simple_client

    client = create_simple_client(
        agent_type="commit_message",
        model=model,
        cwd=Path(project_path),
        max_turns=MAX_TURNS,
        output_format=OUTPUT_FORMAT,
    )

    async def message():
        yield {
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": base64.b64encode(png).decode("ascii"),
                        },
                    },
                    {"type": "text", "text": prompt},
                ],
            },
            "parent_tool_use_id": None,
        }

    chunks: list[str] = []
    structured: object = None
    usage: Usage | None = None
    async with client:
        await client.query(message())
        async for msg in client.receive_response():
            if hasattr(msg, "total_cost_usd"):  # the closing ResultMessage
                structured = getattr(msg, "structured_output", None)
                usage = read_usage(getattr(msg, "usage", None))
            for block in getattr(msg, "content", None) or []:
                text = getattr(block, "text", None)
                if isinstance(text, str):
                    chunks.append(text)
    if isinstance(structured, dict):
        return EditAnswer(json.dumps(structured), usage, True)
    return EditAnswer("".join(chunks).strip(), usage, False)
