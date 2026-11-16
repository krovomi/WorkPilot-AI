"""A PDF read through whichever backend this Python has, and when it has none.

`test_docintel_specs.py` reads a real text PDF and a real scan through
pypdfium2. This file covers the rest: no backend at all, Poppler only (its
page count and its rendering, through a stand-in `pdf2image`, which the test
environment does not install), glyphs whose boxes cannot be read, a page or a
close that fails, a page too large to render at full resolution, and a file
that will not open for rendering.
"""

from __future__ import annotations

import struct
import sys
import types
from pathlib import Path

import pytest
from docintel import pdf
from docintel.pdf import PdfText, backends, read_text, render_pages

needs_pdfium = pytest.mark.skipif(
    pdf._pdfium() is None, reason="pypdfium2 is not installed"
)


def blank_pdf(width: int, height: int) -> bytes:
    """A one-page PDF of the given size in points, with nothing on it."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] >>" % (width, height),
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref,
    )
    return out


@pytest.fixture
def without_pdfium(monkeypatch):
    monkeypatch.setitem(sys.modules, "pypdfium2", None)


@pytest.fixture
def poppler(monkeypatch):
    """A stand-in `pdf2image`: its page count and its renderer, recorded."""
    module = types.ModuleType("pdf2image")
    module.info = {"Pages": 3}
    module.rendered = []

    def pdfinfo_from_path(path):
        if isinstance(module.info, Exception):
            raise module.info
        return module.info

    class Image:
        def save(self, target, format):
            target.write_bytes(b"\x89PNG " + format.encode())

    def convert_from_path(path, dpi, first_page, last_page, size):
        module.rendered.append((first_page, last_page, dpi, size))
        return [] if first_page == 2 else [Image()]

    module.pdfinfo_from_path = pdfinfo_from_path
    module.convert_from_path = convert_from_path
    monkeypatch.setitem(sys.modules, "pdf2image", module)
    return module


class TestBackends:
    def test_a_document_with_no_page_read_is_not_a_scan(self):
        assert PdfText(total=2).scanned is False

    def test_without_any_backend_the_reason_says_so(self, without_pdfium, monkeypatch):
        monkeypatch.setitem(sys.modules, "pdf2image", None)

        assert backends() == []
        assert read_text(Path("spec.pdf"), 5).reason == "no-pdf-backend"
        assert list(render_pages(Path("spec.pdf"), [0])) == []

    def test_poppler_alone_counts_pages_but_reads_no_text(
        self, without_pdfium, poppler
    ):
        assert backends() == ["pdf2image"]

        layer = read_text(Path("spec.pdf"), 5)

        assert (layer.total, layer.reason, layer.pages) == (3, "no-text-layer", [])

    def test_a_poppler_that_cannot_count_is_no_backend(self, without_pdfium, poppler):
        poppler.info = OSError("pdfinfo not found")

        assert read_text(Path("spec.pdf"), 5).reason == "no-pdf-backend"

    def test_poppler_renders_each_page_it_can(self, without_pdfium, poppler):
        seen = [
            (index, image.name, image.read_bytes())
            for index, image in render_pages(Path("spec.pdf"), [0, 1, 2])
        ]

        assert seen == [
            (0, "page-0001.png", b"\x89PNG PNG"),
            (2, "page-0003.png", b"\x89PNG PNG"),
        ]
        assert [r[0] for r in poppler.rendered] == [1, 2, 3]
        assert poppler.rendered[0][2:] == (
            pdf.RENDER_DPI,
            (pdf.MAX_RENDER_PIXELS, None),
        )


class _TextPage:
    """pypdfium2's text page, as far as `_layout_text` asks it."""

    def __init__(self, text: str, boxes: dict[int, tuple[float, float, float, float]]):
        self.text = text
        self.boxes = boxes

    def count_chars(self) -> int:
        return len(self.text)

    def get_text_range(self) -> str:
        return self.text

    def get_charbox(self, index: int, loose: bool):
        assert loose
        box = self.boxes.get(index)
        if box is None:
            raise ValueError(index)
        return box


class TestLayout:
    def test_glyphs_without_a_usable_box_leave_an_empty_page(self):
        page = _TextPage("ab", {1: (10, 0, 10, 10)})  # 0 has no box, 1 no width

        assert pdf._layout_text(page) == ""

    def test_an_indented_line_keeps_its_indent(self):
        # "Ab" at x=0 on the first line, "C" indented by three pitches below.
        page = _TextPage(
            "Ab\nC",
            {
                0: (0, 90, 10, 100),
                1: (10, 90, 20, 100),
                3: (30, 70, 40, 80),
            },
        )

        assert pdf._layout_text(page) == "Ab\n   C"


class _Document:
    def __init__(self, pages: int, close_error: bool):
        self.pages = pages
        self.close_error = close_error

    def __len__(self) -> int:
        return self.pages

    def __getitem__(self, index: int):
        raise RuntimeError(f"page {index} is damaged")

    def close(self) -> None:
        if self.close_error:
            raise RuntimeError("already closed")


class TestReading:
    def test_a_page_that_fails_is_an_empty_page_and_the_rest_is_read(self, monkeypatch):
        fake = types.SimpleNamespace(PdfDocument=lambda path: _Document(3, True))
        monkeypatch.setattr(pdf, "_pdfium", lambda: fake)

        layer = read_text(Path("spec.pdf"), 2)

        assert (layer.total, layer.pages, layer.reason) == (3, ["", ""], "")

    @needs_pdfium
    def test_a_page_too_large_is_rendered_within_the_ceiling(self, tmp_path):
        path = tmp_path / "poster.pdf"
        path.write_bytes(blank_pdf(4000, 2000))

        # The PNG lives while the iteration holds it: read its size in the loop.
        sizes = [
            (index, struct.unpack(">II", image.read_bytes()[16:24]))
            for index, image in render_pages(path, [0])
        ]

        assert sizes == [(0, (pdf.MAX_RENDER_PIXELS, 2000))]

    @needs_pdfium
    def test_a_file_that_will_not_open_renders_nothing(self, tmp_path):
        path = tmp_path / "broken.pdf"
        path.write_bytes(b"%PDF-1.4 truncated")

        assert list(render_pages(path, [0])) == []
