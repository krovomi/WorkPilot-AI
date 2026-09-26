"""A PDF, read the cheapest way that works: its text layer, else its pixels.

A specification sent as a PDF is one of two very different files. A PDF
exported from Word carries its text, and reading it is a matter of asking; a
scanned one — the signed copy, the one that went through the photocopier — is
a stack of images, and every converter that reads text layers returns an empty
page for it. Before this module the preflight treated both as a *document* the
agents would convert themselves, which is right for the first and silently
empty for the second.

- **Structured first.** The text layer is read with its layout (characters
  placed where they are on the page), which is what lets a rule table be found
  in it. Only a page with no text is rendered and handed to the OCR chain.
- **Pages are capped** (`DOCINTEL_PDF_MAX_PAGES`). A scanned annex of three
  hundred pages is not what the task is about, and OCR costs a second a page.
- **The pixels stay on the machine.** Pages are rendered into a temporary
  directory, OCR'd by `ocr.ocr_image` — the same chain, the same airgap refusal
  for a cloud engine — and deleted.
- **Both backends are optional** and imported on first use: `pypdfium2` (a
  wheel on every platform, text layer and rendering) or `pdf2image` (rendering
  through Poppler). Neither installed is a recorded reason, never an error.

Nothing here raises.
"""

from __future__ import annotations

import logging
import struct
import tempfile
import zlib
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

#: Below this many visible characters a page has no usable text layer: a
#: scanned page often carries a page number or a stamp the scanner added.
MIN_TEXT_CHARS_PER_PAGE = 40
#: Rendering resolution for OCR. Tesseract is trained on ~300 dpi; 200 keeps a
#: page under ~2 MP and is still well above what OCR needs for body text.
RENDER_DPI = 200
#: Ceiling on the rendered bitmap's longer side. A PDF page can declare any
#: size, and a 200-inch page at 200 dpi is a 40 000-pixel bitmap.
MAX_RENDER_PIXELS = 4000


@dataclass
class PdfText:
    """What the text layer says, page by page, and why it may say nothing."""

    #: Pages in the document, whether or not they were read.
    total: int = 0
    #: One entry per page read (up to the cap), in order: layout text or "".
    pages: list[str] = field(default_factory=list)
    #: ``pypdfium2`` when the text layer could be read at all.
    backend: str = ""
    #: ``no-pdf-backend``, ``no-text-layer`` (only Poppler: pages can be
    #: rendered, not read), ``encrypted``, ``unreadable``, "" when read.
    reason: str = ""

    @property
    def scanned(self) -> bool:
        """True when the pages read carry no usable text: OCR is the only way."""
        if not self.pages:
            return False
        visible = sum(len("".join(page.split())) for page in self.pages)
        return visible < MIN_TEXT_CHARS_PER_PAGE * len(self.pages)


def _pdfium():
    try:
        import pypdfium2
    except ImportError:
        return None
    return pypdfium2


def backends() -> list[str]:
    """Which PDF readers this interpreter has — for the card and the doctor."""
    found = ["pypdfium2"] if _pdfium() is not None else []
    try:
        import pdf2image  # noqa: F401
    except ImportError:
        pass
    else:
        found.append("pdf2image")
    return found


