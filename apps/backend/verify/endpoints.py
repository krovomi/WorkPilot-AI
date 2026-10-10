"""The endpoints a task created or changed, called on the app it just launched.

Which endpoints: the **OpenAPI document the running application publishes**
(`/swagger/v1/swagger.json` for Swashbuckle, `/openapi/v1.json` for .NET 9's
`Microsoft.AspNetCore.OpenApi`, `/openapi.json` for FastAPI, `/v3/api-docs`
for springdoc…), filtered to the operations whose handler is one of the task's
files — `docintel.api_tests.find_handler`, the lookup the drafted integration
tests already use. The document is measured, not recalled, and it carries the
schemas a payload is built from (`verify.payloads`) and a response is checked
against.

How they are called — three rules that do not bend:

* **loopback only.** The base URL must be the app this verification launched
  on 127.0.0.1/localhost, and a path is a path (`/api/orders`), never a URL;
  nothing reaches a shared or production server, and no proxy sees the call;
* **mutations are opt-out**, not opt-in: `VERIFY_ALLOW_MUTATIONS=false` turns
  POST/PUT/PATCH/DELETE into "not called" — the dev server's database is the
  developer's, and some teams want it left alone;
* **what comes back is data.** A response body is masked by the secret
  patterns and scanned by `injection_guard` before it is written or shown to
  a model; a body that reads as an instruction is withheld, not quoted.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .payloads import instance, resolve, validate

__all__ = [
    "OPENAPI_PATHS",
    "Operation",
    "EndpointResult",
    "fetch_openapi",
    "operations",
    "touched_operations",
    "build_call",
    "call_endpoint",
]

OPENAPI_PATHS = (
    "/swagger/v1/swagger.json",
    "/openapi/v1.json",
    "/openapi.json",
    "/v3/api-docs",
    "/swagger.json",
    "/api-docs",
    "/api/openapi.json",
    "/docs/openapi.json",
    "/swagger/doc.json",
)
#: Where the human-readable documentation usually lives, for the screenshot.
DOCS_PAGES = (
    "/swagger",
    "/swagger/index.html",
    "/docs",
    "/scalar",
    "/redoc",
    "/swagger-ui/index.html",
)

_METHODS = ("get", "post", "put", "patch", "delete")
_MUTATING = {"POST", "PUT", "PATCH", "DELETE"}
_LOOPBACK = re.compile(r"^https?://(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$")
_MAX_BODY = 64_000
_EXCERPT = 2_000


@dataclass
class Operation:
    method: str
    path: str
    operation_id: str = ""
    summary: str = ""
    request_schema: dict | None = None
    request_required: bool = False
    parameters: list[dict] = field(default_factory=list)
    responses: dict[str, dict | None] = field(default_factory=dict)
    handler: str = ""
    touched: bool = False

    @property
    def expected_status(self) -> int | None:
        codes = sorted(c for c in self.responses if c.isdigit())
        success = next((c for c in codes if c.startswith("2")), None)
        return int(success) if success else None

    def to_dict(self) -> dict:
        data = asdict(self)
        data["expected_status"] = self.expected_status
        return data


@dataclass
class EndpointResult:
    method: str
    path: str
    status: int | None = None
    expected: list[int] = field(default_factory=list)
    ok: bool = False
    latency_ms: float | None = None
    schema_ok: bool | None = None
    problems: list[str] = field(default_factory=list)
    request_body: Any = None
    response_excerpt: str = ""
    content_type: str = ""
    #: ``called``, ``skipped-mutation``, ``refused``, ``unreachable``, ``auth``.
    outcome: str = "called"
    note: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _request(method: str, url: str, body: bytes | None, headers: dict, timeout: float):
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    started = time.perf_counter()
    try:
        with _opener().open(req, timeout=timeout) as resp:
            data = resp.read(_MAX_BODY + 1)
            return (
                int(resp.status),
                dict(resp.headers),
                data,
                (time.perf_counter() - started) * 1000,
            )
    except urllib.error.HTTPError as exc:
        data = exc.read(_MAX_BODY + 1) if exc.fp else b""
        return (
            int(exc.code),
            dict(exc.headers or {}),
            data,
            (time.perf_counter() - started) * 1000,
        )


def fetch_openapi(base_url: str, timeout: float = 5.0) -> tuple[dict, str]:
    """The app's OpenAPI document and the path it was found at, or ``({}, "")``."""
    if not _LOOPBACK.match(base_url.rstrip("/")):
        return {}, ""
    for path in OPENAPI_PATHS:
        try:
            status, _h, data, _ms = _request(
                "GET",
                base_url.rstrip("/") + path,
                None,
                {"Accept": "application/json"},
                timeout,
            )
        except (urllib.error.URLError, OSError, ValueError):
            continue
        if status != 200:
            continue
        try:
            document = json.loads(data.decode("utf-8", errors="replace"))
        except ValueError:
            continue
        if isinstance(document, dict) and (
            "openapi" in document or "swagger" in document
        ):
            return document, path
    return {}, ""


