"""An HTTP call somebody attached to a task — as a collection, a spec, or a screenshot.

"This request should return 201" arrives as a Postman collection, a
`swagger.json`, a `.http` file from Rider or VS Code, a `curl` line pasted in a
ticket, or a screenshot of Postman or Swagger UI. Each says the same five
things — method, route, headers, body, expected status — and each is the
material of an integration test the task would otherwise leave to be imagined.

| Source | Read as |
|---|---|
| Postman collection (v2.0 / v2.1) | items, `request`, saved example responses, `pm.response.to.have.status(…)` |
| OpenAPI 3 / Swagger 2 (JSON or YAML) | every operation, first 2xx response, request example, header parameters |
| `.http` / `.rest` | request line, headers, body, `###` separators |
| `curl` | `-X`, `-H`, `-d` / `--data*`, the URL |
| OCR text of a screenshot | `POST /api/orders`, `Header: value`, `201 Created`, the first JSON body — **only when nothing above exists** |

**Structured first, pixels last.** A collection states the route exactly; OCR
reads `/api/0rders`. When a task carries both, the screenshot is not read for
exchanges at all.

**A credential is not test data.** `Authorization`, `Cookie`, API-key headers
are replaced by a placeholder, and every other value goes through the same
secret patterns as the rest of docintel: a bearer token copied into a test file
is a token committed to the repository.
"""

from __future__ import annotations

import json
import re
import shlex
from dataclasses import asdict, dataclass, field
from urllib.parse import urlsplit

from . import redact

MAX_EXCHANGES = 25
MAX_BODY_CHARS = 4000
METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
_SENSITIVE_HEADERS = {
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
    "apikey",
    "x-auth-token",
    "x-access-token",
    "ocp-apim-subscription-key",
}
#: Headers a test never sets itself: the client and the transport do.
_TRANSPORT_HEADERS = {
    "host",
    "content-length",
    "connection",
    "accept-encoding",
    "user-agent",
    "postman-token",
    "cache-control",
}
PLACEHOLDER = "<redacted>"


@dataclass
class ApiExchange:
    method: str
    #: The route, host removed: `/api/orders/{id}` — a test targets the app, not a URL.
    path: str
    headers: dict[str, str] = field(default_factory=dict)
    body: str = ""
    #: The status the source expects, or None when it does not say.
    status: int | None = None
    name: str = ""
    #: ``postman``, ``openapi``, ``http-file``, ``curl``, ``ocr``.
    origin: str = ""
    source: str = ""
    #: Header names whose value was replaced by a placeholder.
    redacted: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Cleaning: routes, headers, secrets
# ---------------------------------------------------------------------------

_VARIABLE_HOST = re.compile(r"^\{\{[^}]+\}\}")


def route_of(url: str) -> str:
    """`{{baseUrl}}/api/orders?x=1`, `https://h:5001/api/orders` -> `/api/orders`."""
    url = (url or "").strip()
    url = _VARIABLE_HOST.sub("", url)
    if "://" in url:
        url = urlsplit(url).path or "/"
    url = url.split("?", 1)[0].split("#", 1)[0]
    # Postman `:id` and `{{id}}` path variables read as OpenAPI's `{id}`.
    url = re.sub(r"\{\{(\w+)\}\}", r"{\1}", url)
    url = re.sub(r"(?<=/):(\w+)", r"{\1}", url)
    if not url.startswith("/"):
        url = "/" + url
    return re.sub(r"/{2,}", "/", url)


