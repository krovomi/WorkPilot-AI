"""Architecture Visualizer.

`analyzer` reads the codebase and produces a measured module graph. It used to
render that graph to Mermaid and call it the answer; it is now the **evidence**
an archify model is authored from, which is the job its heuristics are actually
good enough for. The renderer, the model and the per-task delta all live in
`archify/`.
"""

from .analyzer import ArchitectureAnalyzer
from .models import ArchitectureDiagram, DependencyEdge, DiagramType, ModuleNode

__all__ = [
    "ArchitectureAnalyzer",
    "ArchitectureDiagram",
    "DependencyEdge",
    "DiagramType",
    "ModuleNode",
]
