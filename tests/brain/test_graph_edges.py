"""The vault's graph from notes a person wrote in Obsidian and from a
``graph.json`` another tool left, and the path queries at their limits."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from brain import graph
from brain.graph import BrainGraph, build_graph, load_graph, rebuild, write_graph
from brain.home import graph_path


def note(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def node(data: dict, node_id: str) -> dict:
    return next(n for n in data["nodes"] if n["id"] == node_id)


class TestBuild:
    def test_frontmatter_values_of_every_yaml_type_are_plain(self, tmp_path):
        note(
            tmp_path,
            "daily.md",
            "---\n"
            "description:\n  due: 2026-11-20\n  owners: [a, b]\n"
            "status: !!set {draft: null}\n"
            "scope: !!binary aGk=\n"
            'tasks: ""\n'
            "---\nToday.\n",
        )

        meta = node(build_graph(tmp_path), "daily")["metadata"]

        assert meta["description"] == {"due": "2026-11-20", "owners": ["a", "b"]}
        assert meta["status"] == ["draft"]
        assert meta["scope"] == "b'hi'"
        assert meta["tasks"] == []
        json.dumps(meta)  # the reason for it all: the graph can be written

    def test_a_note_that_cannot_be_read_is_left_out(self, tmp_path, monkeypatch):
        note(tmp_path, "a.md", "A")
        note(tmp_path, "busy.md", "B")
        real = graph.read_note

        def busy(root, rel):
            if str(rel) == "busy.md":
                raise PermissionError("locked by another program")
            return real(root, rel)

        monkeypatch.setattr(graph, "read_note", busy)

        assert [n["id"] for n in build_graph(tmp_path)["nodes"]] == ["a"]

    def test_a_note_linking_to_itself_has_no_loop(self, tmp_path):
        note(tmp_path, "self.md", "See [[self]] and [[other]].")
        note(tmp_path, "other.md", "Other.")

        links = build_graph(tmp_path)["links"]

        assert links == [{"source": "self", "target": "other", "relation": "links_to"}]


class TestLoad:
    @pytest.mark.parametrize(
        "text", ["{not json", "[1, 2]", '"text"'], ids=["broken", "list", "string"]
    )
    def test_a_file_that_is_not_a_graph_is_an_empty_one(self, tmp_path, text):
        path = tmp_path / "graph.json"
        path.write_text(text, encoding="utf-8")
        assert load_graph(path) == {"nodes": [], "links": []}

    def test_no_file_is_an_empty_graph(self, tmp_path):
        assert load_graph(tmp_path / "none.json") == {"nodes": [], "links": []}

    def test_lists_of_another_shape_are_empty_and_edges_are_links(self, tmp_path):
        path = tmp_path / "graph.json"
        path.write_text(
            json.dumps({"nodes": None, "links": {"a": "b"}, "directed": True}),
            encoding="utf-8",
        )
        assert load_graph(path) == {"directed": True, "nodes": [], "links": []}

        path.write_text(
            json.dumps({"nodes": [{"id": "a"}], "edges": [{"source": "a"}]}),
            encoding="utf-8",
        )
        assert load_graph(path) == {
            "nodes": [{"id": "a"}],
            "links": [{"source": "a"}],
        }

    def test_a_graph_another_tool_broke_still_answers_and_is_rebuilt(self, tmp_path):
        note(tmp_path, "a.md", "A, see [[b]].")
        note(tmp_path, "b.md", "B.")
        graph_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
        graph_path(tmp_path).write_text(
            json.dumps({"nodes": None, "links": None}), encoding="utf-8"
        )

        assert BrainGraph.load(tmp_path).nodes == {}
        rebuild(tmp_path)

        assert BrainGraph.load(tmp_path).shortest_path("a", "b") == ["a", "b"]


class TestWrite:
    def test_a_write_that_fails_leaves_no_temporary_file(self, tmp_path, monkeypatch):
        def full(*_a, **_k):
            raise OSError("disk full")

        monkeypatch.setattr(graph.json, "dump", full)

        with pytest.raises(OSError, match="disk full"):
            write_graph(tmp_path, {"nodes": [], "links": []})

        assert list(graph_path(tmp_path).parent.iterdir()) == []


class TestQueries:
    @pytest.fixture
    def chain(self):
        ids = ["a", "b", "c", "d"]
        return BrainGraph(
            {
                "nodes": [{"id": i, "label": i.upper()} for i in [*ids, "alone"]],
                "links": [
                    "not a link",
                    *(
                        {"source": x, "target": y}
                        for x, y in zip(ids, ids[1:], strict=False)
                    ),
                ],
            }
        )

    def test_a_query_without_words_finds_nothing(self, chain):
        assert chain.query("   ") == []

    def test_a_path_to_or_from_an_unknown_node(self, chain):
        assert chain.shortest_path("a", "z") is None
        assert chain.shortest_path("z", "a") is None

    def test_a_path_longer_than_allowed_or_none_at_all(self, chain):
        assert chain.shortest_path("a", "d") == ["a", "b", "c", "d"]
        assert chain.shortest_path("a", "d", max_depth=2) is None
        assert chain.shortest_path("a", "alone") is None

    def test_an_unknown_node_is_none(self, chain):
        assert chain.get_node("z") is None
        assert [n["id"] for n in chain.get_node("b")["neighbors"]] == ["a", "c"]
