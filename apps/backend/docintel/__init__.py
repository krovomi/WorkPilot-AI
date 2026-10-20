"""docintel: what a task's attachments and a project's ADRs say, read before planning.

Structured first — draw.io and Excalidraw are read as boxes and arrows, ADRs as
the Markdown they are, a stack trace as frames of this repository's files — and
local OCR only for pixels. Nothing here calls a model or the network by
default, and nothing here can fail a build.
"""

from .adr import collect_adrs, find_adr_dir, parse_adr
from .conformance import check_conformance, conformance_section
from .diagnostics import diagnose
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
from .prompt import (
    adr_section,
    attachments_section,
    diagnostics_section,
    docintel_section,
)
from .stacktrace import StackFrame, StackTrace, parse_stacktrace, render_stacktrace

__all__ = [
    "AdrRecord",
    "DiagramEdge",
    "DiagramModel",
    "DiagramNode",
    "DocintelResult",
    "StackFrame",
    "StackTrace",
    "ExtractedDocument",
    "adr_section",
    "attachment_paths",
    "attachments_section",
    "check_conformance",
    "collect_adrs",
    "conformance_section",
    "diagnose",
    "diagnostics_section",
    "docintel_section",
    "extract_file",
    "find_adr_dir",
    "load_result",
    "parse_adr",
    "parse_diagram",
    "parse_stacktrace",
    "render_diagram",
    "render_stacktrace",
    "run_preflight",
]
