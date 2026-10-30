"""``workpilot-board``: the Kanban of one project as an MCP server (IA5).

What the server must hold: no tool takes a path, a card id resolves inside
the board or nowhere, a new card lands in the backlog numbered under the
lock the app takes, ``wait_for_card`` is a task only for a client that reads
tasks, and no tool starts, approves or merges anything.
"""

from __future__ import annotations

import asyncio
import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "backend"))

from board_mcp import server  # noqa: E402
from board_mcp.server import (  # noqa: E402
    TOOLS,
    call_tool,
    card_dir,
    create_card,
    handle,
    list_cards,
    serve,
    slugify,
)
from mcp_tasks import MODERN_VERSION, TASKS_EXTENSION  # noqa: E402


def _card(root: Path, card_id: str, status: str = "pending", **plan) -> Path:
    directory = root / ".workpilot" / "specs" / card_id
    directory.mkdir(parents=True)
    plan = {"feature": card_id, "status": status, "phases": [], **plan}
    (directory / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )
    return directory


def _call(root: Path, name: str, **arguments) -> tuple[object, bool]:
    result = asyncio.run(call_tool(root, name, arguments))
    text = result["content"][0]["text"]
    try:
        value = json.loads(text)
    except ValueError:
        value = text
    return value, result["isError"]


def _meta(*, tasks: bool) -> dict:
    capabilities = {"extensions": {TASKS_EXTENSION: {}}} if tasks else {}
    return {
        "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
        "io.modelcontextprotocol/clientInfo": {"name": "test", "version": "1"},
        "io.modelcontextprotocol/clientCapabilities": capabilities,
    }


class TestReading:
    def test_list_maps_the_plan_status_to_the_board_columns(self, tmp_path):
        _card(tmp_path, "001-first", "pending")
        _card(tmp_path, "002-second", "coding")
        _card(tmp_path, "003-third", "human_review")
        _card(tmp_path, "004-fourth", "something-new")

        cards = list_cards(tmp_path)

        assert [c["id"] for c in cards] == [
            "004-fourth",
            "003-third",
            "002-second",
            "001-first",
        ]
        columns = {c["id"]: c["column"] for c in cards}
        assert columns == {
            "001-first": "backlog",
            "002-second": "in_progress",
            "003-third": "human_review",
            # An unknown status is shown where the board shows it.
            "004-fourth": "backlog",
        }
        assert [c["id"] for c in list_cards(tmp_path, "in_progress")] == ["002-second"]

    def test_an_empty_project_has_no_cards(self, tmp_path):
        assert _call(tmp_path, "list_cards") == ([], False)

    def test_an_unknown_column_is_refused(self, tmp_path):
        value, error = _call(tmp_path, "list_cards", column="anywhere")
        assert error and "unknown column" in value

    def test_get_card_reads_subtasks_qa_and_goal(self, tmp_path):
        _card(
            tmp_path,
            "007-login",
            "human_review",
            reviewReason="completed",
            phases=[
                {
                    "subtasks": [
                        {"status": "completed"},
                        {"status": "completed"},
                        {"status": "pending"},
                    ]
                }
            ],
            qa_signoff={"status": "approved", "issues": ["ignored list"]},
            goal={"status": "met", "command": "dotnet test", "nested": {"x": 1}},
        )

        card, error = _call(tmp_path, "get_card", card_id="007-login")

        assert not error
        assert card["column"] == "human_review"
        assert card["reviewReason"] == "completed"
        assert card["subtasks"] == {"completed": 2, "total": 3}
        assert card["qa"] == "approved"
        # Scalars only: nothing nested comes back.
        assert card["goal"] == {"status": "met", "command": "dotnet test"}

    @pytest.mark.parametrize(
        "card_id",
        [
            "../../etc",
            "001-a/../../x",
            "/etc/passwd",
            "001-A",
            "1-short",
            "",
            None,
            42,
            "001-missing",
        ],
    )
    def test_an_id_that_is_not_one_of_the_board_is_refused(self, tmp_path, card_id):
        _card(tmp_path, "001-a")
        assert card_dir(tmp_path, card_id) is None
        value, error = _call(tmp_path, "get_card", card_id=card_id)
        assert error and value == "Error: no such card on this board"

    def test_a_link_out_of_the_board_is_refused(self, tmp_path):
        outside = tmp_path / "outside"
        outside.mkdir()
        specs = tmp_path / "project" / ".workpilot" / "specs"
        specs.mkdir(parents=True)
        try:
            (specs / "001-link").symlink_to(outside, target_is_directory=True)
        except OSError:
            pytest.skip("symbolic links are not available here")
        assert card_dir(tmp_path / "project", "001-link") is None

    def test_a_corrupt_plan_reads_as_an_empty_backlog_card(self, tmp_path):
        directory = _card(tmp_path, "001-broken")
        (directory / "implementation_plan.json").write_text(
            "{not json", encoding="utf-8"
        )
        card, error = _call(tmp_path, "get_card", card_id="001-broken")
        assert not error
        assert card["column"] == "backlog" and card["title"] == "001-broken"


