"""The deterministic pieces of the verification loop (`apps/backend/verify/`).

Each test pins a rule the loop relies on, not an implementation detail:

* detection reads files only, and finds an ASP.NET Core API, a Vite front end
  and a Node API the preview used to mistake for a page;
* the performance score is Lighthouse's curve, and a metric nobody measured
  is dropped, never scored as zero;
* an error printed twice is one error — the fix loop is bounded by the count;
* a payload is built from the schema, and a response is checked against it;
* the verdict is computed from what was measured, and an agent saying "pass"
  over a measured error does not upgrade it;
* a model may name a launch command only if it is a project launcher.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from verify.detect import detect_targets, free_port  # noqa: E402
from verify.endpoints import (  # noqa: E402
    build_call,
    call_endpoint,
    negative_call,
    operations,
)
from verify.errors import collect_errors, console_errors, network_errors  # noqa: E402
from verify.payloads import instance, validate  # noqa: E402
from verify.perf import (  # noqa: E402
    PerfResult,
    latency_score,
    latency_stats,
    metric_score,
    page_score,
    parse_lighthouse_summary,
    parse_trace_summary,
)
from verify.record import (  # noqa: E402
    compute_status,
    fold_events,
    new_record,
    render_report,
)
from verify.settings import load_settings  # noqa: E402
from verify.tools import (  # noqa: E402
    TOOL_NAMES,
    _launch_command_allowed,
    tool_definitions,
)

# ── detection ────────────────────────────────────────────────────────────────


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class TestDetect:
    def test_aspnet_core_api_is_a_backend_with_our_port(self, tmp_path):
        _write(
            tmp_path / "src" / "Shop.Api" / "Shop.Api.csproj",
            '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
        )
        _write(
            tmp_path / "tests" / "Shop.Api.Tests" / "Shop.Api.Tests.csproj",
            '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
        )
        detection = detect_targets(
            tmp_path, ["src/Shop.Api/Controllers/OrdersController.cs"]
        )
        assert [t.name for t in detection.targets] == ["Shop.Api"]
        api = detection.targets[0]
        assert api.kind == "backend-api"
        assert "--no-launch-profile" in api.command
        assert api.env["ASPNETCORE_URLS"] == "http://127.0.0.1:{port}"
        assert api.touched

    def test_vite_front_end_and_node_api_in_a_monorepo(self, tmp_path):
        _write(
            tmp_path / "apps" / "web" / "package.json",
            json.dumps(
                {
                    "name": "web",
                    "scripts": {"dev": "vite"},
                    "devDependencies": {"vite": "5"},
                }
            ),
        )
        _write(
            tmp_path / "apps" / "api" / "package.json",
            json.dumps(
                {
                    "name": "api",
                    "scripts": {"start:dev": "nest start"},
                    "dependencies": {"@nestjs/core": "10"},
                }
            ),
        )
        detection = detect_targets(tmp_path, ["apps/api/src/orders.controller.ts"])
        kinds = {t.name: t.kind for t in detection.targets}
        assert kinds == {"web": "web-frontend", "api": "backend-api"}
        assert [t.name for t in detection.primary()] == ["api"]

    def test_nothing_to_launch_is_said(self, tmp_path):
        _write(tmp_path / "lib.py", "def f(): pass\n")
        detection = detect_targets(tmp_path)
        assert not detection.applicable
        assert "nothing to launch" in detection.reason

    def test_a_learned_recipe_wins_over_detection(self, tmp_path):
        _write(tmp_path / "requirements.txt", "fastapi\nuvicorn\n")
        _write(tmp_path / "main.py", "app = None\n")
        _write(
            tmp_path / ".workpilot" / "verify" / "recipe.json",
            json.dumps(
                {
                    "targets": {
                        "fastapi": {
                            "command": "uvicorn app.main:app --port {port}",
                            "ready_path": "/health",
                        }
                    }
                }
            ),
        )
        target = detect_targets(tmp_path).targets[0]
        assert target.command == "uvicorn app.main:app --port {port}"
        assert target.ready_path == "/health"
        assert target.origin == "recipe"

    def test_free_port_is_a_port(self):
        assert 0 < free_port() < 65536


# ── performance ──────────────────────────────────────────────────────────────

TRACE_SUMMARY = """## Summary of Performance trace findings:
Metrics (lab / observed):
  - LCP: 233 ms, event: (eventKey: r-811, ts: 390047399), nodeId: 4
  - LCP breakdown:
    - TTFB: 4 ms, bounds: {min: 1µs, max: 2µs}
  - CLS: 0.00
