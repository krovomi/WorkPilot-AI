"""draw.io and Excalidraw files, read as the structures they are.

Neither format needs OCR. A `.drawio` is XML, an `.excalidraw` is JSON, and
both editors hide the same source inside their PNG and SVG exports so the file
can be re-opened for editing. Transcribing the pixels of such an export would
recover the words and lose the only thing a diagram says that prose does not:
which box points at which.

Every parser returns a `DiagramModel` or None, and never raises: a file that
merely has the right extension is a file somebody attached, not a contract.
"""

from __future__ import annotations

import base64
import html
import json
import re
import struct
import urllib.parse
import zlib
from pathlib import Path
from xml.etree.ElementTree import Element

from defusedxml.ElementTree import fromstring as _xml

from .models import DiagramEdge, DiagramModel, DiagramNode

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_EXCALIDRAW_MIME = "application/vnd.excalidraw+json"
_EXCALIDRAW_SVG_PAYLOAD = re.compile(
    r"<!--\s*payload-start\s*-->\s*(.+?)\s*<!--\s*payload-end\s*-->", re.S
)
_TAG = re.compile(r"<[^>]+>")
_BREAK = re.compile(r"<\s*br\s*/?\s*>|</\s*(?:div|p|li)\s*>", re.I)
_SPACES = re.compile(r"\s+")


# ---------------------------------------------------------------------------
# Containers: PNG text chunks and SVG attributes
# ---------------------------------------------------------------------------


def png_text_chunks(data: bytes) -> dict[str, str]:
    """`tEXt`, `zTXt` and `iTXt` chunks of a PNG, keyword -> text.

    Both editors write their source there. Reading stops at the first
    malformed chunk rather than guessing: a truncated file yields what came
    before the damage.
    """
    chunks: dict[str, str] = {}
    if not data.startswith(_PNG_SIGNATURE):
        return chunks
    offset = len(_PNG_SIGNATURE)
    while offset + 8 <= len(data):
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        kind = data[offset + 4 : offset + 8]
        body = data[offset + 8 : offset + 8 + length]
        offset += 12 + length
        if len(body) != length:
            break
        try:
            if kind == b"tEXt":
                key, _, text = body.partition(b"\0")
                chunks[key.decode("latin-1")] = text.decode("latin-1")
            elif kind == b"zTXt":
                key, _, rest = body.partition(b"\0")
                chunks[key.decode("latin-1")] = zlib.decompress(rest[1:]).decode(
                    "latin-1"
                )
            elif kind == b"iTXt":
                key, _, rest = body.partition(b"\0")
                compressed, rest = rest[0], rest[2:]
                _lang, _, rest = rest.partition(b"\0")
                _translated, _, text = rest.partition(b"\0")
                if compressed:
                    text = zlib.decompress(text)
                chunks[key.decode("latin-1")] = text.decode("utf-8", "replace")
            elif kind == b"IEND":
                break
        except (zlib.error, IndexError, UnicodeDecodeError):
            continue
    return chunks


# ---------------------------------------------------------------------------
# draw.io
# ---------------------------------------------------------------------------


def _plain(label: str) -> str:
    """A draw.io label is HTML more often than not."""
    text = _BREAK.sub(" ", label or "")
    text = html.unescape(_TAG.sub("", text))
    return _SPACES.sub(" ", text).strip()


def _inflate_diagram(text: str) -> str:
    """A compressed `<diagram>` body: base64, raw deflate, then URL-encoding."""
    raw = zlib.decompress(base64.b64decode(text.strip()), -15)
    return urllib.parse.unquote(raw.decode("utf-8"))


def _graph_models(root: Element) -> list[tuple[str, Element]]:
    if root.tag == "mxGraphModel":
        return [("", root)]
    models: list[tuple[str, Element]] = []
    for diagram in root.iter("diagram"):
        name = diagram.get("name", "")
        inner = diagram.find("mxGraphModel")
        if inner is None and (diagram.text or "").strip():
            try:
                inner = _xml(_inflate_diagram(diagram.text or ""))
            except Exception:  # noqa: BLE001 - one bad page, not a bad file
                continue
        if inner is not None:
            models.append((name, inner))
    return models


