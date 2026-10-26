"""WorkPilot's tool servers in both eras of MCP, and the tasks they return.

Every 2026-07-28 answer is checked against the published schemas: the core's
through the Python SDK's own validator, the Tasks extension's against its JSON
Schema (``tests/fixtures/mcp_2026/tasks-schema-2026-07-28.json``).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import jsonschema
import pytest
from mcp_tasks import MODERN_VERSION, TASKS_EXTENSION, TaskStore, ToolServer
from mcp_types import methods

SCHEMA = json.loads(
    (
        Path(__file__).parents[1]
        / "fixtures"
        / "mcp_2026"
        / "tasks-schema-2026-07-28.json"
    ).read_text(encoding="utf-8")
)


def _valid(definition: str, value: dict) -> None:
    jsonschema.Draft202012Validator(
        {"$ref": f"#/$defs/{definition}", "$defs": SCHEMA["$defs"]}
    ).validate(value)


TOOLS = [
    {"name": n, "description": n, "inputSchema": {"type": "object", "properties": {}}}
    for n in ("slow", "quick", "boom", "oops")
]


def _server(release: asyncio.Event | None = None, **kwargs) -> ToolServer:
    async def call(name, arguments):
        if name == "slow" and release is not None:
            await release.wait()
        if name == "boom":
            raise RuntimeError("the app did not start")
        if name == "oops":
            return {
                "content": [{"type": "text", "text": "Error: nope"}],
                "isError": True,
            }
        return {"content": [{"type": "text", "text": f"{name} ok"}], "isError": False}

    return ToolServer(
        name="fixture",
        version="1.0.0",
        instructions="fixture",
        tools=TOOLS,
        call=call,
        legacy_versions=("2025-06-18", "2025-03-26"),
        task_tools=frozenset({"slow", "boom", "oops"}),
        **kwargs,
    )


def _meta(*, tasks: bool) -> dict:
    capabilities = {"extensions": {TASKS_EXTENSION: {}}} if tasks else {}
    return {
        "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
        "io.modelcontextprotocol/clientInfo": {"name": "test", "version": "1"},
        "io.modelcontextprotocol/clientCapabilities": capabilities,
    }


def _ask(server, method, params=None, *, tasks=True, modern=True, msg_id=1):
    params = dict(params or {})
    if modern:
        params["_meta"] = _meta(tasks=tasks)
    return server.handle(
        {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}
    )


class TestHandshakeEra:
    def test_answers_as_before(self):
        async def run():
            server = _server()
            init = await _ask(
                server, "initialize", {"protocolVersion": "2025-03-26"}, modern=False
            )
            listed = await _ask(server, "tools/list", modern=False)
            called = await _ask(server, "tools/call", {"name": "slow"}, modern=False)
            return init, listed, called

        init, listed, called = asyncio.run(run())
        assert init["result"]["protocolVersion"] == "2025-03-26"
        assert "resultType" not in listed["result"]
        # A long tool answers with its result: a handshake-era client reads no task.
        assert called["result"] == {
            "content": [{"type": "text", "text": "slow ok"}],
            "isError": False,
        }

    def test_task_methods_need_the_extension(self):
        reply = asyncio.run(_ask(_server(), "tasks/get", {"taskId": "x"}, modern=False))
        assert reply["error"]["code"] == -32021


class TestModern:
    def test_discover_advertises_tasks_and_validates(self):
        reply = asyncio.run(_ask(_server(), "server/discover", tasks=False))
        result = reply["result"]
        methods.validate_server_result("server/discover", MODERN_VERSION, result)
        assert result["supportedVersions"] == [MODERN_VERSION]
        assert TASKS_EXTENSION in result["capabilities"]["extensions"]

    def test_lists_and_calls_validate(self):
        async def run():
            server = _server()
            return (
                await _ask(server, "tools/list"),
                await _ask(server, "tools/call", {"name": "quick"}),
            )

        listed, called = asyncio.run(run())
        methods.validate_server_result("tools/list", MODERN_VERSION, listed["result"])
        methods.validate_server_result("tools/call", MODERN_VERSION, called["result"])
        assert called["result"]["resultType"] == "complete"

    def test_another_version_is_refused_with_the_supported_one(self):
        server = _server()
        message = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/list",
            "params": {
                "_meta": {"io.modelcontextprotocol/protocolVersion": "2027-01-01"}
            },
        }
        error = asyncio.run(server.handle(message))["error"]
        assert error["code"] == -32022
        assert error["data"] == {
            "supported": [MODERN_VERSION],
            "requested": "2027-01-01",
        }

    def test_a_client_without_the_extension_never_gets_a_task(self):
        called = asyncio.run(
            _ask(_server(), "tools/call", {"name": "slow"}, tasks=False)
        )
        assert called["result"]["resultType"] == "complete"
        assert called["result"]["content"][0]["text"] == "slow ok"

    def test_a_short_tool_is_never_a_task(self):
        called = asyncio.run(_ask(_server(), "tools/call", {"name": "quick"}))
        assert called["result"]["resultType"] == "complete"


class TestTasks:
    def test_a_long_tool_is_a_task_until_it_completes(self):
        async def run():
            release = asyncio.Event()
            server = _server(release)
            created = (await _ask(server, "tools/call", {"name": "slow"}))["result"]
            # Findable at once, and still working.
            working = (await _ask(server, "tasks/get", {"taskId": created["taskId"]}))[
                "result"
            ]
            release.set()
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            done = (await _ask(server, "tasks/get", {"taskId": created["taskId"]}))[
                "result"
            ]
            return created, working, done

        created, working, done = asyncio.run(run())
        _valid("CreateTaskResult", created)
        assert created["resultType"] == "task" and created["status"] == "working"
        assert len(created["taskId"]) >= 32  # 24 random bytes, url-safe
        _valid("GetTaskResult", working)
        assert working["status"] == "working" and "result" not in working
        _valid("GetTaskResult", done)
        assert done["status"] == "completed"
        assert done["result"]["content"][0]["text"] == "slow ok"
        assert done["ttlMs"] is not None

    def test_a_tool_error_completes_and_an_exception_fails(self):
        async def run():
            server = _server()
            oops = (await _ask(server, "tools/call", {"name": "oops"}))["result"]
            boom = (await _ask(server, "tools/call", {"name": "boom"}))["result"]
            await asyncio.sleep(0.01)
            return (
                (await _ask(server, "tasks/get", {"taskId": oops["taskId"]}))["result"],
                (await _ask(server, "tasks/get", {"taskId": boom["taskId"]}))["result"],
            )

        oops, boom = asyncio.run(run())
        assert oops["status"] == "completed" and oops["result"]["isError"] is True
        _valid("GetTaskResult", boom)
        assert boom["status"] == "failed"
        assert boom["error"] == {"code": -32603, "message": "the app did not start"}

    def test_cancel_stops_the_work_and_stays_cancelled(self):
        async def run():
            release = asyncio.Event()
            server = _server(release)
            created = (await _ask(server, "tools/call", {"name": "slow"}))["result"]
            cancelled = (
                await _ask(server, "tasks/cancel", {"taskId": created["taskId"]})
            )["result"]
            release.set()
            await asyncio.sleep(0.01)
            after = (await _ask(server, "tasks/get", {"taskId": created["taskId"]}))[
                "result"
            ]
            return cancelled, after

        cancelled, after = asyncio.run(run())
        _valid("CancelTaskResult", cancelled)
        assert after["status"] == "cancelled" and "result" not in after

    @pytest.mark.parametrize("method", ["tasks/get", "tasks/update", "tasks/cancel"])
    def test_an_unknown_task_is_invalid_params(self, method):
        params = {"taskId": "guess", "inputResponses": {}}
        assert asyncio.run(_ask(_server(), method, params))["error"]["code"] == -32602

    def test_task_methods_without_the_extension_are_refused(self):
        reply = asyncio.run(_ask(_server(), "tasks/get", {"taskId": "x"}, tasks=False))
        assert reply["error"]["code"] == -32021

    def test_update_without_an_outstanding_request_is_acknowledged(self):
        async def run():
            release = asyncio.Event()
            server = _server(release)
            created = (await _ask(server, "tools/call", {"name": "slow"}))["result"]
            reply = await _ask(
                server,
                "tasks/update",
                {"taskId": created["taskId"], "inputResponses": {"k": {}}},
            )
            release.set()
            return reply["result"]

        result = asyncio.run(run())
        _valid("UpdateTaskResult", result)


class TestStore:
    def test_a_finished_task_expires_after_its_retention(self):
        now = [1000.0]
        store = TaskStore(retention_ms=60_000, clock=lambda: now[0])

        async def run():
            async def work():
                return {"content": []}

            created = store.start(work)
            await asyncio.sleep(0)
            assert store.get(created["taskId"])["status"] == "completed"
            now[0] += 61
            with pytest.raises(Exception, match="unknown or expired"):
                store.get(created["taskId"])

        asyncio.run(run())

    def test_a_flood_of_tasks_is_refused(self):
        store = TaskStore(max_tasks=2)

        async def run():
            never = asyncio.Event()

            async def work():
                await never.wait()
                return {}

            store.start(work)
            store.start(work)
            with pytest.raises(Exception, match="too many tasks"):
                store.start(work)
            await store.aclose()

        asyncio.run(run())