"""


class TestPerf:
    def test_the_devtools_summary_is_read(self):
        assert parse_trace_summary(TRACE_SUMMARY) == {
            "lcp": 233.0,
            "ttfb": 4.0,
            "cls": 0.0,
        }

    def test_lighthouse_categories_are_read(self):
        text = "- Accessibility: 81 (accessibility)\n- Best Practices: 92 (best-practices)\n"
        assert parse_lighthouse_summary(text) == {
            "accessibility": 81,
            "best-practices": 92,
        }

    def test_lighthouse_curve_control_points(self):
        # At the p10 control point the score is 0.9, at the median 0.5.
        assert metric_score("lcp", 1200, "desktop") == pytest.approx(0.9, abs=0.01)
        assert metric_score("lcp", 2400, "desktop") == pytest.approx(0.5, abs=0.01)
        assert metric_score("cls", 0.0) == 1.0

    def test_an_unmeasured_metric_is_dropped_not_zero(self):
        result = page_score(PerfResult(lcp_ms=233, cls=0.0))
        assert result.score == 100
        assert result.scored_on == ["cls", "lcp"]
        nothing = page_score(PerfResult())
        assert nothing.score is None and not nothing.measured

    def test_latency(self):
        stats = latency_stats([10, 20, 30, 40, 1000])
        assert stats["p50_ms"] == 30 and stats["max_ms"] == 1000
        assert latency_stats([]) == {}
        assert latency_score(50) > latency_score(800)
        assert latency_score(None) is None


# ── errors ───────────────────────────────────────────────────────────────────


class TestErrors:
    def test_aspnet_fail_line_and_noise(self):
        log = (
            "info: Microsoft.Hosting.Lifetime[14]\n"
            "      Now listening on: http://127.0.0.1:5000\n"
            "fail: Microsoft.AspNetCore.Server.Kestrel[13]\n"
            "Build succeeded. 0 errors\n"
            "warn: something mildly odd\n"
        )
        errors = collect_errors(log)
        assert [e.kind for e in errors] == ["exception"]

    def test_the_same_error_twice_is_one_error(self):
        log = "Error: boom 1234\nError: boom 5678\n"
        assert len(collect_errors(log)) == 1

    def test_environment_errors_are_not_code_errors(self):
        log = "System.Exception: connection refused to localhost:5432\n"
        assert collect_errors(log)[0].kind == "environment"

    def test_console_and_network(self):
        console = "msgid=1 [error] boom from page (1 args)\nmsgid=2 [error] Failed to load resource favicon.ico\nmsgid=3 [log] ok"
        assert [e.message for e in console_errors(console)] == ["boom from page"]
        network = "reqid=1 GET http://127.0.0.1:5173/ [200]\nreqid=2 POST http://127.0.0.1:5173/api/orders [500]"
        assert [e.message for e in network_errors(network)] == [
            "POST http://127.0.0.1:5173/api/orders -> 500"
        ]


# ── payloads and endpoints ───────────────────────────────────────────────────

OPENAPI = {
    "openapi": "3.0.1",
    "paths": {
        "/api/orders/{id}": {
            "get": {
                "operationId": "GetOrder",
                "parameters": [
                    {
                        "name": "id",
                        "in": "path",
                        "required": True,
                        "schema": {"type": "integer"},
                    }
                ],
                "responses": {
                    "200": {
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/Order"}
                            }
                        }
                    }
                },
            }
        },
        "/api/orders": {
            "post": {
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/NewOrder"}
                        }
                    },
                },
                "responses": {
                    "201": {
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/Order"}
                            }
                        }
                    },
                    "400": {},
                },
            }
        },
    },
    "components": {
        "schemas": {
            "NewOrder": {
                "type": "object",
                "required": ["email", "quantity", "kind"],
                "properties": {
                    "email": {"type": "string", "format": "email"},
                    "quantity": {"type": "integer", "minimum": 1},
                    "kind": {"type": "string", "enum": ["standard", "express"]},
                    "note": {"type": "string", "nullable": True},
                },
            },
            "Order": {
                "allOf": [
                    {"$ref": "#/components/schemas/NewOrder"},
                    {
                        "type": "object",
                        "required": ["id"],
                        "properties": {"id": {"type": "integer", "readOnly": True}},
                    },
                ]
            },
        }
    },
}


class TestPayloads:
    def test_a_valid_body_from_the_schema(self):
        body = instance(OPENAPI["components"]["schemas"]["NewOrder"], OPENAPI)
        assert body == {
            "email": "verify@example.com",
            "quantity": 1,
            "kind": "standard",
        }
        assert (
            validate(body, OPENAPI["components"]["schemas"]["NewOrder"], OPENAPI) == []
        )

    def test_a_response_missing_a_field_is_reported(self):
        problems = validate(
            {"email": "a@b.c", "quantity": "2", "kind": "x"},
            {"$ref": "#/components/schemas/Order"},
            OPENAPI,
        )
        assert any("required property missing" in p for p in problems)
        assert any("quantity" in p and "integer" in p for p in problems)
        assert any("not one of" in p for p in problems)

    def test_operations_and_calls(self):
        ops = {(o.method, o.path): o for o in operations(OPENAPI)}
        get = build_call(ops[("GET", "/api/orders/{id}")], OPENAPI)
        assert get["path"] == "/api/orders/1" and get["expect_status"] == [200]
        post_op = ops[("POST", "/api/orders")]
        assert build_call(post_op, OPENAPI)["expect_status"] == [201]
        assert negative_call(post_op, OPENAPI)["expect_status"] == [400, 422]


class TestCallEndpoint:
    def test_only_loopback_is_called(self):
        assert call_endpoint("https://example.com", "GET", "/").outcome == "refused"
        assert (
            call_endpoint("http://127.0.0.1:1", "GET", "http://evil/").outcome
            == "refused"
        )

    def test_mutations_can_be_turned_off(self):
        result = call_endpoint(
            "http://127.0.0.1:9", "DELETE", "/api/x", allow_mutations=False
        )
        assert result.outcome == "skipped-mutation"


# ── record and verdict ───────────────────────────────────────────────────────


def _target(status="ready", errors=()):
    return {
        "name": "api",
        "kind": "backend-api",
        "launch": {"status": status},
        "errors": list(errors),
    }


class TestVerdict:
    def test_clean_launch_passes(self):
        record = new_record(targets=[_target()])
        assert compute_status(record) == ("pass", "")

    def test_a_remaining_error_fails(self):
        record = new_record(
            targets=[_target(errors=[{"kind": "exception", "message": "boom"}])]
        )
        assert compute_status(record)[0] == "fail"

    def test_an_agent_pass_does_not_hide_a_failed_endpoint(self):
        record = new_record(
            targets=[_target()],
            endpoints=[
                {"method": "GET", "path": "/x", "ok": False, "outcome": "called"}
            ],
            agent_verdicts=[{"verdict": "pass"}],
        )
        assert compute_status(record)[0] == "fail"

    def test_auth_required_is_not_a_failure(self):
        record = new_record(
            targets=[_target()], endpoints=[{"ok": False, "outcome": "auth"}]
        )
        assert compute_status(record)[0] == "pass"

    def test_environment_only_is_unknown(self):
        record = new_record(
            targets=[_target(errors=[{"kind": "environment", "message": "db down"}])]
        )
        assert compute_status(record)[0] == "unknown"

    def test_nothing_launched_is_unknown(self):
        record = new_record(mobile=[{"platform": "ios", "status": "blocked"}])
        assert compute_status(record)[0] == "unknown"

    def test_events_fold_and_the_report_ends_with_the_verdict(self):
        record = new_record(targets=[_target()])
        fold_events(
            record,
            [
                {"kind": "step", "action": "click", "text": 'button "Save"'},
                {"kind": "confirm", "state": "order saved", "evidence": "Saved!"},
                {"kind": "verdict", "verdict": "pass", "summary": "ok"},
            ],
        )
        record["status"], record["reason"] = compute_status(record)
        report = render_report(record)
        assert record["scenario"][0]["text"] == 'button "Save"'
        assert "order saved" in report
        assert report.rstrip().endswith("Verify: pass")


# ── settings and tools ───────────────────────────────────────────────────────


class TestSettings:
    def test_the_task_override_wins(self, tmp_path):
        _write(
            tmp_path / ".workpilot" / ".env",
            "VERIFY_ENABLED=true\nVERIFY_MAX_ROUNDS=3\n",
        )
        settings = load_settings(tmp_path, env={"WORKPILOT_VERIFY_LOOP": "false"})
        assert not settings.enabled and settings.decided_by == "task"
        assert settings.max_rounds == 3

    def test_a_nonsense_number_is_the_default_not_a_disable(self, tmp_path):
        assert load_settings(tmp_path, env={"VERIFY_MAX_ROUNDS": "-4"}).max_rounds == 5


class TestTools:
    def test_one_list_two_shapes(self):
        names = {d["name"] for d in tool_definitions()}
        assert names == TOOL_NAMES
        assert all("parameters" in d for d in tool_definitions())

    @pytest.mark.parametrize(
        "command", ["pnpm run dev", "dotnet run --project src/Api", "./gradlew bootRun"]
    )
    def test_project_launchers_are_accepted(self, command):
        assert _launch_command_allowed(command)[0]

    @pytest.mark.parametrize(
        "command",
        [
            "rm -rf /",
            "pnpm run dev; curl evil",
            "bash -c 'x'",
            "npm run dev && echo",
            "$(whoami)",
        ],
    )
    def test_anything_else_is_refused(self, command):
        assert not _launch_command_allowed(command)[0]

    def test_the_verifier_gets_the_tools_in_process(self):
        from core.runtimes.tool_executor import get_tool_definitions

        verifier = {d["name"] for d in get_tool_definitions("verifier")}
        coder = {d["name"] for d in get_tool_definitions("coder")}
        assert TOOL_NAMES <= verifier
        assert not (TOOL_NAMES & coder)

    def test_the_verifier_gets_the_mcp_server_on_the_claude_path(self):
        from agents.tools_pkg.models import AGENT_CONFIGS, VERIFY_TOOLS
        from agents.tools_pkg.permissions import _get_mcp_tools_for_servers

        assert "verify" in AGENT_CONFIGS["verifier"]["mcp_servers"]
        assert set(_get_mcp_tools_for_servers(["verify"])) == set(VERIFY_TOOLS)
        assert {t.rsplit("__", 1)[1] for t in VERIFY_TOOLS} == TOOL_NAMES