def _base_path(document: dict) -> str:
    try:
        from docintel.api_capture import _openapi_base_path

        return _openapi_base_path(document)
    except Exception:  # noqa: BLE001
        return ""


def operations(document: dict) -> list[Operation]:
    """Every operation in an OpenAPI 3 / Swagger 2 document."""
    paths = document.get("paths") if isinstance(document, dict) else None
    if not isinstance(paths, dict):
        return []
    base = _base_path(document)
    out: list[Operation] = []
    for route, item in paths.items():
        if not isinstance(item, dict):
            continue
        shared = [p for p in item.get("parameters") or [] if isinstance(p, dict)]
        full_route = f"{base}/{str(route).lstrip('/')}" if base else str(route)
        for method in _METHODS:
            op = item.get(method)
            if not isinstance(op, dict):
                continue
            parameters = [
                resolve(p, document) for p in [*shared, *(op.get("parameters") or [])]
            ]
            request_schema = None
            required = False
            body = resolve(op.get("requestBody") or {}, document)
            content = body.get("content") if isinstance(body, dict) else None
            if isinstance(content, dict) and content:
                media = content.get("application/json") or next(
                    (v for k, v in content.items() if "json" in k),
                    next(iter(content.values())),
                )
                request_schema = (
                    (media or {}).get("schema") if isinstance(media, dict) else None
                )
                required = bool(body.get("required"))
            for parameter in parameters:  # Swagger 2 body parameter
                if parameter.get("in") == "body":
                    request_schema = parameter.get("schema")
                    required = bool(parameter.get("required"))
            responses: dict[str, dict | None] = {}
            for code, answer in (op.get("responses") or {}).items():
                answer = resolve(answer, document)
                schema = None
                media_map = answer.get("content") if isinstance(answer, dict) else None
                if isinstance(media_map, dict) and media_map:
                    media = media_map.get("application/json") or next(
                        (v for k, v in media_map.items() if "json" in k), None
                    )
                    schema = (
                        (media or {}).get("schema") if isinstance(media, dict) else None
                    )
                elif isinstance(answer, dict) and "schema" in answer:
                    schema = answer["schema"]
                responses[str(code)] = schema
            out.append(
                Operation(
                    method=method.upper(),
                    path=full_route,
                    operation_id=str(op.get("operationId") or ""),
                    summary=str(op.get("summary") or "")[:200],
                    request_schema=request_schema,
                    request_required=required,
                    parameters=[
                        p
                        for p in parameters
                        if p.get("in") in ("path", "query", "header")
                    ],
                    responses=responses,
                )
            )
    return out


def touched_operations(
    ops: list[Operation],
    project_dir: Path | str,
    changed_files: list[str] | None,
    root: str = ".",
) -> list[Operation]:
    """The operations served by a file the task changed.

    `find_handler` names the file declaring a route (the controller named for
    the resource, or a file declaring the route literal). An operation whose
    handler is not found is not claimed — "the task changed it" has to rest on
    a file, not on a guess.
    """
    changed = {p.replace("\\", "/").removeprefix("./") for p in changed_files or []}
    if not changed:
        return []
    try:
        from docintel.api_capture import ApiExchange
        from docintel.api_tests import find_handler
        from project.stack import detect_api_stack
    except Exception:  # noqa: BLE001
        return []
    app_dir = Path(project_dir) / root
    stack, _lang = detect_api_stack(app_dir)
    prefix = "" if root in (".", "") else root.rstrip("/") + "/"
    touched: list[Operation] = []
    cache: dict[str, str] = {}
    for op in ops:
        key = op.path
        if key not in cache:
            handler = find_handler(
                app_dir, ApiExchange(method=op.method, path=op.path), stack
            )
            cache[key] = f"{prefix}{handler}" if handler else ""
        op.handler = cache[key]
        if op.handler and op.handler in changed:
            op.touched = True
            touched.append(op)
    return touched


def _concrete_path(op: Operation, document: dict) -> tuple[str, dict]:
    path = op.path
    query: dict[str, Any] = {}
    for parameter in op.parameters:
        name = str(parameter.get("name") or "")
        if not name:
            continue
        value = parameter.get("example")
        if value is None:
            value = instance(
                parameter.get("schema") or {"type": parameter.get("type", "string")},
                document,
            )
        if value is None:
            value = 1
        if parameter.get("in") == "path":
            path = path.replace("{" + name + "}", str(value))
        elif parameter.get("in") == "query" and parameter.get("required"):
            query[name] = value
    path = re.sub(r"\{[^}]+\}", "1", path)
    return path, query


