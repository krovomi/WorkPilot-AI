"""A valid request body from a JSON Schema, and a check of a response against one.

A model asked for "a valid payload" invents one: a field named the way it
expects, a date in a format the API does not parse, a required property
forgotten. The schema the running application publishes already says what is
valid, so the first payload is built from it — examples and defaults first,
then enums, then a value of the declared type and format — and the model only
adjusts what the *business case* of the task needs. A 7B local model, told not
to invent, can then still call an endpoint correctly.

The validator is deliberately small: types, required properties, enums,
nested objects and arrays, `$ref`/`allOf`/`oneOf`/`anyOf`, OpenAPI 3.0's
`nullable`. It answers "does this response have the shape the API says",
which is the question a verification asks; it is not a JSON Schema test suite.
"""

from __future__ import annotations

from typing import Any

__all__ = ["instance", "validate", "resolve"]

_MAX_DEPTH = 6
_MAX_PROPERTIES = 16

_FORMAT_VALUES = {
    "email": "verify@example.com",
    "uuid": "00000000-0000-4000-8000-000000000001",
    "guid": "00000000-0000-4000-8000-000000000001",
    "date": "2026-01-01",
    "date-time": "2026-01-01T00:00:00Z",
    "time": "12:00:00",
    "uri": "https://example.com/",
    "url": "https://example.com/",
    "hostname": "example.com",
    "ipv4": "127.0.0.1",
    "ipv6": "::1",
    "byte": "dmVyaWZ5",
    "password": "Verify-Passw0rd!",
    "phone": "+33100000000",
}


def resolve(schema: Any, root: dict) -> Any:
    """Follow ``$ref`` (local refs only) until a schema that is not one."""
    seen: set[str] = set()
    while isinstance(schema, dict) and isinstance(schema.get("$ref"), str):
        ref = schema["$ref"]
        if not ref.startswith("#/") or ref in seen:
            return {}
        seen.add(ref)
        node: Any = root
        for part in ref[2:].split("/"):
            part = part.replace("~1", "/").replace("~0", "~")
            node = node.get(part) if isinstance(node, dict) else None
            if node is None:
                return {}
        schema = node
    return schema if isinstance(schema, dict) else {}


def _merged(schema: dict, root: dict) -> dict:
    """``allOf`` folded into one schema."""
    if "allOf" not in schema:
        return schema
    out: dict = {k: v for k, v in schema.items() if k != "allOf"}
    properties: dict = dict(out.get("properties") or {})
    required: list = list(out.get("required") or [])
    for part in schema.get("allOf") or []:
        part = _merged(resolve(part, root), root)
        properties.update(part.get("properties") or {})
        required += [r for r in part.get("required") or [] if r not in required]
        for key in ("type", "example", "default", "enum"):
            if key in part and key not in out:
                out[key] = part[key]
    if properties:
        out["properties"] = properties
    if required:
        out["required"] = required
    return out


def _type(schema: dict) -> str:
    declared = schema.get("type")
    if isinstance(declared, list):
        declared = next((t for t in declared if t != "null"), None)
    if declared:
        return str(declared)
    if "properties" in schema:
        return "object"
    if "items" in schema:
        return "array"
    return ""


def instance(schema: Any, root: dict | None = None, depth: int = 0) -> Any:
    """A minimal valid value for ``schema``. Never raises."""
    root = root or {}
    schema = _merged(resolve(schema, root), root)
    if not schema or depth > _MAX_DEPTH:
        return None
    for key in ("example", "default", "const"):
        if key in schema:
            return schema[key]
    examples = schema.get("examples")
    if isinstance(examples, list) and examples:
        return examples[0]
    if isinstance(schema.get("enum"), list) and schema["enum"]:
        return schema["enum"][0]
    for key in ("oneOf", "anyOf"):
        options = schema.get(key)
        if isinstance(options, list) and options:
            non_null = [o for o in options if resolve(o, root).get("type") != "null"]
            return instance((non_null or options)[0], root, depth + 1)

    kind = _type(schema)
    if kind == "object":
        properties = schema.get("properties") or {}
        required = [r for r in schema.get("required") or [] if r in properties]
        # Required first; with no `required` list (common in generated specs),
        # every property is sent, since the API may still insist on them.
        names = required or list(properties)[:_MAX_PROPERTIES]
        out = {}
        for name in names:
            sub = resolve(properties[name], root)
            if sub.get("readOnly"):
                continue
            out[name] = instance(sub, root, depth + 1)
        return out
    if kind == "array":
        item = instance(schema.get("items") or {}, root, depth + 1)
        minimum = int(schema.get("minItems") or 1)
        return (
            [item for _ in range(max(1, min(minimum, 3)))] if item is not None else []
        )
    if kind == "integer":
        low = schema.get("minimum")
        return (
            int(low) + (1 if schema.get("exclusiveMinimum") is True else 0)
            if low is not None
            else 1
        )
    if kind == "number":
        low = schema.get("minimum")
        return (
            float(low) + (1 if schema.get("exclusiveMinimum") is True else 0)
            if low is not None
            else 1.0
        )
    if kind == "boolean":
        return True
    if kind == "string":
        fmt = str(schema.get("format") or "").lower()
        if fmt in _FORMAT_VALUES:
            return _FORMAT_VALUES[fmt]
        value = "verify"
        minimum = int(schema.get("minLength") or 0)
        maximum = schema.get("maxLength")
        if minimum > len(value):
            value = (value * (minimum // len(value) + 1))[:minimum]
        if isinstance(maximum, int) and maximum < len(value):
            value = value[: max(maximum, 1)]
        return value
    return None


def validate(
    value: Any, schema: Any, root: dict | None = None, path: str = "$", depth: int = 0
) -> list[str]:
    """Problems with ``value`` against ``schema`` — an empty list when it fits."""
    root = root or {}
    schema = _merged(resolve(schema, root), root)
    if not schema or depth > _MAX_DEPTH:
        return []
    if value is None:
        nullable = schema.get("nullable") or (
            isinstance(schema.get("type"), list) and "null" in schema["type"]
        )
        return (
            []
            if nullable or not _type(schema)
            else [f"{path}: null where {_type(schema)} expected"]
        )
    for key in ("oneOf", "anyOf"):
        options = schema.get(key)
        if isinstance(options, list) and options:
            if any(not validate(value, o, root, path, depth + 1) for o in options):
                return []
            return [f"{path}: matches none of the {key} alternatives"]
    if isinstance(schema.get("enum"), list) and value not in schema["enum"]:
        return [f"{path}: {value!r} is not one of {schema['enum'][:8]}"]

    kind = _type(schema)
    checks = {
        "object": lambda v: isinstance(v, dict),
        "array": lambda v: isinstance(v, list),
        "string": lambda v: isinstance(v, str),
        "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
        "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
        "boolean": lambda v: isinstance(v, bool),
    }
    if kind in checks and not checks[kind](value):
        return [f"{path}: {type(value).__name__} where {kind} expected"]

    problems: list[str] = []
    if kind == "object" and isinstance(value, dict):
        properties = schema.get("properties") or {}
        for name in schema.get("required") or []:
            if name not in value:
                problems.append(f"{path}.{name}: required property missing")
        for name, sub in properties.items():
            if name in value:
                problems += validate(
                    value[name], sub, root, f"{path}.{name}", depth + 1
                )
    elif kind == "array" and isinstance(value, list):
        for index, item in enumerate(value[:20]):
            problems += validate(
                item, schema.get("items") or {}, root, f"{path}[{index}]", depth + 1
            )
    return problems[:20]