class TestCreating:
    def test_a_new_card_is_in_the_backlog_numbered_after_the_others(self, tmp_path):
        _card(tmp_path, "004-older")
        worktree_specs = (
            tmp_path / ".workpilot" / "worktrees" / "tasks" / "009-x" / ".workpilot"
        )
        _card(worktree_specs.parent, "009-in-a-worktree")

        card, error = _call(
            tmp_path,
            "create_card",
            title="Ajouter l'export CSV",
            description="Exporter les factures.\nEn UTF-8.",
            kind="feature",
        )

        assert not error
        assert card["id"] == "010-ajouter-l-export-csv"
        assert card["column"] == "backlog" and card["kind"] == "feature"
        directory = tmp_path / ".workpilot" / "specs" / card["id"]
        plan = json.loads((directory / "implementation_plan.json").read_text("utf-8"))
        meta = json.loads((directory / "task_metadata.json").read_text("utf-8"))
        requirements = json.loads((directory / "requirements.json").read_text("utf-8"))
        assert plan["status"] == "pending" and plan["phases"] == []
        assert plan["feature"] == "Ajouter l'export CSV"
        assert requirements["task_description"] == "Exporter les factures.\nEn UTF-8."
        assert meta == {
            "sourceType": "mcp",
            "kind": "feature",
            "kindSource": "user",
            "kindConfidence": 1,
        }
        # The lock is released for the app's next card.
        assert not (tmp_path / ".workpilot" / ".locks" / "spec-numbering.lock").exists()

    def test_without_a_kind_the_classifier_decides(self, tmp_path):
        card = create_card(tmp_path, "Fix", None)
        directory = tmp_path / ".workpilot" / "specs" / card["id"]
        meta = json.loads((directory / "task_metadata.json").read_text("utf-8"))
        assert meta == {"sourceType": "mcp"} and card["kind"] is None
        requirements = json.loads((directory / "requirements.json").read_text("utf-8"))
        assert requirements["task_description"] == "Fix"

    def test_text_is_bounded_and_control_characters_dropped(self, tmp_path):
        card = create_card(
            tmp_path, "Ti\x00tle\x1b[31m\nsecond line" + "x" * 500, "body\x07"
        )
        directory = tmp_path / ".workpilot" / "specs" / card["id"]
        plan = json.loads((directory / "implementation_plan.json").read_text("utf-8"))
        assert "\x00" not in plan["feature"] and "\x1b" not in plan["feature"]
        assert "\n" not in plan["feature"]
        assert len(plan["feature"]) <= server.MAX_TITLE
        assert plan["description"] == "body"

    @pytest.mark.parametrize(
        "arguments",
        [{"title": ""}, {"title": "\x00\x01"}, {"title": "ok", "kind": "deploy"}],
    )
    def test_a_card_without_a_title_or_with_an_unknown_kind_is_refused(
        self, tmp_path, arguments
    ):
        value, error = _call(tmp_path, "create_card", **arguments)
        assert error and value.startswith("Error: ")
        assert not (tmp_path / ".workpilot" / "specs").exists() or not any(
            (tmp_path / ".workpilot" / "specs").iterdir()
        )

    def test_a_held_lock_is_an_error_not_a_hang(self, tmp_path, monkeypatch):
        from core.workspace import models

        class Busy:
            def __init__(self, _root):
                pass

            def __enter__(self):
                raise models.SpecNumberLockError("busy")

            def __exit__(self, *exc):
                return False

        monkeypatch.setattr(models, "SpecNumberLock", Busy)
        value, error = _call(tmp_path, "create_card", title="Later")
        assert error and "try again" in value

    def test_the_slug_matches_the_app(self):
        assert slugify("Évaluer   l'API — v2!") == "evaluer-l-api-v2"
        assert slugify("!!!") == "card"
        assert len(slugify("a" * 80)) == 50