def _cells(model: Element) -> list[tuple[str, str, Element]]:
    """(id, label, mxCell) for every cell, unwrapping `UserObject`/`object`."""
    cells: list[tuple[str, str, Element]] = []
    root = model.find("root")
    if root is None:
        return cells
    for child in root:
        if child.tag == "mxCell":
            cells.append((child.get("id", ""), child.get("value", ""), child))
        elif child.tag in ("UserObject", "object"):
            inner = child.find("mxCell")
            if inner is not None:
                label = child.get("label", "") or child.get("value", "")
                cells.append((child.get("id", ""), label, inner))
    return cells


def parse_drawio_xml(text: str) -> DiagramModel | None:
    try:
        root = _xml(text)
    except Exception:  # noqa: BLE001
        return None

    pages = _graph_models(root)
    if not pages:
        return None

    diagram = DiagramModel(format="drawio", name=pages[0][0])
    for _name, model in pages:
        cells = _cells(model)
        vertices = {cid: cell for cid, _l, cell in cells if cell.get("vertex") == "1"}
        edges = {cid: cell for cid, _l, cell in cells if cell.get("edge") == "1"}
        labels = {cid: _plain(label) for cid, label, _c in cells}
        edge_labels: dict[str, list[str]] = {}
        referenced: set[str] = set()
        for cell in edges.values():
            referenced.update(filter(None, (cell.get("source"), cell.get("target"))))
        for cell in vertices.values():
            referenced.add(cell.get("parent", ""))

        for cid, cell in vertices.items():
            parent = cell.get("parent", "")
            # A label drawn on an arrow is a vertex whose parent is the edge.
            if parent in edges:
                if labels[cid]:
                    edge_labels.setdefault(parent, []).append(labels[cid])
                continue
            if not labels[cid] and cid not in referenced:
                continue  # decoration: an unlabeled shape nothing points at
            diagram.nodes.append(
                DiagramNode(
                    id=cid,
                    label=labels[cid],
                    parent=parent if parent in vertices else "",
                )
            )

        for cid, cell in edges.items():
            source, target = cell.get("source", ""), cell.get("target", "")
            if not source or not target:
                continue  # a dangling arrow claims nothing
            label = " ".join(filter(None, [labels[cid], *edge_labels.get(cid, [])]))
            diagram.edges.append(DiagramEdge(source=source, target=target, label=label))

    return diagram if diagram.nodes else None


def parse_drawio_svg(text: str) -> DiagramModel | None:
    """A `.drawio.svg` carries the whole `mxfile` in its `content` attribute."""
    try:
        root = _xml(text)
    except Exception:  # noqa: BLE001
        return None
    content = root.get("content", "")
    return parse_drawio_xml(content) if content else None


def parse_drawio_png(data: bytes) -> DiagramModel | None:
    text = png_text_chunks(data).get("mxfile", "")
    if not text:
        return None
    if not text.lstrip().startswith("<"):
        text = urllib.parse.unquote(text)
    return parse_drawio_xml(text)


# ---------------------------------------------------------------------------
# Excalidraw
# ---------------------------------------------------------------------------


def _decode_excalidraw_payload(text: str) -> dict | None:
    """The scene, from the wrapper Excalidraw puts in its exports.

    `{"encoding": "bstring", "compressed": true, "encoded": "..."}` is a byte
    string (one character per byte) of a zlib stream; older exports store the
    scene itself.
    """
    try:
        payload = json.loads(text)
    except (ValueError, TypeError):
        return None
    if isinstance(payload, dict) and "encoded" in payload:
        try:
            raw = str(payload["encoded"]).encode("latin-1")
            if payload.get("compressed"):
                raw = zlib.decompress(raw)
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, zlib.error, UnicodeError):
            return None
    return payload if isinstance(payload, dict) else None


