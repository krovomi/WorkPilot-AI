"""`workpilot-docintel`: the MCP server other agents ask about a project.

The property that matters most is the boundary: the server is started by
somebody else's agent and handed arguments that came out of a model, so every
path must stay inside the one project it serves. After that, that it speaks the
protocol a client expects, through the real launcher, over real stdio.
"""

from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from docintel.mcp_server import TOOLS, handle, serve  # noqa: E402

from tests.test_docintel import CLEAN_ARCHI, DRAWIO_FILE, NYGARD, _csproj  # noqa: E402


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    (root / "docs" / "adr").mkdir(parents=True)
    (root / "docs" / "adr" / "0003-clean.md").write_text(NYGARD, encoding="utf-8")
    (root / "docs" / "architecture.drawio").write_text(CLEAN_ARCHI, encoding="utf-8")
    _csproj(root, "Acme.Api", ["Acme.Application"])
    _csproj(root, "Acme.Application", ["Acme.Domain"])
    _csproj(root, "Acme.Domain", ["Acme.Infrastructure"])
    _csproj(root, "Acme.Infrastructure", ["Acme.Application"])
    spec = root / ".workpilot" / "specs" / "001-orders" / "attachments"
    spec.mkdir(parents=True)
    (spec / "flow.drawio").write_text(DRAWIO_FILE, encoding="utf-8")
    return root.resolve()


def call(root: Path, name: str, arguments: dict | None = None) -> dict:
    reply = handle(
        root,
        {
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments or {}},
        },
    )
    assert reply is not None and reply["id"] == 7
    return reply["result"]


def text(result: dict) -> str:
    return result["content"][0]["text"]


class TestProtocol:
    def test_initialize_announces_itself(self, project: Path):
        reply = handle(
            project,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-03-26"},
            },
        )
        result = reply["result"]
        assert result["protocolVersion"] == "2025-03-26"
        assert result["serverInfo"]["name"] == "workpilot-docintel"
        assert "docintel_rules" in result["instructions"]

    def test_every_tool_is_listed_and_read_only(self, project: Path):
        reply = handle(project, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        names = {tool["name"] for tool in reply["result"]["tools"]}
        assert names == {tool["name"] for tool in TOOLS}
        assert all(tool["annotations"]["readOnlyHint"] for tool in TOOLS)

    def test_notifications_get_no_reply(self, project: Path):
        assert (
            handle(project, {"jsonrpc": "2.0", "method": "notifications/initialized"})
            is None
        )

    def test_unknown_tool_and_method(self, project: Path):
        unknown = handle(
            project,
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "rm_rf"},
            },
        )
        assert unknown["error"]["code"] == -32602
        missing = handle(
            project, {"jsonrpc": "2.0", "id": 4, "method": "resources/list"}
        )
        assert missing["error"]["code"] == -32601


class TestTools:
    def test_adrs(self, project: Path):
        records = json.loads(
            text(call(project, "docintel_adrs", {"binding_only": True}))
        )
        assert [r["id"] for r in records] == ["ADR-0003"]
        assert records[0]["binding"] is True

    def test_rules_carry_adrs_and_diagram(self, project: Path):
        rules = text(call(project, "docintel_rules"))
        assert "ADR-0003" in rules
        assert "Architecture diagram vs. project references" in rules

    def test_rules_when_there_is_nothing(self, tmp_path: Path):
        assert "no ADR and no architecture diagram" in text(
            call(tmp_path, "docintel_rules")
        )

    def test_parse_diagram(self, project: Path):
        result = json.loads(
            text(
                call(
                    project,
                    "docintel_parse_diagram",
                    {"path": "docs/architecture.drawio"},
                )
            )
        )
        assert "Api -> Application" in result["summary"]
        assert result["diagram"]["format"] == "drawio"

    def test_conformance_reports_the_inverted_reference(self, project: Path):
        report = json.loads(text(call(project, "docintel_conformance")))
        kinds = {
            (f["source_project"], f["target_project"], f["kind"])
            for f in report["findings"]
        }
        assert ("Acme.Domain", "Acme.Infrastructure", "inverted") in kinds

    def test_attachments_read_without_writing(self, project: Path):
        result = json.loads(
            text(call(project, "docintel_attachments", {"spec_id": "001-orders"}))
        )
        assert result["documents"][0]["status"] == "diagram"
        assert not (
            project / ".workpilot" / "specs" / "001-orders" / "docintel"
        ).exists()


class TestBoundary:
    @pytest.mark.parametrize(
        "path", ["../outside.drawio", "/etc/passwd", "docs/../../outside.drawio", ""]
    )
    def test_a_path_outside_the_project_is_refused(self, project: Path, path: str):
        (project.parent / "outside.drawio").write_text(DRAWIO_FILE, encoding="utf-8")
        result = call(project, "docintel_parse_diagram", {"path": path})
        assert result["isError"] is True

    def test_a_link_leaving_the_project_is_refused(self, project: Path):
        outside = project.parent / "secret.drawio"
        outside.write_text(DRAWIO_FILE, encoding="utf-8")
        try:
            (project / "docs" / "link.drawio").symlink_to(outside)
        except (OSError, NotImplementedError):
            pytest.skip("symlinks need privileges on this platform")
        result = call(project, "docintel_parse_diagram", {"path": "docs/link.drawio"})
        assert result["isError"] is True and "outside the project" in text(result)

    @pytest.mark.parametrize("spec_id", ["../..", "a/b", "..", "missing"])
    def test_spec_id_is_a_task_of_this_project(self, project: Path, spec_id: str):
        assert (
            call(project, "docintel_attachments", {"spec_id": spec_id})["isError"]
            is True
        )

    def test_missing_argument_is_a_tool_error(self, project: Path):
        result = call(project, "docintel_parse_diagram", {})
        assert result["isError"] is True and "missing argument" in text(result)


class TestServe:
    def test_stdio_loop(self, project: Path):
        stdin = io.StringIO(
            "\n".join(
                [
                    json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "initialize",
                            "params": {},
                        }
                    ),
                    "not json",
                    json.dumps(
                        {"jsonrpc": "2.0", "method": "notifications/initialized"}
                    ),
                    json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": 2,
                            "method": "tools/call",
                            "params": {"name": "docintel_rules"},
                        }
                    ),
                ]
            )
        )
        stdout = io.StringIO()
        serve(project, stdin=stdin, stdout=stdout)
        replies = [json.loads(line) for line in stdout.getvalue().splitlines()]
        assert [r.get("id") for r in replies] == [1, None, 2]
        assert replies[1]["error"]["code"] == -32700
        assert "ADR-0003" in replies[2]["result"]["content"][0]["text"]

    def test_the_launcher_serves_over_real_stdio(self, project: Path):
        launcher = REPO_ROOT / "apps" / "backend" / "runners" / "docintel_mcp.py"
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 9,
                "method": "tools/call",
                "params": {"name": "docintel_adrs"},
            }
        )
        completed = subprocess.run(
            [sys.executable, str(launcher), "--project-dir", str(project)],
            input=request + "\n",
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
            check=False,
        )
        assert completed.returncode == 0, completed.stderr
        reply = json.loads(completed.stdout.strip().splitlines()[-1])
        assert json.loads(reply["result"]["content"][0]["text"])[0]["id"] == "ADR-0003"
