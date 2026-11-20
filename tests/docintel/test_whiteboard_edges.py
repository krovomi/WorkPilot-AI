"""A whiteboard photo turned into a diagram, at every place it can stop.

`test_docintel_specs.py` converts a real photo, keeps a saved file and refuses
an injected label. This file walks the other exits of `convert`: a file that
is no image, local OCR switched off, a photo too large or gone, an answer that
is no JSON or draws nothing, a secret scan that cannot run, a target that was
generated before or cannot be written, and a conformance check that fails.
Each one is a status, never an exception.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from docintel import redact, whiteboard

BOARD = {
    "containers": [{"id": "w", "label": "Web"}, {"id": "e", "label": ""}],
    "nodes": [
        {"id": "a", "label": "Api", "container": "w"},
        {"id": "d", "label": "Db"},
        {"label": "Cache"},
        {"id": "x", "label": "   "},
    ],
    "edges": [{"from": "a", "to": "d", "label": "reads"}],
}


@pytest.fixture
def spec_dir(tmp_path: Path) -> Path:
    spec = tmp_path / "project" / ".workpilot" / "specs" / "001-board"
    (spec / "attachments").mkdir(parents=True)
    return spec


@pytest.fixture
def photo(spec_dir: Path) -> Path:
    image_mod = pytest.importorskip("PIL.Image")
    path = spec_dir / "attachments" / "board.png"
    image_mod.new("RGB", (8, 8), "white").save(path)
    return path


@pytest.fixture
def vision(monkeypatch):
    import docintel.engines.ollama_vision as ollama_vision

    def install(answer: str, reason: str = ""):
        monkeypatch.setattr(
            ollama_vision, "ask", lambda image, prompt, env: (answer, reason)
        )

    return install


class TestReadingTheAnswer:
    def test_lists_of_another_shape_are_skipped(self):
        assert (
            whiteboard.model_from_answer({"containers": 3, "nodes": "Api", "edges": 1})
            is None
        )

    def test_unnamed_and_empty_entries_are_left_out(self):
        diagram = whiteboard.model_from_answer(BOARD)

        assert [n.label for n in diagram.nodes] == ["Web", "Api", "Db", "Cache"]
        assert len({n.id for n in diagram.nodes}) == 4
        assert [e.label for e in diagram.edges] == ["reads"]

    def test_an_id_declared_twice_is_one_box(self):
        diagram = whiteboard.model_from_answer(
            {
                "containers": [{"id": "a", "label": "Web"}],
                "nodes": [
                    {"id": "a", "label": "Api"},
                    {"id": "b", "label": "Db"},
                    {"id": "b", "label": "Db again"},
                ],
            }
        )

        assert [n.label for n in diagram.nodes] == ["Web", "Db"]
        assert len({n.id for n in diagram.nodes}) == 2

    def test_an_answer_that_is_no_object_is_no_diagram(self):
        assert whiteboard.model_from_answer(["Api", "Db"]) is None

    def test_json_nested_beyond_reading_is_no_json(self):
        assert whiteboard._extract_json("[" * 100_000 + "]" * 100_000) is None

    def test_a_path_outside_the_spec_is_named_by_its_file(self, tmp_path):
        outside = tmp_path / "elsewhere" / "board.whiteboard.drawio"

        assert whiteboard._relative(outside, tmp_path / "spec") == outside.name


class TestWhatIsConverted:
    def test_an_attachment_that_is_no_image_is_refused(self, spec_dir, vision):
        note = spec_dir / "attachments" / "notes.txt"
        note.write_text("Api calls Db", encoding="utf-8")
        vision(json.dumps(BOARD))

        assert whiteboard.convert(spec_dir, note, None, env={}).status == (
            "not-an-image"
        )

    def test_local_ocr_switched_off_reads_nothing(self, spec_dir, photo, vision):
        vision(json.dumps(BOARD))

        result = whiteboard.convert(
            spec_dir, photo, None, env={"DOCINTEL_LOCAL_OCR": "false"}
        )

        assert result.status == "disabled"

    def test_a_photo_over_the_size_limit_is_not_sent(self, spec_dir, photo, vision):
        vision(json.dumps(BOARD))

        result = whiteboard.convert(
            spec_dir, photo, None, env={"DOCINTEL_MAX_BYTES": "1"}
        )

        assert (result.status, result.reason) == ("unreadable", "too-large")

    def test_a_photo_removed_while_it_is_read_is_unreadable(
        self, spec_dir, photo, vision, monkeypatch
    ):
        vision(json.dumps(BOARD))
        listed = whiteboard.attachment_paths

        def list_then_remove(spec):
            paths = listed(spec)
            photo.unlink()
            return paths

        monkeypatch.setattr(whiteboard, "attachment_paths", list_then_remove)

        assert whiteboard.convert(spec_dir, photo, None, env={}).status == (
            "unreadable"
        )

    def test_a_model_that_failed_is_unreadable(self, spec_dir, photo, vision):
        vision("", "timeout")

        result = whiteboard.convert(spec_dir, photo, None, env={})

        assert (result.status, result.reason) == ("unreadable", "timeout")


class TestWhatTheModelSaid:
    def test_json_that_draws_nothing_is_no_diagram(self, spec_dir, photo, vision):
        vision(json.dumps({"nodes": [], "edges": []}))

        assert whiteboard.convert(spec_dir, photo, None, env={}).status == (
            "not-a-diagram"
        )

    def test_prose_is_unparseable(self, spec_dir, photo, vision):
        vision("I see a whiteboard with some boxes on it.")

        assert whiteboard.convert(spec_dir, photo, None, env={}).status == (
            "unparseable"
        )

    def test_labels_the_secret_scan_cannot_read_write_nothing(
        self, spec_dir, photo, vision, monkeypatch
    ):
        vision(json.dumps(BOARD))

        def unavailable(_text):
            raise redact.ScannerUnavailable("no scanner")

        monkeypatch.setattr(redact, "redact_text", unavailable)

        result = whiteboard.convert(spec_dir, photo, None, env={})

        assert (result.status, result.reason) == (
            "unreadable",
            "secret-scan-unavailable",
        )
        assert not list((spec_dir / "attachments").glob("*.drawio"))


class TestWritingTheFile:
    def test_a_file_this_module_wrote_is_written_again(self, spec_dir, photo, vision):
        target = spec_dir / "attachments" / "board.whiteboard.drawio"
        vision(json.dumps({"nodes": [{"id": "a", "label": "Old"}]}))
        assert whiteboard.convert(spec_dir, photo, None, env={}).status == "converted"
        vision(json.dumps(BOARD))

        result = whiteboard.convert(spec_dir, photo, None, env={})

        assert (result.status, result.nodes) == ("converted", 4)
        assert "Old" not in target.read_text(encoding="utf-8")

    def test_a_target_that_cannot_be_read_is_not_overwritten(
        self, spec_dir, photo, vision, monkeypatch
    ):
        target = spec_dir / "attachments" / "board.whiteboard.drawio"
        target.write_text("<mxfile/>", encoding="utf-8")
        vision(json.dumps(BOARD))
        real = Path.read_bytes

        def read_bytes(self):
            if self == target:
                raise PermissionError(self)
            return real(self)

        monkeypatch.setattr(Path, "read_bytes", read_bytes)

        assert whiteboard.convert(spec_dir, photo, None, env={}).status == (
            "write-failed"
        )
        assert target.read_text(encoding="utf-8") == "<mxfile/>"

    def test_a_target_that_is_a_dangling_link_is_not_written(
        self, spec_dir, photo, vision, tmp_path
    ):
        victim = tmp_path / "victim.txt"
        try:
            (spec_dir / "attachments" / "board.whiteboard.drawio").symlink_to(victim)
        except (OSError, NotImplementedError):
            pytest.skip("symlinks need privileges on this platform")
        vision(json.dumps(BOARD))

        assert whiteboard.convert(spec_dir, photo, None, env={}).status == (
            "write-failed"
        )
        assert not victim.exists()

    def test_a_write_that_fails_says_so(self, spec_dir, photo, vision, monkeypatch):
        vision(json.dumps(BOARD))

        def refuse(self, *_args, **_kwargs):
            raise PermissionError(self)

        monkeypatch.setattr(Path, "write_text", refuse)

        assert whiteboard.convert(spec_dir, photo, None, env={}).status == (
            "write-failed"
        )


class TestConformance:
    def test_without_a_project_there_is_no_verdict(self, spec_dir, photo, vision):
        vision(json.dumps(BOARD))

        result = whiteboard.convert(spec_dir, photo, None, env={})

        assert result.status == "converted" and result.conformance is None

    def test_a_check_that_fails_leaves_the_conversion_standing(
        self, spec_dir, photo, vision, monkeypatch
    ):
        from docintel import conformance

        vision(json.dumps(BOARD))

        def broken(_project):
            raise RuntimeError("module graph unreadable")

        monkeypatch.setattr(conformance, "read_module_references", broken)

        result = whiteboard.convert(spec_dir, photo, spec_dir.parents[2], env={})

        assert result.status == "converted" and result.conformance is None