def _clean_headers(headers: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    kept: dict[str, str] = {}
    redacted: list[str] = []
    for name, value in headers.items():
        key = name.strip()
        lower = key.lower()
        if not key or lower in _TRANSPORT_HEADERS:
            continue
        if lower in _SENSITIVE_HEADERS:
            kept[key] = PLACEHOLDER
            redacted.append(key)
            continue
        try:
            masked, kinds = redact.redact_text(str(value))
        except redact.ScannerUnavailable:
            masked, kinds = PLACEHOLDER, ["unverified"]
        if kinds:
            redacted.append(key)
        kept[key] = masked.strip()
    return kept, redacted


def _clean_body(body: str) -> str:
    body = (body or "").strip()
    if len(body) > MAX_BODY_CHARS:
        body = body[:MAX_BODY_CHARS]
    try:
        masked, _kinds = redact.redact_text(body)
    except redact.ScannerUnavailable:
        return ""
    return masked


def _exchange(
    method: str,
    url: str,
    headers: dict[str, str] | None,
    body: str,
    status: int | None,
    *,
    name: str,
    origin: str,
    source: str,
) -> ApiExchange | None:
    method = (method or "").upper()
    if method not in METHODS or not url:
        return None
    kept, redacted = _clean_headers(headers or {})
    return ApiExchange(
        method=method,
        path=route_of(url),
        headers=kept,
        body=_clean_body(body),
        status=status if status and 100 <= status <= 599 else None,
        name=name.strip()[:120],
        origin=origin,
        source=source,
        redacted=redacted,
    )


# ---------------------------------------------------------------------------
# Postman
# ---------------------------------------------------------------------------

_PM_STATUS = re.compile(
    r"(?:to\.have\.status|response\.code\)\.to\.(?:eql|equal)|status\)\.to\.(?:eql|equal))\(\s*(\d{3})"
)


def _postman_url(url) -> str:
    if isinstance(url, str):
        return url
    if isinstance(url, dict):
        if url.get("raw"):
            return str(url["raw"])
        path = url.get("path") or []
        if isinstance(path, list):
            return "/" + "/".join(str(p) for p in path)
    return ""


def _postman_items(items, source: str) -> list[ApiExchange]:
    out: list[ApiExchange] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("item"), list):
            out.extend(_postman_items(item["item"], source))
            continue
        request = item.get("request")
        if isinstance(request, str):
            request = {"method": "GET", "url": request}
        if not isinstance(request, dict):
            continue
        headers = {
            str(h.get("key", "")): str(h.get("value", ""))
            for h in request.get("header") or []
            if isinstance(h, dict) and not h.get("disabled")
        }
        body = request.get("body") or {}
        raw = body.get("raw", "") if isinstance(body, dict) else ""
        status = None
        for response in item.get("response") or []:
            if isinstance(response, dict) and str(response.get("code", "")).isdigit():
                status = int(response["code"])
                break
        for event in item.get("event") or []:
            script = (event or {}).get("script") or {}
            exec_ = script.get("exec") if isinstance(script, dict) else None
            source_text = (
                "\n".join(exec_) if isinstance(exec_, list) else str(exec_ or "")
            )
            if m := _PM_STATUS.search(source_text):
                status = int(m.group(1))
        if exchange := _exchange(
            str(request.get("method", "GET")),
            _postman_url(request.get("url")),
            headers,
            str(raw or ""),
            status,
            name=str(item.get("name", "")),
            origin="postman",
            source=source,
        ):
            out.append(exchange)
    return out


def parse_postman(document: dict, source: str) -> list[ApiExchange]:
    info = document.get("info") or {}
    schema = str(info.get("schema", "")) if isinstance(info, dict) else ""
    if "getpostman" not in schema and not (
        isinstance(document.get("item"), list) and info
    ):
        return []
    return _postman_items(document.get("item"), source)


# ---------------------------------------------------------------------------
# OpenAPI / Swagger
# ---------------------------------------------------------------------------


def _example(node) -> str:
    if not isinstance(node, dict):
        return ""
    if "example" in node:
        value = node["example"]
    elif isinstance(node.get("examples"), dict) and node["examples"]:
        first = next(iter(node["examples"].values()))
        value = first.get("value") if isinstance(first, dict) else first
    elif isinstance(node.get("schema"), dict) and "example" in node["schema"]:
        value = node["schema"]["example"]
    else:
        return ""
    return (
        value
        if isinstance(value, str)
        else json.dumps(value, indent=2, ensure_ascii=False)
    )


def _openapi_base_path(document: dict) -> str:
    """The path every operation hangs under: Swagger 2's `basePath`, or the
    path of OpenAPI 3's first server (`https://h/api/v1` or `/api/v1`).

    A server URL with a `{variable}` names no path a test can call, so it is
    left out rather than guessed.
    """
    if isinstance(document.get("basePath"), str):
        base = document["basePath"]
    else:
        servers = document.get("servers")
        first = servers[0] if isinstance(servers, list) and servers else {}
        url = first.get("url", "") if isinstance(first, dict) else ""
        base = urlsplit(url).path if "://" in url else url
    base = (base or "").strip().rstrip("/")
    if not base or "{" in base or not base.startswith("/"):
        return ""
    return base


