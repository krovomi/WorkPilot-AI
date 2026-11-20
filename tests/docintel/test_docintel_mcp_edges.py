"""`workpilot-docintel` at the edges its usual callers never reach.

`test_docintel_mcp.py` holds the boundary and the protocol through a real
launcher. This file asks what a model's arguments can still get wrong: a
folder or an oversized file for a path, a diagram file that holds none, a
trace too long, a task named for the ERD and sequence checks, a capture with
no request, a server without the hardened XML parser, and a tool that fails
in a way nobody planned for, which must answer and keep serving.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest
from docintel import mcp_server
from docintel.mcp_server import handle, serve


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    (root / "docs").mkdir(parents=True)
    (root / ".workpilot" / "specs" / "001-orders" / "attachments").mkdir(parents=True)
    return root.resolve()


def call(root: Path, name: str, arguments: dict | None = None) -> dict:
    reply = handle(
        root,
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments or {}},
        },
    )
    return reply["result"]


def text(result: dict) -> str:
    return result["content"][0]["text"]


class TestPaths:
    def test_a_folder_is_not_a_diagram(self, project):
        result = call(project, "docintel_parse_diagram", {"path": "docs"})

        assert result["isError"] and "is not a file" in text(result)

    def test_a_diagram_over_the_limit_is_refused(self, project, monkeypatch):
        (project / "docs" / "big.drawio").write_text("<mxfile/>" * 4, encoding="utf-8")
        monkeypatch.setattr(mcp_server, "MAX_DIAGRAM_BYTES", 8)

        result = call(project, "docintel_parse_diagram", {"path": "docs/big.drawio"})

        assert result["isError"] and "larger than 8 bytes" in text(result)

    def test_a_file_that_holds_no_diagram_says_so(self, project):
        (project / "docs" / "notes.drawio").write_text("just notes", encoding="utf-8")

        result = call(project, "docintel_parse_diagram", {"path": "docs/notes.drawio"})

        assert not result["isError"]
        assert (
            text(result) == "docs/notes.drawio holds no draw.io or Excalidraw diagram."
        )

    def test_without_the_hardened_parser_no_diagram_is_read(self, project, monkeypatch):
        monkeypatch.setattr(mcp_server, "xml_available", lambda: False)

        result = call(project, "docintel_parse_diagram", {"path": "docs/x.drawio"})

        assert result["isError"] and "defusedxml" in text(result)


class TestTasks:
    def test_the_erd_and_sequence_checks_read_the_named_task(self, project):
        spec = {"spec_id": "001-orders"}

        erd = json.loads(text(call(project, "docintel_erd", spec)))
        sequences = json.loads(text(call(project, "docintel_sequences", spec)))

        assert erd["summary"] == "No ERD to compare."
        assert sequences["summary"] == "No sequence diagram found."

    @pytest.mark.parametrize(
        ("spec_id", "message"),
        [("..", "not a directory name"), ("002-missing", "no task")],
    )
    def test_a_task_that_is_not_one_is_refused(self, project, spec_id, message):
        result = call(project, "docintel_sequences", {"spec_id": spec_id})

        assert result["isError"] and message in text(result)

    def test_attachments_need_a_task(self, project):
        result = call(project, "docintel_attachments", {"spec_id": ""})

        assert result["isError"] and "missing argument" in text(result)


class TestTracesAndCaptures:
    def test_a_trace_over_the_limit_is_refused(self, project, monkeypatch):
        monkeypatch.setattr(mcp_server, "MAX_TRACE_CHARS", 10)

        result = call(project, "docintel_stacktrace", {"text": "x" * 11})

        assert result["isError"] and "longer than 10 characters" in text(result)

    def test_a_capture_must_be_a_file_within_the_limit(self, project, monkeypatch):
        (project / "docs" / "calls.http").write_text("GET /x\n" * 4, encoding="utf-8")
        monkeypatch.setattr(mcp_server, "MAX_DIAGRAM_BYTES", 8)

        folder = call(project, "docintel_api_test", {"path": "docs"})
        big = call(project, "docintel_api_test", {"path": "docs/calls.http"})

        assert folder["isError"] and "is not a file" in text(folder)
        assert big["isError"] and "larger than 8 bytes" in text(big)

    def test_a_file_without_requests_says_so(self, project):
        (project / "docs" / "readme.md").write_text("# Nothing", encoding="utf-8")

        result = call(project, "docintel_api_test", {"path": "docs/readme.md"})

        assert not result["isError"]
        assert "holds no Postman, OpenAPI, .http or curl request" in text(result)


class TestServing:
    def test_a_ping_is_answered(self, project):
        reply = handle(project, {"jsonrpc": "2.0", "id": 9, "method": "ping"})

        assert reply == {"jsonrpc": "2.0", "id": 9, "result": {}}

    def test_a_stream_that_cannot_be_reconfigured_is_left_as_is(self):
        stream = io.StringIO()

        assert mcp_server._utf8(stream) is stream

    def test_a_tool_that_breaks_is_an_error_and_the_server_goes_on(
        self, project, monkeypatch, capsys
    ):
        def broken(_root, _args):
            raise RuntimeError("rules unavailable")

        monkeypatch.setitem(mcp_server._HANDLERS, "docintel_rules", broken)
        lines = [
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": "docintel_rules"},
                }
            ),
            "",
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
        ]
        stdout = io.StringIO()

        serve(project, stdin=io.StringIO("\n".join(lines)), stdout=stdout)

        replies = [json.loads(line) for line in stdout.getvalue().splitlines()]
        assert replies == [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "error": {"code": -32603, "message": "rules unavailable"},
            },
            {"jsonrpc": "2.0", "id": 2, "result": {}},
        ]
        assert "RuntimeError: rules unavailable" in capsys.readouterr().err
