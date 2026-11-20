"""HTTP captures of every shape a person, an export or OCR hands over.

`test_docintel_code.py` reads a well-formed Postman collection, an OpenAPI
file, a `.http` file, curl lines and a Postman screenshot. This file reads
what those tools also produce: a collection edited by hand where lists hold
strings, operations that are not methods, examples kept three ways, headers a
test never sets, values the secret scan cannot read, curl lines that do not
parse, and documents that are no capture at all. Nothing raises; what cannot
be a request is not one.
"""

from __future__ import annotations

import json

import pytest
from docintel import redact
from docintel.api_capture import (
    MAX_BODY_CHARS,
    PLACEHOLDER,
    parse_exchanges,
    route_of,
)

from tests.test_docintel_engines import AWS_KEY


def postman(*items) -> str:
    return json.dumps(
        {
            "info": {"schema": "https://schema.getpostman.com/json/v2.1.0"},
            "item": list(items),
        }
    )


def openapi(paths: dict, **extra) -> str:
    return json.dumps({"openapi": "3.0.0", "paths": paths, **extra})


def scanner_refuses(monkeypatch, marker: str) -> None:
    real = redact.redact_text

    def redact_text(text: str):
        if marker in text:
            raise redact.ScannerUnavailable("no patterns")
        return real(text)

    monkeypatch.setattr(redact, "redact_text", redact_text)


class TestCleaning:
    def test_a_route_without_its_slash_gets_one(self):
        assert route_of("api//orders?page=2") == "/api/orders"

    def test_transport_headers_go_and_a_secret_value_is_masked(self):
        [exchange] = parse_exchanges(
            "GET https://shop.test/api/orders\n"
            "Host: shop.test\n"
            f"X-Trace: {AWS_KEY}\n"
            "Accept: application/json\n",
            "calls.http",
        )

        assert "Host" not in exchange.headers
        assert AWS_KEY not in exchange.headers["X-Trace"]
        assert exchange.headers["Accept"] == "application/json"
        assert exchange.redacted == ["X-Trace"]

    def test_values_the_secret_scan_cannot_read_are_not_kept(self, monkeypatch):
        scanner_refuses(monkeypatch, "opaque")

        [exchange] = parse_exchanges(
            'POST /api/orders\nX-Trace: opaque-1\n\n{"note": "opaque"}\n',
            "calls.http",
        )

        assert exchange.headers["X-Trace"] == PLACEHOLDER
        assert exchange.redacted == ["X-Trace"]
        assert exchange.body == ""

    def test_a_long_body_is_cut_to_its_ceiling(self):
        [exchange] = parse_exchanges(
            "POST /api/notes\n\n" + "x" * (MAX_BODY_CHARS + 50), "calls.http"
        )

        assert len(exchange.body) == MAX_BODY_CHARS

    def test_a_header_block_line_that_is_no_header_is_skipped(self):
        [exchange] = parse_exchanges(
            "GET /api/orders\n!!! not a header\nAccept: text/plain\n", "calls.http"
        )

        assert exchange.headers == {"Accept": "text/plain"}


class TestPostman:
    def test_items_of_another_shape_are_skipped(self):
        text = postman(
            "not an item",
            {"name": "No request", "request": 5},
            {"name": "Unknown verb", "request": {"method": "BREW", "url": "/tea"}},
            {
                "name": "Hand edited",
                "request": {"method": "GET", "url": "/api/orders", "header": "x"},
                "response": [3, {"code": "ok"}, {"code": 200}],
                "event": ["not an event", {"script": "not a script"}],
            },
            {"name": "Short form", "request": "https://shop.test/api/health"},
        )

        exchanges = parse_exchanges(text, "shop.postman_collection.json")

        assert [(e.name, e.method, e.path, e.status) for e in exchanges] == [
            ("Hand edited", "GET", "/api/orders", 200),
            ("Short form", "GET", "/api/health", None),
        ]

    def test_a_url_given_by_its_path_segments_is_read(self):
        text = postman(
            {"name": "Order", "request": {"url": {"path": ["api", "orders", ":id"]}}},
            {"name": "Nowhere", "request": {"url": 42}},
            {"name": "No path", "request": {"url": {"host": ["shop"], "path": "x"}}},
        )

        [exchange] = parse_exchanges(text, "c.json")

        assert exchange.path == "/api/orders/{id}"

    def test_a_collection_whose_items_are_no_list_has_no_request(self):
        text = json.dumps(
            {"info": {"schema": "https://schema.getpostman.com/x"}, "item": 5}
        )

        assert parse_exchanges(text, "c.json") == []


