"""The render loop's corrections, answered in a forced schema (#379).

A correction's answer is a list of edits. Where ``core`` can carry a picture
and impose the shape of the answer, the model is not asked for JSON in its
text: the Claude subscription goes through ``core.simple_client`` with the
composite picture as an image block and ``output_format`` set to the edits'
JSON schema, which the SDK validates and retries (its structured output is a
forced tool call). The structured answer is returned as JSON text, so
``feedback.parse_answer`` checks it as it checks any answer; a model that
answers in text anyway is read the same way.

The other routes are the service's own vision calls, which talk to each
provider's HTTP API directly (``core``'s agent clients send text prompts only).
With ``forced=True`` they impose the same schema in each provider's words, from
the request fields and answer readers below: a forced tool for Claude's API
(``tool_choice`` of type ``tool``, answered in ``tool_use.input``), a forced
function for OpenAI (``tool_calls[0].function.arguments``) and Gemini
(``toolConfig`` in mode ``ANY``, answered in ``functionCall.args``), a JSON
schema ``response_format`` for LM Studio and llama.cpp, and Ollama's ``format``
(``docintel.engines.ollama_vision.ask``). A provider that answers in text
anyway is read from its text, as before.

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
#: Routes whose corrections are answered in the schema: all of them (the
#: subscription here, the others through the service's calls with ``forced``).
SCHEMA_ROUTES = frozenset(
    {
        "claude_subscription",
        "claude_api",
        "openai",
        "google",
        "ollama",
        "lm-studio",
        "llama-cpp",
    }
)
#: The forced tool's name and what it is for, in every provider's request.
TOOL_NAME = "submit_edits"
TOOL_DESCRIPTION = (
    "Submit the find-and-replace edits that bring the rendering closer to the "
    "design, and short notes on what they change."
)


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


def anthropic_fields() -> dict[str, Any]:
    """Claude's API: one tool, which the model must call (``tool_choice``)."""
    return {
        "tools": [
            {
                "name": TOOL_NAME,
                "description": TOOL_DESCRIPTION,
                "input_schema": EDITS_SCHEMA,
            }
        ],
        "tool_choice": {"type": "tool", "name": TOOL_NAME},
    }


def openai_fields() -> dict[str, Any]:
    """OpenAI's chat API: one function, which the model must call."""
    return {
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": TOOL_NAME,
                    "description": TOOL_DESCRIPTION,
                    "parameters": EDITS_SCHEMA,
                },
            }
        ],
        "tool_choice": {"type": "function", "function": {"name": TOOL_NAME}},
    }


def _gemini_schema(schema: Any) -> Any:
    """The schema in Gemini's OpenAPI subset: its types are upper-case enums."""
    if isinstance(schema, dict):
        return {
            key: value.upper()
            if key == "type" and isinstance(value, str)
            else _gemini_schema(value)
            for key, value in schema.items()
        }
    if isinstance(schema, list):
        return [_gemini_schema(item) for item in schema]
    return schema


def gemini_fields() -> dict[str, Any]:
    """Gemini: one function declaration, called in mode ``ANY``."""
    return {
        "tools": [
            {
                "functionDeclarations": [
                    {
                        "name": TOOL_NAME,
                        "description": TOOL_DESCRIPTION,
                        "parameters": _gemini_schema(EDITS_SCHEMA),
                    }
                ]
            }
        ],
        "toolConfig": {
            "functionCallingConfig": {
                "mode": "ANY",
                "allowedFunctionNames": [TOOL_NAME],
            }
        },
    }


def local_fields() -> dict[str, Any]:
    """LM Studio and llama.cpp: the answer constrained to the schema."""
    return {
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": TOOL_NAME, "schema": EDITS_SCHEMA},
        }
    }


def _as_text(arguments: object) -> str | None:
    """A tool's arguments as JSON text (some servers send them decoded)."""
    if isinstance(arguments, dict):
        return json.dumps(arguments)
    if isinstance(arguments, str) and arguments.strip():
        return arguments
    return None


def _items(value: object) -> list[dict]:
    return (
        [item for item in value if isinstance(item, dict)]
        if isinstance(value, list)
        else []
    )


def anthropic_answer(data: dict) -> str:
    """``tool_use.input`` of Claude's answer, else its text blocks."""
    blocks = _items(data.get("content"))
    for block in blocks:
        if block.get("type") == "tool_use":
            found = _as_text(block.get("input"))
            if found is not None:
                return found
    return "".join(str(b.get("text") or "") for b in blocks if "text" in b).strip()


def openai_answer(data: dict) -> str:
    """``tool_calls[0].function.arguments`` of the answer, else its text."""
    choices = _items(data.get("choices"))
    message = choices[0].get("message") if choices else None
    if not isinstance(message, dict):
        return ""
    for call in _items(message.get("tool_calls")):
        function = call.get("function")
        if isinstance(function, dict):
            found = _as_text(function.get("arguments"))
            if found is not None:
                return found
    return str(message.get("content") or "").strip()


def gemini_answer(data: dict) -> str:
    """``functionCall.args`` of Gemini's answer, else its text parts."""
    candidates = _items(data.get("candidates"))
    content = candidates[0].get("content") if candidates else None
    parts = _items(content.get("parts")) if isinstance(content, dict) else []
    for part in parts:
        call = part.get("functionCall")
        if isinstance(call, dict):
            found = _as_text(call.get("args"))
            if found is not None:
                return found
    return "".join(str(p.get("text") or "") for p in parts if "text" in p).strip()
