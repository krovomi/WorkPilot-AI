"""
Contract Parser — Parse OpenAPI, GraphQL, and Protobuf specifications.

Produces a normalised internal representation for semantic diff: endpoints
with their parameters, request body and response statuses, types with their
fields (format, enum values, protobuf field numbers), enums, and the parts of
the contract that declare a breaking change on purpose
(``x-breaking-acknowledged``, #389).
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: The annotation that marks a breaking change as intended: an OpenAPI key
#: (``x-breaking-acknowledged: true`` on the document, ``info``, an operation,
#: a schema, a property or a parameter), or a comment line
#: ``# x-breaking-acknowledged`` (GraphQL) / ``// x-breaking-acknowledged``
#: (protobuf) just above the type, field or rpc it covers. As the first line
#: of the file, followed by a blank line, it covers the whole file.
ACK_KEY = "x-breaking-acknowledged"
_ACK_COMMENT = re.compile(r"^\s*(?:#|//)\s*x-breaking-acknowledged\b", re.IGNORECASE)


_HTTP_METHODS = ("GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE")


class ContractFormat(str, Enum):
    OPENAPI = "openapi"
    GRAPHQL = "graphql"
    PROTOBUF = "protobuf"
    UNKNOWN = "unknown"


@dataclass
class ApiField:
    """A single field in an API schema."""

    name: str
    type: str
    required: bool = False
    description: str = ""
    deprecated: bool = False
    children: list[ApiField] = field(default_factory=list)
    format: str = ""
    enum: list[str] = field(default_factory=list)
    number: int | None = None


@dataclass
class ApiEndpoint:
    """A single API endpoint / operation."""

    path: str
    method: str = ""
    operation_id: str = ""
    parameters: list[ApiField] = field(default_factory=list)
    request_body: list[ApiField] = field(default_factory=list)
    responses: dict[str, list[ApiField]] = field(default_factory=dict)
    deprecated: bool = False
    body_required: bool = False

    @property
    def key(self) -> str:
        return f"{self.method} {self.path}"


@dataclass
class ApiContract:
    """Normalised representation of an API contract."""

    title: str = ""
    version: str = ""
    format: ContractFormat = ContractFormat.UNKNOWN
    endpoints: list[ApiEndpoint] = field(default_factory=list)
    types: dict[str, list[ApiField]] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)
    enums: dict[str, list[str]] = field(default_factory=dict)
    #: GraphQL ``input`` types: a required field added there breaks callers.
    input_types: set[str] = field(default_factory=set)
    #: protobuf ``reserved`` field numbers and names, per message.
    reserved: dict[str, set[str]] = field(default_factory=dict)
    #: Change paths declared intended (``Type``, ``Type.field``, ``GET /x``…);
    #: ``*`` covers the whole contract.
    acknowledged: set[str] = field(default_factory=set)

    def is_acknowledged(self, path: str) -> bool:
        """Whether ``path`` (``GET /x.params.id``, ``Type.field``) or one of
        its parents is declared intended."""
        if "*" in self.acknowledged:
            return True
        parts = path.split(".")
        return any(
            ".".join(parts[:i]) in self.acknowledged for i in range(1, len(parts) + 1)
        )


class ContractParser:
    """Parse API specification files into normalised ApiContract objects.

    Usage::

        parser = ContractParser()
        contract = parser.parse_file(Path("openapi.yaml"))
    """

    def parse_file(self, path: Path) -> ApiContract:
        """Parse a spec file, auto-detecting the format."""
        content = path.read_text(encoding="utf-8")
        return self.parse_string(content, self.detect_format(path, content))

    def parse_string(self, content: str, fmt: ContractFormat) -> ApiContract:
        """Parse a spec string with an explicit format."""
        if fmt == ContractFormat.OPENAPI:
            return self._parse_openapi(content)
        if fmt == ContractFormat.GRAPHQL:
            return self._parse_graphql(content)
        if fmt == ContractFormat.PROTOBUF:
            return self._parse_protobuf(content)
        return ApiContract(format=ContractFormat.UNKNOWN)

    @staticmethod
    def detect_format(path: Path, content: str = "") -> ContractFormat:
        """Auto-detect the contract format from file extension and content."""
        suffix = path.suffix.lower()
        name = path.name.lower()

        if suffix in (".graphql", ".graphqls", ".gql") or "schema.graphql" in name:
            return ContractFormat.GRAPHQL
        if suffix == ".proto":
            return ContractFormat.PROTOBUF
        if suffix in (".yaml", ".yml", ".json"):
            # A long info block or leading comments can push the version key
            # past the first lines, so look a little further.
            head = content[:4096].lower()
            if "openapi" in head or "swagger" in head:
                return ContractFormat.OPENAPI
        return ContractFormat.UNKNOWN

    # ── OpenAPI / Swagger ────────────────────────────────────────────────

    def _parse_openapi(self, content: str) -> ApiContract:
        data = _load_document(content)
        if not isinstance(data, dict):
            return ApiContract(format=ContractFormat.OPENAPI)

        info = _dict(data.get("info"))
        contract = ApiContract(
            title=str(info.get("title", "")),
            version=str(info.get("version", "")),
            format=ContractFormat.OPENAPI,
            raw=data,
        )
        if _acked(data) or _acked(info):
            contract.acknowledged.add("*")

        components = _dict(data.get("components"))
        schemas = _dict(components.get("schemas", data.get("definitions")))
        shared = _dict(components.get("parameters", data.get("parameters")))

        for path_str, methods in _dict(data.get("paths")).items():
            if not isinstance(methods, dict):
                continue
            common = _list(methods.get("parameters"))
            if _acked(methods):  # the path item: its operations, removed ones too
                contract.acknowledged.update(f"{m} {path_str}" for m in _HTTP_METHODS)
            for method, op in methods.items():
                if method.startswith("x-") or method == "parameters":
                    continue
                if isinstance(op, dict):
                    contract.endpoints.append(
                        self._openapi_operation(
                            str(path_str),
                            method,
                            op,
                            common,
                            shared,
                            components,
                            contract,
                        )
                    )

        for name, schema in schemas.items():
            if not isinstance(schema, dict):
                continue
            contract.types[name] = _fields(schema, inline=True)
            if _acked(schema):
                contract.acknowledged.add(name)
            props = _dict(schema.get("properties"))
            for prop_name, prop in props.items():
                if _acked(prop):
                    contract.acknowledged.add(f"{name}.{prop_name}")
            if schema.get("enum") and not props:
                contract.enums[name] = _enum(schema)

        return contract

    @staticmethod
    def _openapi_operation(
        path: str,
        method: str,
        op: dict,
        common: list,
        shared: dict,
        components: dict,
        contract: ApiContract,
    ) -> ApiEndpoint:
        endpoint = ApiEndpoint(
            path=path,
            method=method.upper(),
            operation_id=str(op.get("operationId", "")),
            deprecated=bool(op.get("deprecated", False)),
        )
        if _acked(op):
            contract.acknowledged.add(endpoint.key)
        by_name: dict[str, ApiField] = {}
        for raw in [*common, *_list(op.get("parameters"))]:
            param = _resolve(raw, shared)
            if not isinstance(param, dict) or not param.get("name"):
                continue
            if param.get("in") == "body":  # Swagger 2 body parameter
                endpoint.request_body = _fields(param.get("schema"))
                endpoint.body_required = bool(param.get("required", False))
                continue
            schema = (
                param.get("schema") if isinstance(param.get("schema"), dict) else param
            )
            item = ApiField(
                name=str(param["name"]),
                type=_type_of(schema),
                required=bool(param.get("required", False))
                or param.get("in") == "path",
                deprecated=bool(param.get("deprecated", False)),
                format=str(schema.get("format", "")),
                enum=_enum(schema),
                description=str(param.get("in", "")),
            )
            by_name[item.name] = item
            if _acked(param):
                contract.acknowledged.add(f"{endpoint.key}.params.{item.name}")
        endpoint.parameters = list(by_name.values())
        body = _resolve(op.get("requestBody"), _dict(components.get("requestBodies")))
        if isinstance(body, dict):
            endpoint.body_required = bool(body.get("required", False))
            endpoint.request_body = _fields(_media_schema(body))
        for status, response in _dict(op.get("responses")).items():
            response = _resolve(response, _dict(components.get("responses")))
            endpoint.responses[str(status)] = _fields(_media_schema(response))
        return endpoint

    # ── GraphQL ──────────────────────────────────────────────────────────

    def _parse_graphql(self, content: str) -> ApiContract:
        contract = ApiContract(format=ContractFormat.GRAPHQL)
        text, acks, whole = _strip_comments(content, "#")
        if whole:
            contract.acknowledged.add("*")
        text = re.sub(r'"""[\s\S]*?"""', _blank, text)
        text = re.sub(r'"(?:[^"\\\n]|\\.)*"', _blank, text)

        block = re.compile(r"\b(extend\s+)?(type|input|interface|enum)\s+(\w+)[^{]*\{")
        for match in block.finditer(text):
            kind, name = match.group(2), match.group(3)
            body_start = match.end()
            body = text[body_start : _matching_brace(text, body_start - 1)]
            if _line_of(text, match.start()) in acks:
                contract.acknowledged.add(name)
            if kind == "enum":
                body = re.sub(r"@\w+(\([^)]*\))?", " ", body)
                contract.enums[name] = re.findall(r"\b[A-Za-z_]\w*\b", body)
                continue
            if kind == "input":
                contract.input_types.add(name)
            fields = contract.types.setdefault(name, [])
            for f, offset in _graphql_fields(body):
                fields.append(f)
                if _line_of(text, body_start + offset) in acks:
                    contract.acknowledged.add(f"{name}.{f.name}")
                if name not in ("Query", "Mutation", "Subscription"):
                    continue
                endpoint = ApiEndpoint(
                    path=f.name,
                    method=name.upper(),
                    parameters=f.children,
                    responses={"data": [ApiField(name="result", type=f.type)]},
                    deprecated=f.deprecated,
                )
                contract.endpoints.append(endpoint)
                if contract.is_acknowledged(f"{name}.{f.name}"):
                    contract.acknowledged.add(endpoint.key)
        return contract

    # ── Protobuf ─────────────────────────────────────────────────────────

    def _parse_protobuf(self, content: str) -> ApiContract:
        contract = ApiContract(format=ContractFormat.PROTOBUF)
        text, acks, whole = _strip_comments(content, "//")
        if whole:
            contract.acknowledged.add("*")
        text = re.sub(
            r"/\*[\s\S]*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), text
        )
        package = re.search(r"^\s*package\s+([\w.]+)\s*;", text, re.MULTILINE)
        contract.title = package.group(1) if package else ""
        _proto_blocks(text, 0, len(text), "", contract, acks)
        return contract


# ── protobuf helpers ─────────────────────────────────────────────────────

_PROTO_BLOCK = re.compile(r"\b(message|enum|service)\s+(\w+)\s*\{")
_PROTO_FIELD = re.compile(
    r"(?:^|[;{}\s])(repeated|optional|required)?\s*(map\s*<[^>]+>|[\w.]+)\s+(\w+)"
    r"\s*=\s*(\d+)\s*(\[[^\]]*\])?\s*;"
)
_PROTO_RPC = re.compile(
    r"\brpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)"
)


def _proto_blocks(
    text: str, start: int, end: int, prefix: str, contract: ApiContract, acks: set[int]
) -> None:
    pos = start
    while match := _PROTO_BLOCK.search(text, pos, end):
        kind, name = match.group(1), prefix + match.group(2)
        body_start = match.end()
        body_end = _matching_brace(text, body_start - 1)
        if _line_of(text, match.start()) in acks:
            contract.acknowledged.add(name)
        body = text[body_start:body_end]
        flat = _without_nested(body)
        if kind == "message":
            contract.types[name] = _proto_fields(
                text, body_start, flat, name, contract, acks
            )
            reserved = _proto_reserved(flat)
            if reserved:
                contract.reserved[name] = reserved
            _proto_blocks(text, body_start, body_end, f"{name}.", contract, acks)
        elif kind == "enum":
            contract.enums[name] = [
                f"{n}={v}"
                for n, v in re.findall(r"\b([A-Z_][A-Z0-9_]*)\s*=\s*(-?\d+)", flat)
            ]
        else:
            for rpc in _PROTO_RPC.finditer(body):
                endpoint = ApiEndpoint(
                    path=f"{name}/{rpc.group(1)}",
                    method="RPC",
                    operation_id=rpc.group(1),
                    parameters=[
                        ApiField(
                            name="request",
                            type=("stream " if rpc.group(2) else "") + rpc.group(3),
                            required=True,
                        )
                    ],
                    responses={
                        "returns": [
                            ApiField(
                                name="response",
                                type=("stream " if rpc.group(4) else "") + rpc.group(5),
                            )
                        ]
                    },
                )
                contract.endpoints.append(endpoint)
                if name in contract.acknowledged or (
                    _line_of(text, body_start + rpc.start()) in acks
                ):
                    contract.acknowledged.add(endpoint.key)
        pos = body_end + 1


def _proto_fields(
    text: str,
    offset: int,
    flat: str,
    message: str,
    contract: ApiContract,
    acks: set[int],
) -> list[ApiField]:
    fields: list[ApiField] = []
    for match in _PROTO_FIELD.finditer(flat):
        label, ftype, fname, number, options = match.groups()
        if ftype in ("reserved", "option", "extensions"):
            continue
        fields.append(
            ApiField(
                name=fname,
                type=("repeated " if label == "repeated" else "")
                + re.sub(r"\s+", "", ftype),
                required=label == "required",
                deprecated=bool(
                    options and re.search(r"deprecated\s*=\s*true", options)
                ),
                number=int(number),
            )
        )
        if _line_of(text, offset + match.start(3)) in acks:
            contract.acknowledged.add(f"{message}.{fname}")
    return fields


def _proto_reserved(flat: str) -> set[str]:
    reserved: set[str] = set()
    for spec in re.findall(r"\breserved\s+([^;]+);", flat):
        for part in spec.split(","):
            part = part.strip().strip("\"'")
            low, sep, high = part.partition(" to ")
            if sep and low.strip().isdigit():
                top = int(low) + 1000 if high.strip() == "max" else int(high or low)
                reserved.update(
                    str(n) for n in range(int(low), min(top, int(low) + 1000) + 1)
                )
            elif part:
                reserved.add(part)
    return reserved


# ── shared helpers ───────────────────────────────────────────────────────


def _load_document(content: str) -> Any:
    import yaml

    try:
        return yaml.safe_load(content)
    except (yaml.YAMLError, ValueError):
        try:
            return json.loads(content)
        except ValueError:
            return None


def _dict(node: Any) -> dict:
    return node if isinstance(node, dict) else {}


def _list(node: Any) -> list:
    return node if isinstance(node, list) else []


def _blank(match: re.Match) -> str:
    return re.sub(r"[^\n]", " ", match.group(0))


def _acked(node: Any) -> bool:
    return isinstance(node, dict) and node.get(ACK_KEY) is True


def _resolve(node: Any, table: dict, depth: int = 0) -> Any:
    """A ``$ref`` to a component, followed into ``table`` (a few hops)."""
    if isinstance(node, dict) and isinstance(node.get("$ref"), str) and depth < 4:
        target = table.get(node["$ref"].rsplit("/", 1)[-1])
        if isinstance(target, dict):
            return _resolve(target, table, depth + 1)
    return node


def _type_of(schema: Any) -> str:
    if not isinstance(schema, dict):
        return "string"
    if isinstance(schema.get("$ref"), str):
        return schema["$ref"].rsplit("/", 1)[-1]
    kind = schema.get("type")
    if isinstance(kind, list):
        kind = "|".join(sorted(str(k) for k in kind if k != "null")) or "null"
    if kind == "array":
        return f"array<{_type_of(schema.get('items'))}>"
    for combo in ("oneOf", "anyOf", "allOf"):
        if isinstance(schema.get(combo), list):
            return f"{combo}<{','.join(sorted(_type_of(s) for s in schema[combo]))}>"
    return str(kind or "object")


def _enum(schema: Any) -> list[str]:
    values = schema.get("enum") if isinstance(schema, dict) else None
    return [str(v) for v in values] if isinstance(values, list) else []


def _media_schema(node: Any) -> Any:
    if not isinstance(node, dict):
        return None
    content = node.get("content")
    if isinstance(content, dict):
        for media in content.values():
            if isinstance(media, dict) and "schema" in media:
                return media["schema"]
        return None
    return node.get("schema")


def _fields(schema: Any, *, inline: bool = False) -> list[ApiField]:
    """The properties of a schema. A ``$ref`` or an array is named as one
    entry, not expanded, unless ``inline`` (a component's own definition):
    its fields are compared with the component."""
    if not isinstance(schema, dict):
        return []
    if not inline and (
        isinstance(schema.get("$ref"), str) or schema.get("type") == "array"
    ):
        return [ApiField(name="schema", type=_type_of(schema), required=True)]
    required = set(_list(schema.get("required")))
    fields: list[ApiField] = []
    for name, prop in _dict(schema.get("properties")).items():
        if not isinstance(prop, dict):
            continue
        fields.append(
            ApiField(
                name=str(name),
                type=_type_of(prop),
                required=name in required,
                deprecated=bool(prop.get("deprecated", False)),
                format=str(prop.get("format", "")),
                enum=_enum(prop),
            )
        )
    return fields


def _strip_comments(content: str, marker: str) -> tuple[str, set[int], bool]:
    """The text with line comments blanked, the lines an ack comment covers
    (the next line with code), and whether the file opens with one followed
    by a blank line, which covers the whole file."""
    acks: set[int] = set()
    whole = pending = opening = gap = seen_code = False
    out: list[str] = []
    for number, line in enumerate(content.split("\n")):
        if _ACK_COMMENT.match(line):
            pending, opening, gap = True, not seen_code, False
            out.append("")
            continue
        index = line.find(marker)
        code = line if index < 0 else line[:index]
        out.append(code + " " * (len(line) - len(code)))
        if not code.strip():
            gap = gap or pending
            continue
        if pending:
            if opening and gap:
                whole = True
            else:
                acks.add(number)
            pending = False
        seen_code = True
    return "\n".join(out), acks, whole


def _line_of(text: str, index: int) -> int:
    return text.count("\n", 0, max(index, 0))


def _matching_brace(text: str, open_index: int) -> int:
    depth = 0
    for i in range(open_index, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    return len(text)


def _without_nested(body: str) -> str:
    """``body`` with nested ``message`` / ``enum`` blocks blanked; ``oneof``
    bodies stay, their fields belong to the message."""
    out = list(body)
    for match in re.finditer(r"\b(message|enum)\s+\w+\s*\{", body):
        end = _matching_brace(body, match.end() - 1)
        for i in range(match.start(), min(end + 1, len(out))):
            if out[i] != "\n":
                out[i] = " "
    return "".join(out)


def _graphql_fields(body: str) -> list[tuple[ApiField, int]]:
    """The fields of a block body, each with its offset in ``body``."""
    pattern = re.compile(
        r"(\w+)\s*(\((?:[^()]|\([^()]*\))*\))?\s*:\s*([\w\[\]!]+)((?:\s*@\w+(?:\([^)]*\))?)*)"
    )
    fields: list[tuple[ApiField, int]] = []
    for match in pattern.finditer(body):
        name, args, ftype, directives = match.groups()
        children: list[ApiField] = []
        for arg in re.finditer(
            r"(\w+)\s*:\s*([\w\[\]!]+)(\s*=\s*[^,)\n]+)?", (args or "")[1:-1]
        ):
            children.append(
                ApiField(
                    name=arg.group(1),
                    type=arg.group(2),
                    required=arg.group(2).endswith("!") and not arg.group(3),
                )
            )
        fields.append(
            (
                ApiField(
                    name=name,
                    type=ftype,
                    required=ftype.endswith("!"),
                    deprecated="@deprecated" in (directives or ""),
                    children=children,
                ),
                match.start(1),
            )
        )
    return fields
