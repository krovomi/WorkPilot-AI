"""``workpilot-board``'s second set of tools and its resources (lot 2).

What they must hold: a spec is read only from the card's own plain file (a
link is not followed), a card is edited only while no work started on it,
the roadmap and the ideas are bounded summaries of their files, and a
resource URI resolves inside the board or nowhere.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "backend"))

from board_mcp import server  # noqa: E402
from board_mcp.server import call_tool, handle  # noqa: E402
from mcp_tasks import MODERN_VERSION, RESOURCE_NOT_FOUND  # noqa: E402


def _card(root: Path, card_id: str, status: str = "pending", **plan) -> Path:
    directory = root / ".workpilot" / "specs" / card_id
    directory.mkdir(parents=True)
    plan = {"feature": card_id, "status": status, "phases": [], **plan}
    (directory / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )
    (directory / "requirements.json").write_text(
        json.dumps({"task_description": "old text", "workflow_type": "feature"}),
        encoding="utf-8",
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


def _write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


class TestSpec:
    def test_reads_the_spec_and_the_plan(self, tmp_path):
        directory = _card(
            tmp_path,
            "001-login",
            "coding",
            phases=[
                {
                    "name": "Backend",
                    "subtasks": [
                        {
                            "id": "1.1",
                            "description": "Add the route",
                            "status": "completed",
                        },
                        {"id": "1.2", "description": "x" * 2000},
                    ],
                },
                "garbage",
            ],
        )
        (directory / "spec.md").write_text("# Login\n\nDo it.", encoding="utf-8")

        value, error = _call(tmp_path, "get_spec", card_id="001-login")

        assert not error
        assert value["spec"] == "# Login\n\nDo it."
        assert value["specTruncated"] is False
        assert value["column"] == "in_progress"
        assert value["phases"][0]["name"] == "Backend"
        subtasks = value["phases"][0]["subtasks"]
        assert subtasks[0] == {
            "id": "1.1",
            "description": "Add the route",
            "status": "completed",
        }
        assert subtasks[1]["status"] == "pending"
        assert len(subtasks[1]["description"]) == server.SUMMARY_CHARS

    def test_before_planning_the_spec_is_null(self, tmp_path):
        _card(tmp_path, "001-a")
        value, _ = _call(tmp_path, "get_spec", card_id="001-a")
        assert value["spec"] is None
        assert value["phases"] == []

    def test_a_long_spec_is_cut(self, tmp_path, monkeypatch):
        monkeypatch.setattr(server, "MAX_SPEC_CHARS", 10)
        directory = _card(tmp_path, "001-a")
        (directory / "spec.md").write_text("y" * 50, encoding="utf-8")
        value, _ = _call(tmp_path, "get_spec", card_id="001-a")
        assert value["spec"] == "y" * 10
        assert value["specTruncated"] is True

    def test_a_spec_that_links_out_is_not_read(self, tmp_path):
        secret = tmp_path / "secret.txt"
        secret.write_text("TOP SECRET", encoding="utf-8")
        directory = _card(tmp_path, "001-a")
        try:
            (directory / "spec.md").symlink_to(secret)
        except OSError:
            pytest.skip("symlinks unavailable")
        value, _ = _call(tmp_path, "get_spec", card_id="001-a")
        assert value["spec"] is None

    def test_an_unknown_card_is_refused(self, tmp_path):
        value, error = _call(tmp_path, "get_spec", card_id="../../etc")
        assert error and "no such card" in value


class TestUpdate:
    def test_edits_title_and_description_of_a_card_not_started(self, tmp_path):
        directory = _card(tmp_path, "001-a")

        value, error = _call(
            tmp_path,
            "update_card",
            card_id="001-a",
            title="  New\ttitle ",
            description="New\x07 text",
        )

        assert not error
        assert value["title"] == "New title"
        plan = json.loads(
            (directory / "implementation_plan.json").read_text(encoding="utf-8")
        )
        requirements = json.loads(
            (directory / "requirements.json").read_text(encoding="utf-8")
        )
        assert plan["description"] == requirements["task_description"] == "New text"
        assert requirements["workflow_type"] == "feature"

    def test_a_card_with_a_spec_or_a_workspace_is_not_edited(self, tmp_path):
        first = _card(tmp_path, "001-a")
        (first / "spec.md").write_text("spec", encoding="utf-8")
        _card(tmp_path, "002-b")
        (tmp_path / ".workpilot" / "worktrees" / "tasks" / "002-b").mkdir(parents=True)

        for card_id in ("001-a", "002-b"):
            value, error = _call(tmp_path, "update_card", card_id=card_id, title="x")
            assert error and "work has started" in value
        requirements = json.loads(
            (first / "requirements.json").read_text(encoding="utf-8")
        )
        assert requirements["task_description"] == "old text"

    @pytest.mark.parametrize("arguments", [{}, {"title": "   "}])
    def test_nothing_to_change_or_an_empty_title_is_refused(self, tmp_path, arguments):
        _card(tmp_path, "001-a")
        _, error = _call(tmp_path, "update_card", card_id="001-a", **arguments)
        assert error

    def test_an_empty_description_falls_back_to_the_title(self, tmp_path):
        directory = _card(tmp_path, "001-a", feature="Title")
        _call(tmp_path, "update_card", card_id="001-a", description="  ")
        plan = json.loads(
            (directory / "implementation_plan.json").read_text(encoding="utf-8")
        )
        assert plan["description"] == "Title"


class TestRoadmapAndIdeas:
    def test_roadmap_is_a_bounded_summary(self, tmp_path, monkeypatch):
        monkeypatch.setattr(server, "MAX_FEATURES", 2)
        _write(
            tmp_path / ".workpilot" / "roadmap" / "roadmap.json",
            {
                "vision": "Ship it",
                "phases": [
                    {"id": "p1", "name": "MVP", "status": "in_progress", "order": 1}
                ],
                "features": [
                    {
                        "id": "f1",
                        "title": "Login",
                        "description": "d" * 1000,
                        "status": "planned",
                        "priority": "must",
                        "phase_id": "p1",
                        "linked_spec_id": "001-login",
                        "acceptance_criteria": ["works", {"no": "dict"}],
                    },
                    {"id": "f2", "title": "Two"},
                    {"id": "f3", "title": "Three"},
                    "garbage",
                ],
            },
        )

        value, error = _call(tmp_path, "get_roadmap")

        assert not error
        assert value["exists"] and value["vision"] == "Ship it"
        assert value["phases"] == [
            {"id": "p1", "name": "MVP", "status": "in_progress", "order": 1}
        ]
        first = value["features"][0]
        assert first["linkedCardId"] == "001-login" and first["phaseId"] == "p1"
        assert first["acceptanceCriteria"] == ["works"]
        assert len(first["description"]) == server.SUMMARY_CHARS
        assert value["features"][1]["status"] == "under_review"
        assert len(value["features"]) == 2 and value["truncated"] is True

    def test_no_roadmap_or_a_corrupt_one_reads_as_empty(self, tmp_path):
        value, _ = _call(tmp_path, "get_roadmap")
        assert value == {"exists": False, "phases": [], "features": []}
        path = tmp_path / ".workpilot" / "roadmap" / "roadmap.json"
        path.parent.mkdir(parents=True)
        path.write_text("{not json", encoding="utf-8")
        value, _ = _call(tmp_path, "get_roadmap")
        assert value["exists"] is False

    def test_a_roadmap_folder_that_links_out_is_not_read(self, tmp_path):
        outside = tmp_path / "elsewhere"
        _write(outside / "roadmap.json", {"vision": "leak", "features": []})
        (tmp_path / ".workpilot").mkdir()
        try:
            (tmp_path / ".workpilot" / "roadmap").symlink_to(
                outside, target_is_directory=True
            )
        except OSError:
            pytest.skip("symlinks unavailable")
        value, _ = _call(tmp_path, "get_roadmap")
        assert value["exists"] is False

    def test_ideas_with_their_status(self, tmp_path):
        _write(
            tmp_path / ".workpilot" / "ideation" / "ideation.json",
            {
                "ideas": [
                    {
                        "id": "i1",
                        "type": "code_quality",
                        "title": "Split it",
                        "status": "draft",
                    },
                    {
                        "id": "i2",
                        "type": "security_hardening",
                        "title": "Rotate keys",
                        "status": "archived",
                        "linked_task_id": "004-rotate",
                    },
                ]
            },
        )
        value, _ = _call(tmp_path, "list_ideas")
        assert [i["id"] for i in value["ideas"]] == ["i1", "i2"]
        assert value["ideas"][1]["linkedCardId"] == "004-rotate"
        value, _ = _call(tmp_path, "list_ideas", status="draft")
        assert [i["id"] for i in value["ideas"]] == ["i1"]
        _, error = _call(tmp_path, "list_ideas", status=3)
        assert error


class TestResources:
    def _rpc(self, root: Path, method: str, params: dict | None = None, modern=False):
        params = dict(params or {})
        if modern:
            params["_meta"] = {
                "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
                "io.modelcontextprotocol/clientInfo": {"name": "t", "version": "1"},
                "io.modelcontextprotocol/clientCapabilities": {},
            }
        return asyncio.run(
            handle(
                root, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
            )
        )

    def test_initialize_declares_resources(self, tmp_path):
        init = self._rpc(tmp_path, "initialize", {"protocolVersion": "2025-06-18"})
        assert init["result"]["capabilities"]["resources"] == {"listChanged": False}
        discover = self._rpc(tmp_path, "server/discover", modern=True)
        assert "resources" in discover["result"]["capabilities"]

    @pytest.mark.parametrize("modern", [False, True])
    def test_lists_and_reads_cards_and_the_roadmap(self, tmp_path, modern):
        directory = _card(tmp_path, "001-a")
        (directory / "spec.md").write_text("the spec", encoding="utf-8")
        _write(tmp_path / ".workpilot" / "roadmap" / "roadmap.json", {"vision": "v"})

        listed = self._rpc(tmp_path, "resources/list", modern=modern)["result"][
            "resources"
        ]
        assert [r["uri"] for r in listed] == [
            "workpilot://roadmap",
            "workpilot://cards/001-a",
        ]
        templates = self._rpc(tmp_path, "resources/templates/list", modern=modern)
        assert templates["result"]["resourceTemplates"][0]["uriTemplate"] == (
            "workpilot://cards/{card_id}"
        )

        card = self._rpc(
            tmp_path, "resources/read", {"uri": "workpilot://cards/001-a"}, modern
        )
        content = card["result"]["contents"][0]
        assert content["mimeType"] == "application/json"
        assert json.loads(content["text"])["spec"] == "the spec"
        road = self._rpc(
            tmp_path, "resources/read", {"uri": "workpilot://roadmap"}, modern
        )
        assert json.loads(road["result"]["contents"][0]["text"])["vision"] == "v"

    @pytest.mark.parametrize(
        "uri",
        [
            "workpilot://cards/../../x",
            "workpilot://cards/999-none",
            "file:///etc/passwd",
            "x",
        ],
    )
    def test_a_uri_that_is_not_the_boards_is_not_found(self, tmp_path, uri):
        reply = self._rpc(tmp_path, "resources/read", {"uri": uri})
        assert reply["error"]["code"] == RESOURCE_NOT_FOUND

    def test_a_uri_must_be_text(self, tmp_path):
        reply = self._rpc(tmp_path, "resources/read", {"uri": 3})
        assert reply["error"]["code"] == -32602