def _layout_text(textpage) -> str:
    """The page's characters placed on lines and columns, as a monospace grid.

    `get_text_range` returns the reading order and loses the columns: a rule
    table comes back as one cell after another. Placing the characters by
    their boxes keeps what a table is — values that line up. The boxes are the
    *loose* ones (font bounds): a glyph's tight box puts a `y` lower than a
    `P` on the same line, and an `i` narrower than the character pitch.

    Within a word, characters follow each other; across a gap wider than a
    couple of characters, the text jumps to the column its x position names,
    so two rows whose cells start at the same x start at the same column.
    """
    count = textpage.count_chars()
    if count <= 0:
        return ""
    text = textpage.get_text_range()
    chars: list[tuple[float, float, float, float, str]] = []
    widths: list[float] = []
    for index in range(min(count, len(text))):
        char = text[index]
        if char in "\r\n" or char.isspace():
            continue
        try:
            left, bottom, right, top = textpage.get_charbox(index, loose=True)
        except Exception:  # noqa: BLE001 - one glyph, not the page
            continue
        if right <= left:
            continue
        chars.append((bottom, top, left, right, char))
        widths.append(right - left)
    if not chars:
        return ""
    widths.sort()
    pitch = widths[len(widths) // 2]

    # PDF coordinates grow upwards: the first line has the highest baseline.
    # A character joins the current line when its vertical span overlaps it.
    chars.sort(key=lambda c: (-(c[0] + c[1]) / 2, c[2]))
    lines: list[list[tuple[float, float, str]]] = []
    band: tuple[float, float] | None = None
    for bottom, top, left, right, char in chars:
        middle = (bottom + top) / 2
        if band is None or not band[0] <= middle <= band[1]:
            lines.append([])
            band = (bottom, top)
        lines[-1].append((left, right, char))

    origin = min(left for line in lines for left, _, _ in line)
    rendered: list[str] = []
    for line in lines:
        line.sort()
        out = ""
        previous_right: float | None = None
        for left, right, char in line:
            if previous_right is not None:
                gap = left - previous_right
                if gap > pitch * 1.5:
                    column = int(round((left - origin) / pitch))
                    out += " " * max(column - len(out), 2)
                elif gap > pitch * 0.3:
                    out += " "
            elif left - origin > pitch * 0.5:
                out += " " * int(round((left - origin) / pitch))
            out += char
            previous_right = right
        rendered.append(out.rstrip())
    return "\n".join(rendered).strip("\n")


def read_text(path: Path, max_pages: int) -> PdfText:
    """The text layer of the first `max_pages` pages. Never raises."""
    pdfium = _pdfium()
    if pdfium is None:
        total = _poppler_page_count(path)
        if total is None:
            return PdfText(reason="no-pdf-backend")
        return PdfText(total=total, reason="no-text-layer")
    try:
        document = pdfium.PdfDocument(str(path))
    except Exception as exc:  # noqa: BLE001 - a PDF somebody attached
        reason = "encrypted" if "password" in str(exc).lower() else "unreadable"
        return PdfText(reason=reason)
    result = PdfText(backend="pypdfium2")
    try:
        result.total = len(document)
        for index in range(min(result.total, max_pages)):
            try:
                page = document[index]
                textpage = page.get_textpage()
                result.pages.append(_layout_text(textpage))
            except Exception:  # noqa: BLE001 - one page, not the document
                logger.debug("docintel: page %d unreadable", index, exc_info=True)
                result.pages.append("")
    finally:
        try:
            document.close()
        except Exception:  # noqa: BLE001
            pass
    return result


def _poppler_page_count(path: Path) -> int | None:
    """Pages according to Poppler's `pdfinfo`, or None without pdf2image/Poppler."""
    try:
        from pdf2image import pdfinfo_from_path
    except ImportError:
        return None
    try:
        return int(pdfinfo_from_path(str(path)).get("Pages", 0))
    except Exception:  # noqa: BLE001 - Poppler missing, or a broken file
        return None


def _gray_png(bitmap) -> bytes:
    """A PNG from pdfium's grayscale bitmap, with zlib alone.

    `to_pil()` would make Pillow a second requirement of reading a scanned
    PDF; a greyscale PNG is a header, the rows each prefixed with filter 0,
    and one deflate stream. OCR does not need colour.
    """
    width, height, stride = bitmap.width, bitmap.height, bitmap.stride
    raw = bytes(bitmap.buffer)
    rows = b"".join(
        b"\x00" + raw[row * stride : row * stride + width] for row in range(height)
    )

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows, 6))
        + chunk(b"IEND", b"")
    )


def _render_pdfium(
    pdfium, path: Path, pages: list[int], directory: Path
) -> Iterator[tuple[int, Path]]:
    document = pdfium.PdfDocument(str(path))
    try:
        for index in pages:
            page = document[index]
            width, height = page.get_size()
            scale = RENDER_DPI / 72
            longest = max(width, height, 1.0) * scale
            if longest > MAX_RENDER_PIXELS:
                scale *= MAX_RENDER_PIXELS / longest
            bitmap = page.render(scale=scale, grayscale=True)
            target = directory / f"page-{index + 1:04d}.png"
            target.write_bytes(_gray_png(bitmap))
            yield index, target
    finally:
        document.close()


def _render_poppler(
    path: Path, pages: list[int], directory: Path
) -> Iterator[tuple[int, Path]]:
    from pdf2image import convert_from_path

    for index in pages:
        images = convert_from_path(
            str(path),
            dpi=RENDER_DPI,
            first_page=index + 1,
            last_page=index + 1,
            size=(MAX_RENDER_PIXELS, None),
        )
        if not images:
            continue
        target = directory / f"page-{index + 1:04d}.png"
        images[0].save(target, format="PNG")
        yield index, target


def render_pages(path: Path, pages: list[int]) -> Iterator[tuple[int, Path]]:
    """(page index, PNG) for each page asked, in a directory deleted afterwards.

    A generator so a caller reads one page at a time: the PNG exists while the
    caller holds it and is gone when the iteration ends, however it ends.
    Yields nothing when neither backend is installed.
    """
    with tempfile.TemporaryDirectory(prefix="docintel-pdf-") as tmp:
        directory = Path(tmp)
        pdfium = _pdfium()
        try:
            if pdfium is not None:
                yield from _render_pdfium(pdfium, path, pages, directory)
                return
            try:
                import pdf2image  # noqa: F401
            except ImportError:
                return
            yield from _render_poppler(path, pages, directory)
        except GeneratorExit:
            raise
        except Exception:  # noqa: BLE001 - a page that will not render is a gap
            logger.debug("docintel: rendering %s failed", path, exc_info=True)
            return


def page_count(path: Path) -> int:
    """Pages in the document, 0 when it cannot be opened."""
    return read_text(path, 0).total