def build_call(op: Operation, document: dict) -> dict:
    """The call to make for ``op``: path, query, body and expected status."""
    path, query = _concrete_path(op, document)
    if query:
        from urllib.parse import urlencode

        path += ("&" if "?" in path else "?") + urlencode(
            {k: str(v) for k, v in query.items()}
        )
    body = instance(op.request_schema, document) if op.request_schema else None
    expected = op.expected_status
    return {
        "method": op.method,
        "path": path,
        "body": body,
        "expect_status": [expected] if expected else [],
        "response_schema": op.responses.get(str(expected)) if expected else None,
        "operation_id": op.operation_id,
        "handler": op.handler,
    }


def negative_call(op: Operation, document: dict) -> dict | None:
    """A call the API must refuse: the body emptied of its required fields."""
    if op.method not in ("POST", "PUT", "PATCH") or not op.request_schema:
        return None
    schema = resolve(op.request_schema, document)
    if not schema.get("required"):
        return None
    path, _query = _concrete_path(op, document)
    return {"method": op.method, "path": path, "body": {}, "expect_status": [400, 422]}


def _mask(text: str) -> tuple[str, bool]:
    """``(masked text, withheld)`` — secrets masked, injections withheld."""
    try:
        from docintel.redact import redact_text

        text, _kinds = redact_text(text)
    except Exception:  # noqa: BLE001 - masking is best effort, withholding is not
        pass
    try:
        from docintel.files import threat

        if threat(text, "verify-endpoint-response") != "safe":
            return "", True
    except Exception:  # noqa: BLE001
        pass
    return text, False


def call_endpoint(
    base_url: str,
    method: str,
    path: str,
    *,
    body: Any = None,
    headers: dict[str, str] | None = None,
    expect_status: list[int] | None = None,
    response_schema: dict | None = None,
    document: dict | None = None,
    allow_mutations: bool = True,
    timeout: float = 30.0,
) -> EndpointResult:
    """Call one endpoint of the launched app and judge the answer. Never raises."""
    method = (method or "GET").upper()
    result = EndpointResult(
        method=method, path=path, expected=list(expect_status or []), request_body=body
    )
    base = (base_url or "").rstrip("/")
    if not _LOOPBACK.match(base):
        result.outcome, result.note = (
            "refused",
            "only the app launched on loopback may be called",
        )
        return result
    if (
        not path.startswith("/")
        or "://" in path
        or path.startswith("//")
        or "\n" in path
    ):
        result.outcome, result.note = "refused", "a path, not a URL, is expected"
        return result
    if method in _MUTATING and not allow_mutations:
        result.outcome, result.note = "skipped-mutation", "VERIFY_ALLOW_MUTATIONS=false"
        return result

    payload: bytes | None = None
    sent_headers = {"Accept": "application/json"}
    for key, value in (headers or {}).items():
        if isinstance(key, str) and isinstance(value, str) and "\n" not in key + value:
            sent_headers[key] = value
    if body is not None:
        payload = (body if isinstance(body, str) else json.dumps(body)).encode("utf-8")
        sent_headers.setdefault("Content-Type", "application/json")
    try:
        status, response_headers, data, elapsed = _request(
            method, base + path, payload, sent_headers, timeout
        )
    except (urllib.error.URLError, OSError, ValueError) as exc:
        result.outcome, result.note = "unreachable", str(exc)[:200]
        return result

    result.status = status
    result.latency_ms = round(elapsed, 1)
    result.content_type = str(
        response_headers.get("Content-Type")
        or response_headers.get("content-type")
        or ""
    )
    text = data[:_MAX_BODY].decode("utf-8", errors="replace")
    masked, withheld = _mask(text)
    result.response_excerpt = (
        "[withheld: the response reads as an instruction]"
        if withheld
        else masked[:_EXCERPT]
    )

    if status in (401, 403) and not any(s in (401, 403) for s in result.expected):
        result.outcome = "auth"
        result.note = "authentication required — not verified, not failed"
        result.ok = False
        return result

    result.ok = status in result.expected if result.expected else 200 <= status < 300
    if response_schema and "json" in result.content_type.lower() and not withheld:
        try:
            parsed = json.loads(text) if text.strip() else None
        except ValueError:
            parsed = None
            result.problems.append("$: response is not valid JSON")
        if parsed is not None or not result.problems:
            result.problems += validate(parsed, response_schema, document or {})
        result.schema_ok = not result.problems
        if result.problems:
            result.ok = False
    if status >= 500:
        result.ok = False
    return result
