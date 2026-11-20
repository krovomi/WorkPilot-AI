"""Diagram files of every odd shape an editor or a person can produce.

`test_docintel.py` reads a well-formed draw.io and Excalidraw file in each of
their containers. This file feeds the readers what a damaged export, a hand
edit or a newer editor writes: a page without cells, a PNG chunk compressed or
URL-encoded, a scene whose bindings are not objects, an SVG without its
payload. A file the readers cannot make sense of is "no diagram", never an
exception, and a diagram too long for the prompt says how much was left out.
"""

from __future__ import annotations

import base64
import json
import struct
import sys
import urllib.parse
import zlib
from pathlib import Path

import pytest
from docintel import diagrams
from docintel.diagrams import parse_diagram, render_diagram
from docintel.models import DiagramEdge, DiagramModel, DiagramNode


def _chunk(kind: bytes, body: bytes) -> bytes:
    crc = zlib.crc32(kind + body) & 0xFFFFFFFF
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", crc)


def _png(*chunks: bytes) -> bytes:
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + b"".join(chunks)
        + _chunk(b"IEND", b"")
    )


def _itxt(key: str, text: str, *, compressed: bool) -> bytes:
    body = text.encode("utf-8")
    if compressed:
        body = zlib.compress(body)
    flag = b"\x01" if compressed else b"\x00"
    return _chunk(b"iTXt", key.encode() + b"\0" + flag + b"\0" + b"\0" + b"\0" + body)


MODEL = (
    "<mxGraphModel><root>"
    '<mxCell id="0"/><mxCell id="1" parent="0"/>'
    '<mxCell id="a" value="Api" vertex="1" parent="1"/>'
    '<mxCell id="b" value="Db" vertex="1" parent="1"/>'
    '<mxCell id="e" edge="1" source="a" target="b" parent="1"/>'
    '<mxCell id="e-empty" value="" vertex="1" parent="e"/>'
    '<UserObject id="lonely" label="No cell"/>'
    "<foo/>"
    "</root></mxGraphModel>"
)


class TestDrawioShapes:
    def test_odd_children_of_a_page_are_skipped(self):
        diagram = parse_diagram(
            Path("a.drawio"), f"<mxfile><diagram>{MODEL}</diagram></mxfile>".encode()
        )

        assert [n.label for n in diagram.nodes] == ["Api", "Db"]
        assert [(e.source, e.target, e.label) for e in diagram.edges] == [
            ("a", "b", "")
        ]

    def test_a_page_without_cells_is_no_diagram(self):
        assert parse_diagram(Path("a.drawio"), b"<mxGraphModel/>") is None

    def test_an_svg_that_is_not_xml_is_no_diagram(self):
        assert parse_diagram(Path("a.svg"), b"<svg <<< not xml") is None

    def test_a_png_chunk_compressed_in_itxt_is_read(self):
        png = _png(
            _itxt(
                "mxfile",
                f"<mxfile><diagram>{MODEL}</diagram></mxfile>",
                compressed=True,
            )
        )

        assert parse_diagram(Path("a.png"), png).format == "drawio"

    def test_a_url_encoded_png_chunk_is_decoded(self):
        quoted = urllib.parse.quote(f"<mxfile><diagram>{MODEL}</diagram></mxfile>")
        png = _png(_itxt("mxfile", quoted, compressed=False))

        assert {n.label for n in parse_diagram(Path("a.png"), png).nodes} == {
            "Api",
            "Db",
        }

    def test_without_the_hardened_parser_xml_formats_are_unavailable(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "defusedxml.ElementTree", None)

        assert diagrams.xml_available() is False


def _scene(*elements) -> bytes:
    return json.dumps({"type": "excalidraw", "elements": list(elements)}).encode()


BOX = {"id": "a", "type": "rectangle"}
BOX_TEXT = {"id": "a-t", "type": "text", "text": "Api", "containerId": "a"}
OTHER = {"id": "b", "type": "rectangle"}
OTHER_TEXT = {"id": "b-t", "type": "text", "text": "Db", "containerId": "b"}


class TestExcalidrawShapes:
    @pytest.mark.parametrize(
        "body",
        [
            b"{not json",
            json.dumps({"encoded": "Ā not a byte string"}).encode(),
            json.dumps({"elements": "not a list", "type": "excalidraw"}).encode(),
            _scene({"id": "x", "type": "rectangle", "isDeleted": True}),
        ],
    )
    def test_a_scene_it_cannot_read_is_no_diagram(self, body):
        assert parse_diagram(Path("a.excalidraw"), body) is None

    def test_an_uncompressed_wrapper_is_read(self):
        scene = _scene(BOX, BOX_TEXT).decode()
        wrapped = json.dumps({"encoding": "bstring", "encoded": scene}).encode()

        assert [
            n.label for n in parse_diagram(Path("a.excalidraw"), wrapped).nodes
        ] == ["Api"]

    def test_bindings_that_are_not_objects_and_free_ends_draw_no_arrow(self):
        body = _scene(
            BOX,
            BOX_TEXT,
            OTHER,
            OTHER_TEXT,
            {"id": "x1", "type": "arrow", "startBinding": "a", "endBinding": ["b"]},
            {"id": "x2", "type": "arrow", "startBinding": {"elementId": "a"}},
            {
                "id": "x3",
                "type": "arrow",
                "startBinding": {"elementId": "a"},
                "endBinding": {"elementId": "b"},
            },
        )

        diagram = parse_diagram(Path("a.excalidraw"), body)

        assert [(e.source, e.target) for e in diagram.edges] == [("a", "b")]

    @pytest.mark.parametrize(
        "svg",
        [
            "<svg><!-- no payload here --></svg>",
            "<svg><!-- payload-start -->@@@not base64@@@<!-- payload-end --></svg>",
            "<svg><!-- payload-start -->"
            + base64.b64encode(b"\xff\xfe").decode()
            + "<!-- payload-end --></svg>",
        ],
    )
    def test_an_svg_without_a_readable_payload_is_no_diagram(self, svg):
        assert parse_diagram(Path("a.svg"), svg.encode()) is None


class TestRendering:
    def test_a_long_diagram_says_how_much_was_left_out(self):
        diagram = DiagramModel(
            format="drawio",
            nodes=[DiagramNode(id=str(i), label=f"Box {i}") for i in range(4)],
            edges=[DiagramEdge(source="0", target=str(i)) for i in range(1, 4)],
        )

        rendered = render_diagram(diagram, limit=2)

        assert "- … 2 more elements" in rendered
        assert "- … 1 more arrows" in rendered
        assert "Box 3" not in rendered