def parse_openapi(document: dict, source: str) -> list[ApiExchange]:
    if not ("openapi" in document or "swagger" in document):
        return []
    paths = document.get("paths")
    if not isinstance(paths, dict):
        return []
    base = _openapi_base_path(document)
    out: list[ApiExchange] = []
    for route, operations in paths.items():
        if not isinstance(operations, dict):
            continue
        route = f"{base}/{str(route).lstrip('/')}" if base else route
        shared = operations.get("parameters") or []
        for method, operation in operations.items():
            if method.upper() not in METHODS or not isinstance(operation, dict):
                continue
            responses = operation.get("responses") or {}
            codes = sorted(str(c) for c in responses if str(c).isdigit())
            success = next(
                (c for c in codes if c.startswith("2")), codes[0] if codes else ""
            )
            headers: dict[str, str] = {}
            body = ""
            for parameter in [*shared, *(operation.get("parameters") or [])]:
                if not isinstance(parameter, dict):
                    continue
                if parameter.get("in") == "header" and parameter.get("required"):
                    example = parameter.get("example") or (
                        parameter.get("schema") or {}
                    ).get("example")
                    headers[str(parameter.get("name", ""))] = str(
                        example or f"<{parameter.get('name')}>"
                    )
                elif parameter.get("in") == "body":
                    body = _example(parameter)
            request_body = operation.get("requestBody") or {}
            content = (
                request_body.get("content") if isinstance(request_body, dict) else None
            )
            if isinstance(content, dict):
                media = content.get("application/json") or next(
                    iter(content.values()), {}
                )
                body = body or _example(media)
                if body:
                    headers.setdefault("Content-Type", "application/json")
            if exchange := _exchange(
                method,
                str(route),
                headers,
                body,
                int(success) if success else None,
                name=str(
                    operation.get("operationId") or operation.get("summary") or ""
                ),
                origin="openapi",
                source=source,
            ):
                out.append(exchange)
    return out


# ---------------------------------------------------------------------------
# .http files and curl
# ---------------------------------------------------------------------------

_REQUEST_LINE = re.compile(
    rf"^\s*(?P<method>{'|'.join(METHODS)})\s+(?P<url>\S+)(?:\s+HTTP/[\d.]+)?\s*$",
    re.I | re.M,
)
_HEADER_LINE = re.compile(r"^\s*(?P<name>[A-Za-z][\w-]*)\s*:\s*(?P<value>.*)$")


def parse_http_file(text: str, source: str) -> list[ApiExchange]:
    out: list[ApiExchange] = []
    for block in re.split(r"^###.*$", text or "", flags=re.M):
        lines = [
            line
            for line in block.splitlines()
            if not line.lstrip().startswith(("#", "//", "@"))
        ]
        start = next(
            (i for i, line in enumerate(lines) if _REQUEST_LINE.match(line)), None
        )
        if start is None:
            continue
        request = _REQUEST_LINE.match(lines[start])
        headers: dict[str, str] = {}
        index = start + 1
        while index < len(lines) and lines[index].strip():
            if m := _HEADER_LINE.match(lines[index]):
                headers[m["name"]] = m["value"]
            index += 1
        body = "\n".join(lines[index:]).strip()
        if exchange := _exchange(
            request["method"],
            request["url"],
            headers,
            body,
            None,
            name="",
            origin="http-file",
            source=source,
        ):
            out.append(exchange)
    return out


_CURL_DATA = ("-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--json")
#: Options that take a value; every other option is a flag.
_CURL_VALUED = {"-X", "--request", "-H", "--header", "--url", *_CURL_DATA}
_CURL_SHORT_VALUED = ("-X", "-H", "-d")


def _curl_option(argv: list[str], index: int) -> tuple[str, str, int]:
    """(option, value, next index) — "" as option for a positional URL.

    curl takes a value three ways: `-X POST`, `-XPOST` and `--request=POST`;
    reading only the first would drop the method or the header of the other
    two and draft a test for a request nobody made.
    """
    arg = argv[index]
    following = argv[index + 1] if index + 1 < len(argv) else ""
    if not arg.startswith("-"):
        return "", arg, index + 1
    if arg.startswith("--") and "=" in arg:
        name, _, value = arg.partition("=")
        return name, value, index + 1
    if arg in _CURL_VALUED:
        return arg, following, index + 2
    for short in _CURL_SHORT_VALUED:
        if arg.startswith(short) and len(arg) > len(short):
            return short, arg[len(short) :], index + 1
    return arg, "", index + 1


