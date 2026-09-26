"""The shapes every extractor returns and every reader consumes.

No dependency on anything else in the backend: the preflight, the prompt
section, the API and the tests all read these, and a model module that imported
the agent stack would drag it into a status endpoint.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

#: What happened to one document. Kept as plain strings because they travel as
#: JSON to the Kanban, which translates them.
#:
#: ``diagram``  a structured diagram was read (draw.io, Excalidraw)
#: ``text``     text was read or transcribed (Markdown, OCR)
#: ``image``    pixels nobody transcribed here: the agent opens the file itself
#: ``document`` an Office/PDF file: the document skill converts it in-session
#: ``skipped``  too large, unreadable, or not a format this module knows
STATUSES = ("diagram", "text", "image", "document", "skipped")


@dataclass
class DiagramNode:
    id: str
    label: str
    #: Id of the container (draw.io group or swimlane, Excalidraw frame) —
    #: which is how a layer of a clean-architecture diagram is drawn.
    parent: str = ""


@dataclass
class DiagramEdge:
    source: str
    target: str
    label: str = ""


@dataclass
class DiagramModel:
    """Boxes, arrows and containers — the part of a diagram that is a claim.

    Positions, colours and fonts are dropped on purpose: "Api depends on
    Domain" survives a redraw, "the Api box is at x=120" does not, and only the
    first is something a plan can contradict.
    """

    format: str
    name: str = ""
    nodes: list[DiagramNode] = field(default_factory=list)
    edges: list[DiagramEdge] = field(default_factory=list)

    def label_of(self, node_id: str) -> str:
        for node in self.nodes:
            if node.id == node_id:
                return node.label or node_id
        return node_id

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict) -> DiagramModel:
        return cls(
            format=str(payload.get("format", "")),
            name=str(payload.get("name", "")),
            nodes=[DiagramNode(**n) for n in payload.get("nodes") or []],
            edges=[DiagramEdge(**e) for e in payload.get("edges") or []],
        )


@dataclass
class ExtractedDocument:
    """One input file, and what could be read out of it without a model."""

    #: Path relative to the spec directory (attachments) — never absolute, so
    #: the record can be served to the UI and read on another machine.
    path: str
    status: str
    #: Which reader produced the result: ``drawio``, ``excalidraw``,
    #: ``markdown``, ``tesseract``… Empty when nothing did.
    engine: str = ""
    #: Where the full extracted text was written, relative to the spec dir.
    extracted_path: str = ""
    text: str = ""
    diagram: DiagramModel | None = None
    #: Why nothing (or less than everything) was extracted.
    reason: str = ""
    #: ``safe`` / ``suspect`` / ``blocked`` from `injection_guard`. A document
    #: is data a person attached, and text inside an image is the easiest place
    #: to hide an instruction nobody reviewing the task will read.
    threat: str = "safe"

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["diagram"] = self.diagram.to_dict() if self.diagram else None
        return payload

    @classmethod
    def from_dict(cls, payload: dict) -> ExtractedDocument:
        diagram = payload.get("diagram")
        return cls(
            path=str(payload.get("path", "")),
            status=str(payload.get("status", "skipped")),
            engine=str(payload.get("engine", "")),
            extracted_path=str(payload.get("extracted_path", "")),
            text=str(payload.get("text", "")),
            diagram=DiagramModel.from_dict(diagram) if diagram else None,
            reason=str(payload.get("reason", "")),
            threat=str(payload.get("threat", "safe")),
        )


@dataclass
class AdrRecord:
    """One Architecture Decision Record, as the repository states it."""

    id: str
    title: str
    #: Lower-cased first word of the status: ``accepted``, ``proposed``,
    #: ``deprecated``, ``superseded``, ``rejected``… or ``unknown``.
    status: str
    path: str
    decision: str = ""
    superseded_by: str = ""

    @property
    def binding(self) -> bool:
        return self.status == "accepted" and not self.superseded_by

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["binding"] = self.binding
        return payload


@dataclass
class DocintelResult:
    """What the preflight read for one task, persisted next to the spec."""

    documents: list[ExtractedDocument] = field(default_factory=list)
    #: Why the preflight did nothing at all (``disabled``, ``no-attachments``).
    skipped: str = ""

    def to_dict(self) -> dict:
        return {
            "documents": [d.to_dict() for d in self.documents],
            "skipped": self.skipped,
        }

    @classmethod
    def from_dict(cls, payload: dict) -> DocintelResult:
        return cls(
            documents=[
                ExtractedDocument.from_dict(d)
                for d in payload.get("documents") or []
                if isinstance(d, dict)
            ],
            skipped=str(payload.get("skipped", "")),
        )

    def describe(self) -> str:
        """One line for the build log, or "" when there is nothing to say."""
        if not self.documents:
            return ""
        counts: dict[str, int] = {}
        for doc in self.documents:
            counts[doc.status] = counts.get(doc.status, 0) + 1
        parts = ", ".join(f"{n} {status}" for status, n in sorted(counts.items()))
        return f"Attachments read for this task: {parts}"