class TestWaiting:
    def test_returns_once_the_card_reaches_the_column(self, tmp_path, monkeypatch):
        monkeypatch.setattr(server, "POLL_SECONDS", 0.01)
        directory = _card(tmp_path, "001-a", "coding")

        async def run():
            waiting = asyncio.create_task(
                call_tool(tmp_path, "wait_for_card", {"card_id": "001-a"})
            )
            await asyncio.sleep(0.05)
            assert not waiting.done()
            plan = json.loads(
                (directory / "implementation_plan.json").read_text("utf-8")
            )
            plan["status"] = "human_review"
            (directory / "implementation_plan.json").write_text(
                json.dumps(plan), encoding="utf-8"
            )
            return await asyncio.wait_for(waiting, 5)

        result = asyncio.run(run())
        value = json.loads(result["content"][0]["text"])
        assert value["reached"] is True
        assert value["card"]["column"] == "human_review"

    def test_time_running_out_returns_the_card_as_it_is(self, tmp_path, monkeypatch):
        monkeypatch.setattr(server, "POLL_SECONDS", 0.01)
        _card(tmp_path, "001-a", "coding")
        value, error = _call(
            tmp_path,
            "wait_for_card",
            card_id="001-a",
            columns=["done"],
            timeout_seconds=1,
        )
        assert not error
        assert value["reached"] is False and value["card"]["column"] == "in_progress"

    @pytest.mark.parametrize(
        "arguments",
        [
            {"card_id": "001-missing"},
            {"card_id": "001-a", "columns": ["merged"]},
            {"card_id": "001-a", "timeout_seconds": "60"},
            {"card_id": "001-a", "timeout_seconds": True},
        ],
    )
    def test_bad_arguments_are_refused_at_once(self, tmp_path, arguments):
        _card(tmp_path, "001-a")
        value, error = _call(tmp_path, "wait_for_card", **arguments)
        assert error and value.startswith("Error: ")


class TestProtocol:
    def test_no_tool_starts_approves_or_merges(self):
        names = {t["name"] for t in TOOLS}
        assert names == {"list_cards", "get_card", "create_card", "wait_for_card"}
        for tool in TOOLS:
            properties = tool["inputSchema"].get("properties", {})
            # The project is fixed at start: no tool takes a path.
            assert not any("path" in p or "dir" in p for p in properties)
            assert tool["inputSchema"]["additionalProperties"] is False

    def test_handshake_era_initialize_and_list(self, tmp_path):
        async def run():
            init = await handle(
                tmp_path,
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {"protocolVersion": "2025-06-18"},
                },
            )
            listed = await handle(
                tmp_path, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
            )
            return init, listed

        init, listed = asyncio.run(run())
        assert init["result"]["serverInfo"]["name"] == "workpilot-board"
        assert {t["name"] for t in listed["result"]["tools"]} == {
            t["name"] for t in TOOLS
        }

    def test_wait_is_a_task_only_for_a_client_that_reads_tasks(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(server, "POLL_SECONDS", 0.01)
        _card(tmp_path, "001-a", "human_review")

        def ask(name, *, tasks, msg_id):
            return handle(
                tmp_path,
                {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "method": "tools/call",
                    "params": {
                        "name": name,
                        "arguments": {"card_id": "001-a"},
                        "_meta": _meta(tasks=tasks),
                    },
                },
            )

        async def run():
            as_task = (await ask("wait_for_card", tasks=True, msg_id=1))["result"]
            plain = (await ask("wait_for_card", tasks=False, msg_id=2))["result"]
            short = (await ask("get_card", tasks=True, msg_id=3))["result"]
            return as_task, plain, short

        as_task, plain, short = asyncio.run(run())
        assert as_task["resultType"] == "task"
        assert plain["resultType"] == "complete"
        assert json.loads(plain["content"][0]["text"])["reached"] is True
        assert short["resultType"] == "complete"

    def test_serve_answers_line_by_line_and_survives_garbage(self, tmp_path):
        _card(tmp_path, "001-a")
        stdin = io.StringIO(
            "not json\n"
            + json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": "list_cards", "arguments": {}},
                }
            )
            + "\n"
            + json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"})
            + "\n"
        )
        stdout = io.StringIO()

        serve(tmp_path, stdin, stdout)

        replies = [json.loads(line) for line in stdout.getvalue().splitlines()]
        assert replies[0]["error"]["code"] == -32700
        listed = json.loads(replies[1]["result"]["content"][0]["text"])
        assert [c["id"] for c in listed] == ["001-a"]
        assert len(replies) == 2