def parse_curl(text: str, source: str) -> list[ApiExchange]:
    out: list[ApiExchange] = []
    joined = re.sub(r"\\\r?\n", " ", text or "")
    for line in joined.splitlines():
        stripped = line.strip()
        if not stripped.startswith("curl "):
            continue
        try:
            argv = shlex.split(stripped)
        except ValueError:
            continue
        method, url, body = "", "", ""
        headers: dict[str, str] = {}
        index = 1
        while index < len(argv):
            arg, value, index = _curl_option(argv, index)
            if arg in ("-X", "--request"):
                method = value
            elif arg in ("-I", "--head"):
                method = "HEAD"
            elif arg in ("-H", "--header"):
                name, _, val = value.partition(":")
                headers[name.strip()] = val.strip()
            elif arg in _CURL_DATA:
                body = value
                if arg == "--json":
                    headers.setdefault("Content-Type", "application/json")
            elif arg == "--url" or not arg:
                url = value
        if exchange := _exchange(
            method or ("POST" if body else "GET"),
            url,
            headers,
            body,
            None,
            name="",
            origin="curl",
            source=source,
        ):
            out.append(exchange)
    return out


# ---------------------------------------------------------------------------
# OCR: a screenshot of Postman or Swagger UI
# ---------------------------------------------------------------------------

_OCR_REQUEST = re.compile(
    rf"\b(?P<method>{'|'.join(METHODS)})\b\s+(?P<url>(?:https?://|\{{\{{\w+\}}\}}|/)[^\s\"'<>]+)"
)
_OCR_STATUS = re.compile(
    r"(?:\bStatus(?:\s*code)?\s*:?\s*(?P<a>[1-5]\d{2})\b|\b(?P<b>[1-5]\d{2})\s+(?:OK|Created|Accepted|No Content|"
    r"Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Unprocessable (?:Entity|Content)|"
    r"Internal Server Error)\b)",
    re.I,
)
_OCR_HEADER_NAMES = re.compile(
    r"^\s*(?P<name>Content-Type|Accept|Authorization|X-[\w-]+|Api-Key|If-Match|If-None-Match)\s*:?\s+(?P<value>\S.*)$",
    re.I | re.M,
)


def parse_ocr(text: str, source: str) -> list[ApiExchange]:
    """The request a screenshot shows. One per screenshot: what OCR read of the
    rest of the window is response, history and sidebar."""
    request = _OCR_REQUEST.search(text or "")
    if not request:
        return []
    after = text[request.end() :]
    status = None
    if m := _OCR_STATUS.search(after):
        status = int(m["a"] or m["b"])
    headers = {m["name"]: m["value"].strip() for m in _OCR_HEADER_NAMES.finditer(after)}
    body = ""
    try:
        from spec.plan_recovery import extract_json_document

        document = extract_json_document(after)
        if isinstance(document, (dict, list)):
            body = json.dumps(document, indent=2, ensure_ascii=False)
    except Exception:  # noqa: BLE001 - a body OCR garbled is no body
        body = ""
    exchange = _exchange(
        request["method"],
        request["url"],
        headers,
        body,
        status,
        name="",
        origin="ocr",
        source=source,
    )
    return [exchange] if exchange else []


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


def _structured(text: str) -> dict | None:
    stripped = (text or "").lstrip()
    if stripped.startswith("{"):
        try:
            document = json.loads(stripped)
        except ValueError:
            return None
        return document if isinstance(document, dict) else None
    if re.match(r"^(?:openapi|swagger)\s*:", stripped, re.M):
        try:
            import yaml

            document = yaml.safe_load(stripped)
        except Exception:  # noqa: BLE001 - YAML we cannot read is text
            return None
        return document if isinstance(document, dict) else None
    return None


def parse_exchanges(text: str, source: str, *, ocr: bool = False) -> list[ApiExchange]:
    """Every exchange `text` describes, whichever of the formats it is."""
    if ocr:
        return parse_ocr(text, source)
    if document := _structured(text):
        return (parse_postman(document, source) or parse_openapi(document, source))[
            :MAX_EXCHANGES
        ]
    found = parse_curl(text, source)
    if not found and _REQUEST_LINE.search(text or ""):
        found = parse_http_file(text, source)
    return found[:MAX_EXCHANGES]