class TestOpenApi:
    def test_a_json_document_of_no_known_kind_is_no_capture(self):
        assert parse_exchanges(json.dumps({"name": "package"}), "package.json") == []
        assert parse_exchanges(json.dumps({"openapi": "3.0.0"}), "o.json") == []

    def test_entries_that_are_not_operations_are_skipped(self):
        text = openapi(
            {
                "/health": "not an operation map",
                "/orders": {
                    "parameters": "not a list",
                    "x-internal": {"summary": "not a method"},
                    "summary": "neither",
                    "get": {"operationId": "listOrders", "responses": "200"},
                },
                "": {"get": {"operationId": "noRoute"}},
            }
        )

        [exchange] = parse_exchanges(text, "openapi.json")

        assert (exchange.name, exchange.path, exchange.status) == (
            "listOrders",
            "/orders",
            None,
        )

    def test_required_headers_and_examples_kept_three_ways(self):
        text = openapi(
            {
                "/orders": {
                    "post": {
                        "operationId": "create",
                        "parameters": [
                            "not a parameter",
                            {
                                "in": "header",
                                "name": "X-Tenant",
                                "required": True,
                                "schema": {"example": "acme"},
                            },
                            {"in": "header", "name": "X-Request", "required": True},
                            {"in": "query", "name": "page"},
                            {
                                "in": "header",
                                "name": "X-Odd",
                                "required": True,
                                "schema": "string",
                            },
                        ],
                        "requestBody": {
                            "content": {
                                "application/json": {
                                    "examples": {"one": {"value": {"qty": 2}}}
                                }
                            }
                        },
                        "responses": {"201": {}},
                    },
                    "put": {
                        "operationId": "replace",
                        "requestBody": {
                            "content": {
                                "application/json": {"schema": {"example": "raw"}}
                            }
                        },
                    },
                    "patch": {
                        "operationId": "amend",
                        "requestBody": {"content": {"text/plain": "not a media"}},
                    },
                    "delete": {
                        "operationId": "remove",
                        "requestBody": {
                            "content": {"application/json": {"examples": {"a": "x"}}}
                        },
                    },
                    "head": {
                        "operationId": "peek",
                        "requestBody": {"content": {"application/json": {}}},
                    },
                }
            }
        )

        by_name = {e.name: e for e in parse_exchanges(text, "openapi.json")}

        create = by_name["create"]
        assert create.headers == {
            "X-Tenant": "acme",
            "X-Request": "<X-Request>",
            "X-Odd": "<X-Odd>",
            "Content-Type": "application/json",
        }
        assert json.loads(create.body) == {"qty": 2} and create.status == 201
        assert by_name["replace"].body == "raw"
        assert by_name["remove"].body == "x"
        assert by_name["amend"].body == by_name["peek"].body == ""
        assert "Content-Type" not in by_name["peek"].headers

    def test_a_swagger_body_parameter_gives_the_body(self):
        text = json.dumps(
            {
                "swagger": "2.0",
                "paths": {
                    "/orders": {
                        "post": {
                            "operationId": "create",
                            "parameters": [{"in": "body", "example": {"qty": 1}}],
                        }
                    }
                },
            }
        )

        [exchange] = parse_exchanges(text, "swagger.json")

        assert json.loads(exchange.body) == {"qty": 1}

    def test_paths_that_are_no_map_have_no_request(self):
        assert parse_exchanges(openapi("nope"), "o.json") == []


class TestCurlAndHttp:
    def test_curl_lines_read_their_url_and_json_and_skip_what_does_not_parse(self):
        text = (
            "curl 'https://shop.test/api/broken\n"
            "curl -s --json '{\"qty\": 1}' --url https://shop.test/api/orders\n"
            "curl -s -k\n"
        )

        [exchange] = parse_exchanges(text, "notes.txt")

        assert (exchange.method, exchange.path) == ("POST", "/api/orders")
        assert exchange.headers == {"Content-Type": "application/json"}

    def test_an_option_value_is_never_taken_for_the_url(self):
        text = (
            "curl https://shop.test/api/orders -o out.json -u alice:hunter2 "
            "-b session=abc -A probe -w '%{http_code}' --max-time 5\n"
        )

        [exchange] = parse_exchanges(text, "notes.txt")

        assert (exchange.method, exchange.path) == ("GET", "/api/orders")
        assert exchange.headers == {
            "Authorization": PLACEHOLDER,
            "Cookie": PLACEHOLDER,
        }
        assert sorted(exchange.redacted) == ["Authorization", "Cookie"]
        assert "hunter2" not in json.dumps(exchange.to_dict())

    def test_an_attached_option_value_is_read_too(self):
        [exchange] = parse_exchanges(
            "curl -ualice:hunter2 -oout.json https://shop.test/api/me\n", "notes.txt"
        )

        assert exchange.path == "/api/me" and exchange.redacted == ["Authorization"]


class TestOcr:
    def test_a_screenshot_without_a_status_or_with_a_garbled_body(self):
        [exchange] = parse_exchanges(
            "GET /api/orders\n" + "[" * 100_000, "shot.png", ocr=True
        )

        assert (exchange.status, exchange.body) == (None, "")

    def test_a_screenshot_without_a_request_has_none(self):
        assert parse_exchanges("Postman — no request here", "shot.png", ocr=True) == []


class TestDocuments:
    @pytest.mark.parametrize(
        "text",
        [
            "{ not json",
            "openapi: 3.0.0\npaths: [unclosed\n",
            "openapi: 3.0.0\n",
        ],
    )
    def test_a_document_that_cannot_be_read_is_no_capture(self, text):
        assert parse_exchanges(text, "openapi.yaml") == []
