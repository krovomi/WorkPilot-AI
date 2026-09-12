"""Transforms a parsed IR module into a set of architecture diagrams.

This module analyzes the intermediate representation of a software system
and generates visual diagrams showing different aspects of the architecture:
- Module dependencies and their relationships
- Component hierarchies and structures
- Data flow between components
- Database schemas and relationships

Each diagram type focuses on a specific architectural perspective, helping
visualize different aspects of the system design.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class DiagramType(Enum):
    """Types of architecture diagrams that can be generated."""

    MODULE_DEPENDENCIES = "module_dependencies"
    COMPONENT_HIERARCHY = "component_hierarchy"
    DATA_FLOW = "data_flow"
    DATABASE_SCHEMA = "database_schema"


@dataclass
class Node:
    """Represents a node in an architecture diagram."""

    id: str
    label: str
    node_type: str
    properties: dict[str, Any] | None = None


@dataclass
class Edge:
    """Represents an edge/relationship between nodes in a diagram."""

    source_id: str
    target_id: str
    label: str | None = None
    edge_type: str | None = None
    properties: dict[str, Any] | None = None


@dataclass
class ArchitectureDiagram:
    """A complete architecture diagram with nodes and edges."""

    diagram_type: DiagramType
    title: str
    nodes: list[Node]
    edges: list[Edge]
    metadata: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert the diagram to a dictionary representation."""
        return {
            "type": self.diagram_type.value,
            "title": self.title,
            "nodes": [
                {
                    "id": node.id,
                    "label": node.label,
                    "type": node.node_type,
                    **(node.properties or {}),
                }
                for node in self.nodes
            ],
            "edges": [
                {
                    "source": edge.source_id,
                    "target": edge.target_id,
                    **({
                        "label": edge.label,
                        "type": edge.edge_type,
                        **(edge.properties or {}),
                    } if edge.label or edge.edge_type else {}),
                }
                for edge in self.edges
            ],
            **(self.metadata or {}),
        }


class Analyzer:
    """Analyzes IR modules and generates architecture diagrams."""

    def __init__(self, ir_module: Any):
        """Initialize the analyzer with an IR module.

        Args:
            ir_module: The intermediate representation module to analyze.
        """
        self.ir_module = ir_module

    def generate_module_dependencies(self) -> ArchitectureDiagram:
        """Generate a module dependencies diagram."""
        nodes = []
        edges = []

        # Extract modules from IR
        for module in self.ir_module.modules:
            nodes.append(
                Node(
                    id=module.id,
                    label=module.name,
                    node_type="module",
                    properties={"path": module.path},
                )
            )

        # Extract dependencies
        for module in self.ir_module.modules:
            for dep in module.dependencies or []:
                edges.append(
                    Edge(
                        source_id=module.id,
                        target_id=dep.id,
                        label="imports",
                        edge_type="dependency",
                    )
                )

        # Filter to top-level dependencies only
        top_ids = {n.id for n in nodes if n.properties.get("path", "").count("/") <= 2}
        nodes = [n for n in nodes if n.id in top_ids]
        edges = [
            e for e in edges if e.source_id in top_ids and e.target_id in top_ids
        ]

        diagram = ArchitectureDiagram(
            diagram_type=DiagramType.MODULE_DEPENDENCIES,
            title="Module Dependencies",
            nodes=nodes,
            edges=edges,
        )
        return diagram

    def generate_component_hierarchy(self) -> ArchitectureDiagram:
        """Generate a component hierarchy diagram."""
        nodes = []
        edges = []

        # Extract components
        for component in self.ir_module.components:
            nodes.append(
                Node(
                    id=component.id,
                    label=component.name,
                    node_type="component",
                    properties={"type": component.component_type},
                )
            )

        # Extract component relationships
        for component in self.ir_module.components:
            if hasattr(component, "parent_id") and component.parent_id:
                edges.append(
                    Edge(
                        source_id=component.id,
                        target_id=component.parent_id,
                        label="child_of",
                        edge_type="hierarchy",
                    )
                )
            for child_id in getattr(component, "child_ids", []) or []:
                edges.append(
                    Edge(
                        source_id=component.id,
                        target_id=child_id,
                        label="contains",
                        edge_type="hierarchy",
                    )
                )

            # Component interactions
            for interaction in getattr(component, "interactions", []) or []:
                edges.append(
                    Edge(
                        source_id=component.id,
                        target_id=interaction.target_id,
                        label="renders",
                    )
                )

        diagram = ArchitectureDiagram(
            diagram_type=DiagramType.COMPONENT_HIERARCHY,
            title="Component Hierarchy",
            nodes=nodes,
            edges=edges,
        )
        return diagram

    def generate_data_flow(self) -> ArchitectureDiagram:
        """Generate a data flow diagram."""
        nodes = []
        edges = []

        # Extract data stores
        for store in self.ir_module.data_stores:
            nodes.append(
                Node(
                    id=store.id,
                    label=store.name,
                    node_type="data_store",
                    properties={"store_type": store.store_type},
                )
            )

        # Extract processes
        for process in self.ir_module.processes:
            nodes.append(
                Node(
                    id=process.id,
                    label=process.name,
                    node_type="process",
                    properties={"type": process.process_type},
                )
            )

        # Extract data flows
        for flow in self.ir_module.data_flows:
            edges.append(
                Edge(
                    source_id=flow.source_id,
                    target_id=flow.target_id,
                    label=flow.data_type,
                    edge_type="data_flow",
                    properties={"volume": flow.volume},
                )
            )

        diagram = ArchitectureDiagram(
            diagram_type=DiagramType.DATA_FLOW,
            title="Data Flow",
            nodes=nodes,
            edges=edges,
        )
        return diagram

    def generate_database_schema(self) -> ArchitectureDiagram:
        """Generate a database schema diagram."""
        nodes = []
        edges = []

        # Extract tables/entities
        for entity in self.ir_module.entities:
            nodes.append(
                Node(
                    id=entity.id,
                    label=entity.name,
                    node_type="entity",
                    properties={
                        "columns": [
                            {"name": col.name, "type": col.data_type}
                            for col in entity.columns
                        ]
                    },
                )
            )

        # Extract relationships
        for relationship in self.ir_module.relationships:
            edges.append(
                Edge(
                    source_id=relationship.source_entity_id,
                    target_id=relationship.target_entity_id,
                    label="FK",
                )
            )

        diagram = ArchitectureDiagram(
            diagram_type=DiagramType.DATABASE_SCHEMA,
            title="Database Schema",
            nodes=nodes,
            edges=edges,
        )
        return diagram

    def generate_all_diagrams(self) -> list[ArchitectureDiagram]:
        """Generate all available diagrams."""
        diagrams = []
        try:
            diagrams.append(self.generate_module_dependencies())
        except Exception:  # noqa: BLE001
            pass
        try:
            diagrams.append(self.generate_component_hierarchy())
        except Exception:  # noqa: BLE001
            pass
        try:
            diagrams.append(self.generate_data_flow())
        except Exception:  # noqa: BLE001
            pass
        try:
            diagrams.append(self.generate_database_schema())
        except Exception:  # noqa: BLE001
            pass
        return diagrams
