"""Mock responses for the API verifications of a plan, built from the repo's contracts.

A subtask verified by ``GET /api/orders/42 -> 200`` can be rehearsed without a
server: the OpenAPI contract of the repo says whether that route exists, which
statuses it declares and what its body looks like. The mock is generated from
the schema (``schema_based``), deterministically, so the same plan always gets
the same report and no model is needed. A route no contract describes gets a
``static`` empty answer and a finding, never an invented body.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlparse

import yaml

_CONTRACT_NAME = re.compile(r"(openapi|swagger|api)", re.IGNORECASE)
_CONTRACT_SUFFIXES = (".yaml", ".yml", ".json")
_SCHEMA_SUFFIXES = (".proto", ".graphql", ".graphqls", ".gql")
_MAX_CONTRACTS = 20
_MAX_CONTRACT_BYTES = 2_000_000
_MAX_DEPTH = 6
_IGNORED_PARTS = {"node_modules", "vendor", ".git", "bin", "obj", "target", "dist"}


@dataclass
class Operation:
    method: str
    template: str
    pattern: re.Pattern[str]
    responses: dict[str, Any]
    contract: str


@dataclass
class ContractIndex:
    """The OpenAPI operations of the repo, plus the other schema files it holds."""

    operations: list[Operation] = field(default_factory=list)
    contracts: list[str] = field(default_factory=list)
    other_schemas: list[str] = field(default_factory=list)
    raw: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def empty(self) -> bool:
        return not self.operations and not self.other_schemas


@dataclass(frozen=True)
class MockResult:
    url: str
    method: str
    status_code: int
    body: str
    strategy: str  # schema_based | static
    finding: str | None = None  # finding code, None when the contract covers it
    contract: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "method": self.method,
            "statusCode": self.status_code,
            "body": self.body,
            "strategy": self.strategy,
        }


def _template_pattern(template: str) -> re.Pattern[str]:
    """A URL path matcher for an OpenAPI template such as ``/orders/{id}``.

    A base path the contract leaves to its ``servers`` entry (``/api``, ``/v1``)
    may precede the template in the plan's URL, but only as whole segments.
    """
    trimmed = template.strip().rstrip("/")
    if not trimmed:
        return re.compile(r"^(?:/[^/?#]+)?/?$")
    if not trimmed.startswith("/"):
        trimmed = "/" + trimmed
    parts = re.split(r"(\{[^}/]+\})", trimmed)
    regex = "".join(
        "[^/]+" if part.startswith("{") else re.escape(part) for part in parts
    )
    return re.compile(rf"^(?:/.*)?{regex}/?$")


def build_index(
    files: set[str], read_tracked: Callable[[str], str | None]
) -> ContractIndex:
    index = ContractIndex()
    candidates = []
    for path in sorted(files):
        pure = PurePosixPath(path)
        if _IGNORED_PARTS.intersection(pure.parts[:-1]):
            continue
        name = pure.name.lower()
        if name.endswith(_SCHEMA_SUFFIXES):
            index.other_schemas.append(path)
        elif name.endswith(_CONTRACT_SUFFIXES) and _CONTRACT_NAME.search(name):
            candidates.append(path)
    for path in candidates[:_MAX_CONTRACTS]:
        content = read_tracked(path)
        if not content or len(content) > _MAX_CONTRACT_BYTES:
            continue
        head = content[:4096].lower()
        if "openapi" not in head and "swagger" not in head:
            continue
        data = _load(content)
        if not isinstance(data, dict) or not isinstance(data.get("paths"), dict):
            continue
        index.contracts.append(path)
        index.raw[path] = data
        for template, methods in data["paths"].items():
            if not isinstance(methods, dict) or not isinstance(template, str):
                continue
            for method, operation in methods.items():
                if method.startswith("x-") or not isinstance(operation, dict):
                    continue
                responses = operation.get("responses")
                index.operations.append(
                    Operation(
                        method=method.upper(),
                        template=template,
                        pattern=_template_pattern(template),
                        responses=responses if isinstance(responses, dict) else {},
                        contract=path,
                    )
                )
    return index


def _load(content: str) -> Any:
    try:
        return json.loads(content)
    except ValueError:
        pass
    try:
        return yaml.safe_load(content)
    except yaml.YAMLError:  # an unreadable contract is just skipped
        return None


def _resolve(ref: str, root: dict[str, Any]) -> Any:
    if not ref.startswith("#/"):
        return {}  # remote refs are never fetched
    node: Any = root
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(node, dict) or part not in node:
            return {}
        node = node[part]
    return node


_FORMAT_SAMPLES = {
    "date-time": "2026-01-01T00:00:00Z",
    "date": "2026-01-01",
    "uuid": "00000000-0000-0000-0000-000000000000",
    "email": "user@example.com",
    "uri": "https://example.com",
    "url": "https://example.com",
}


def sample(schema: Any, root: dict[str, Any], depth: int = 0) -> Any:
    """A deterministic value that satisfies ``schema`` (best effort)."""
    if depth > _MAX_DEPTH or not isinstance(schema, dict):
        return None
    if "$ref" in schema:
        return sample(_resolve(str(schema["$ref"]), root), root, depth + 1)
    if "example" in schema:
        return schema["example"]
    if isinstance(schema.get("enum"), list) and schema["enum"]:
        return schema["enum"][0]
    for key in ("oneOf", "anyOf"):
        if isinstance(schema.get(key), list) and schema[key]:
            return sample(schema[key][0], root, depth + 1)
    if isinstance(schema.get("allOf"), list):
        merged: dict[str, Any] = {}
        for part in schema["allOf"]:
            value = sample(part, root, depth + 1)
            if isinstance(value, dict):
                merged.update(value)
        return merged
    kind = schema.get("type")
    if isinstance(kind, list):
        kind = next((k for k in kind if k != "null"), None)
    if kind == "array":
        return [sample(schema.get("items", {}), root, depth + 1)]
    if kind == "object" or "properties" in schema:
        properties = schema.get("properties") or {}
        return {
            name: sample(prop, root, depth + 1)
            for name, prop in properties.items()
            if isinstance(name, str)
        }
    if kind == "integer":
        return 0
    if kind == "number":
        return 0.0
    if kind == "boolean":
        return True
    if kind == "string":
        return _FORMAT_SAMPLES.get(str(schema.get("format", "")), "string")
    return None


def _response_schema(response: Any, root: dict[str, Any]) -> Any:
    if isinstance(response, dict) and "$ref" in response:
        response = _resolve(str(response["$ref"]), root)
    if not isinstance(response, dict):
        return None
    content = response.get("content")
    if isinstance(content, dict):  # OpenAPI 3
        media = content.get("application/json") or next(iter(content.values()), None)
        return media.get("schema") if isinstance(media, dict) else None
    return response.get("schema")  # Swagger 2


def mock(
    index: ContractIndex, method: str, url: str, expect_status: int | None
) -> MockResult:
    method = (method or "GET").upper()
    path = urlparse(url).path or url
    for operation in index.operations:
        if operation.method != method or not operation.pattern.match(path):
            continue
        declared = {str(code): body for code, body in operation.responses.items()}
        wanted = str(expect_status) if expect_status else None
        if wanted is None:
            wanted = next(
                (code for code in sorted(declared) if code.startswith("2")), None
            )
        if wanted is not None and wanted not in declared and "default" not in declared:
            return MockResult(
                url=url,
                method=method,
                status_code=int(wanted) if wanted.isdigit() else 0,
                body="",
                strategy="static",
                finding="api_status_undeclared",
                contract=operation.contract,
            )
        response = declared.get(wanted or "", declared.get("default"))
        root = index.raw.get(operation.contract, {})
        body = sample(_response_schema(response, root), root)
        status = int(wanted) if wanted and wanted.isdigit() else 200
        return MockResult(
            url=url,
            method=method,
            status_code=status,
            body=json.dumps(body, ensure_ascii=False) if body is not None else "",
            strategy="schema_based",
            contract=operation.contract,
        )
    return MockResult(
        url=url,
        method=method,
        status_code=expect_status or 200,
        body="",
        strategy="static",
        finding="api_endpoint_undeclared" if index.contracts else "api_no_contract",
    )