def parse_excalidraw_scene(scene: dict) -> DiagramModel | None:
    elements = [
        e
        for e in scene.get("elements") or []
        if isinstance(e, dict) and not e.get("isDeleted")
    ]
    if not elements:
        return None

    bound_text: dict[str, list[str]] = {}
    for element in elements:
        if element.get("type") == "text" and element.get("containerId"):
            bound_text.setdefault(str(element["containerId"]), []).append(
                _SPACES.sub(" ", str(element.get("text", ""))).strip()
            )

    arrows = [e for e in elements if e.get("type") in ("arrow", "line")]
    referenced: set[str] = set()
    for arrow in arrows:
        for key in ("startBinding", "endBinding"):
            binding = arrow.get(key) or {}
            if binding.get("elementId"):
                referenced.add(str(binding["elementId"]))

    diagram = DiagramModel(format="excalidraw")
    ids = {str(e.get("id", "")) for e in elements}
    for element in elements:
        kind = element.get("type")
        eid = str(element.get("id", ""))
        if kind in ("arrow", "line"):
            continue
        if kind == "text":
            if element.get("containerId"):
                continue
            label = _SPACES.sub(" ", str(element.get("text", ""))).strip()
        elif kind in ("frame", "magicframe"):
            label = str(element.get("name") or "")
        else:
            label = " ".join(bound_text.get(eid, []))
        if not label and eid not in referenced:
            continue
        frame = str(element.get("frameId") or "")
        diagram.nodes.append(
            DiagramNode(id=eid, label=label, parent=frame if frame in ids else "")
        )

    for arrow in arrows:
        start = (arrow.get("startBinding") or {}).get("elementId")
        end = (arrow.get("endBinding") or {}).get("elementId")
        if not start or not end:
            continue
        diagram.edges.append(
            DiagramEdge(
                source=str(start),
                target=str(end),
                label=" ".join(bound_text.get(str(arrow.get("id", "")), [])),
            )
        )

    return diagram if diagram.nodes else None


def parse_excalidraw_json(text: str) -> DiagramModel | None:
    scene = _decode_excalidraw_payload(text)
    return parse_excalidraw_scene(scene) if scene else None


def parse_excalidraw_png(data: bytes) -> DiagramModel | None:
    text = png_text_chunks(data).get(_EXCALIDRAW_MIME, "")
    return parse_excalidraw_json(text) if text else None


def parse_excalidraw_svg(text: str) -> DiagramModel | None:
    match = _EXCALIDRAW_SVG_PAYLOAD.search(text)
    if not match:
        return None
    try:
        decoded = base64.b64decode(match.group(1)).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    return parse_excalidraw_json(decoded)


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


def parse_diagram(path: Path, data: bytes) -> DiagramModel | None:
    """Whichever of the formats above this file is, or None.

    Decided by content rather than by extension alone: `diagram.png` exported
    from draw.io with "include a copy of my diagram" is a draw.io file, and
    the name does not say so.
    """
    name = path.name.lower()
    if data.startswith(_PNG_SIGNATURE):
        return parse_drawio_png(data) or parse_excalidraw_png(data)

    text = data.decode("utf-8", errors="replace")
    head = text.lstrip()[:512]
    if name.endswith(".svg") or head.startswith("<svg") or "<svg" in head:
        return parse_drawio_svg(text) or parse_excalidraw_svg(text)
    if name.endswith((".drawio", ".dio")) or head.startswith(
        ("<mxfile", "<mxGraphModel")
    ):
        return parse_drawio_xml(text)
    if name.endswith(".excalidraw") or '"excalidraw"' in head:
        return parse_excalidraw_json(text)
    return None


def render_diagram(diagram: DiagramModel, *, limit: int = 120) -> str:
    """Nodes and arrows as lines a model reads at a glance.

    `Api -> Domain` rather than ids: an id is what the file needs to join the
    two ends, the label is what the diagram claims. Containers are printed as
    `[Layer] Box`, because the layer is the part a clean-architecture diagram
    is really about.
    """
    labels = {node.id: node.label or node.id for node in diagram.nodes}

    def name(node_id: str) -> str:
        return labels.get(node_id, node_id)

    lines: list[str] = []
    for node in diagram.nodes[:limit]:
        prefix = f"[{name(node.parent)}] " if node.parent else ""
        lines.append(f"- {prefix}{node.label or '(unlabeled)'}")
    if len(diagram.nodes) > limit:
        lines.append(f"- … {len(diagram.nodes) - limit} more elements")
    if diagram.edges:
        lines.append("Arrows:")
        for edge in diagram.edges[:limit]:
            label = f" ({edge.label})" if edge.label else ""
            lines.append(f"- {name(edge.source)} -> {name(edge.target)}{label}")
        if len(diagram.edges) > limit:
            lines.append(f"- … {len(diagram.edges) - limit} more arrows")
    return "\n".join(lines)
