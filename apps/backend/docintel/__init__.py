"""docintel: what a task's attachments and a project's ADRs say, read before planning.

Structured first — draw.io and Excalidraw are read as boxes and arrows, ADRs as
the Markdown they are — and local OCR (Tesseract) only for pixels. Nothing here
calls a model or the network, and nothing here can fail a build.
"""

from .adr import collect_adrs, find_adr_dir, parse_adr
from .conformance import check_conformance, conformance_section
from .diagrams import parse_diagram, render_diagram
from .models import (
    AdrRecord,
    DiagramEdge,
    DiagramModel,
    DiagramNode,
    DocintelResult,
    ExtractedDocument,
)
from .preflight import attachment_paths, extract_file, load_result, run_preflight
from .prompt import adr_section, attachments_section, docintel_section

__all__ = [
    "AdrRecord",
    "DiagramEdge",
    "DiagramModel",
    "DiagramNode",
    "DocintelResult",
    "ExtractedDocument",
    "adr_section",
    "attachment_paths",
    "attachments_section",
    "check_conformance",
    "collect_adrs",
    "conformance_section",
    "docintel_section",
    "extract_file",
    "find_adr_dir",
    "load_result",
    "parse_adr",
    "parse_diagram",
    "render_diagram",
    "run_preflight",
]
