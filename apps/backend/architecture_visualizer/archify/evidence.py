"""The facts about a codebase, collected without a model.

`analyzer.py` was written to *be* the answer, and as an answer its heuristics
are poor: "every imported identifier starting with a capital is a child
component" collects icons, types and `Button`. As **evidence handed to an
author**, the same import graph is the strongest material available — it is
measured rather than recalled, and the author is the one qualified to decide
that twelve files under `agents/` are one component called "Agent pipeline".

So nothing here decides anything. It reads files, ranks what it found, and
renders a bounded prompt section. The ranking matters as much as the reading:
a repository has thousands of modules and a diagram has at most a dozen
components, so handing over an unranked list moves the selection problem to the
model instead of solving it.
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import tomllib

from ..analyzer import ArchitectureAnalyzer

logger = logging.getLogger(__name__)

#: How many modules the prompt lists. Beyond this the section stops informing
#: the choice and starts making it for the model, badly.
MAX_MODULES = 60

#: Import edges shown. The graph is the point; a full adjacency list is not.
MAX_EDGES = 80

MAX_ENTRYPOINTS = 20
MAX_DEPENDENCIES = 40

#: Files whose presence names a runtime boundary the import graph cannot see.
_INFRA_FILES = (
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "Procfile",
    "serverless.yml",
    "kubernetes",
    "k8s",
    "helm",
    "terraform",
)

_MANIFESTS = (
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "pom.xml",
    "Cargo.toml",
    "build.gradle",
    "build.gradle.kts",
)

_ENTRYPOINT_NAMES = (
    "main.py",
    "app.py",
    "run.py",
    "manage.py",
    "wsgi.py",
    "asgi.py",
    "index.ts",
    "index.js",
    "main.ts",
    "main.js",
    "server.ts",
    "server.js",
    "main.go",
    "main.rs",
    "Program.cs",
    "Application.java",
)


@dataclass
class Evidence:
    """Everything the author gets that did not come from a model."""

    project_dir: Path
    modules: list[dict] = field(default_factory=list)
    edges: list[tuple[str, str]] = field(default_factory=list)
    entrypoints: list[str] = field(default_factory=list)
    manifests: dict[str, list[str]] = field(default_factory=dict)
    infrastructure: list[str] = field(default_factory=list)
    languages: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "projectDir": str(self.project_dir),
            "modules": self.modules,
            "edges": [list(e) for e in self.edges],
            "entrypoints": self.entrypoints,
            "manifests": self.manifests,
            "infrastructure": self.infrastructure,
            "languages": self.languages,
        }


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _dependencies(project_dir: Path) -> dict[str, list[str]]:
    """Declared dependencies per manifest — what the system talks to.

    Only the names. Versions answer a question nobody asks of a diagram, and
    they are the bulkiest part of every manifest.
    """
    found: dict[str, list[str]] = {}
    for name in _MANIFESTS:
        for path in sorted(project_dir.rglob(name)):
            if any(
                part in {"node_modules", ".venv", "venv", "dist", "build", ".git"}
                for part in path.parts
            ):
                continue
            rel = str(path.relative_to(project_dir)).replace("\\", "/")
            names: list[str] = []
            if name == "package.json":
                data = _read_json(path)
                names = sorted(
                    {
                        *(data.get("dependencies") or {}),
                        *(data.get("peerDependencies") or {}),
                    }
                )
            elif name == "pyproject.toml":
                try:
                    data = tomllib.loads(path.read_text(encoding="utf-8"))
                except (OSError, tomllib.TOMLDecodeError):
                    data = {}
                raw = (data.get("project") or {}).get("dependencies") or []
                names = [
                    str(d).split("[")[0].split("=")[0].split(">")[0].split("<")[0].strip()
                    for d in raw
                    if isinstance(d, str)
                ]
            elif name.startswith("requirements"):
                try:
                    lines = path.read_text(encoding="utf-8").splitlines()
                except OSError:
                    lines = []
                names = [
                    line.split("=")[0].split(">")[0].split("<")[0].split("[")[0].strip()
                    for line in lines
                    if line.strip() and not line.lstrip().startswith(("#", "-"))
                ]
            if names:
                found[rel] = sorted({n for n in names if n})[:MAX_DEPENDENCIES]
            if len(found) >= 8:
                return found
    return found


def _entrypoints(project_dir: Path) -> list[str]:
    hits: list[str] = []
    for name in _ENTRYPOINT_NAMES:
        for path in sorted(project_dir.rglob(name)):
            if any(
                part in {"node_modules", ".venv", "venv", "dist", "build", ".git"}
                for part in path.parts
            ):
                continue
            hits.append(str(path.relative_to(project_dir)).replace("\\", "/"))
            if len(hits) >= MAX_ENTRYPOINTS:
                return hits
    return hits


def _infrastructure(project_dir: Path) -> list[str]:
    hits: list[str] = []
    for name in _INFRA_FILES:
        for path in sorted(project_dir.rglob(name)):
            if any(
                part in {"node_modules", ".venv", "venv", ".git"} for part in path.parts
            ):
                continue
            hits.append(str(path.relative_to(project_dir)).replace("\\", "/"))
            if len(hits) >= 20:
                return hits
    return hits


def collect(project_dir: Path) -> Evidence:
    """Read the codebase. No model, no network, no decisions."""
    analyzer = ArchitectureAnalyzer(str(project_dir))
    graph = analyzer.analyze_module_dependencies()

    by_id = {node.id: node for node in graph.nodes}
    fan_in = Counter(edge.target_id for edge in graph.edges)
    fan_out = Counter(edge.source_id for edge in graph.edges)

    ranked = sorted(
        graph.nodes,
        key=lambda n: (fan_in[n.id] + fan_out[n.id], n.size_lines),
        reverse=True,
    )[:MAX_MODULES]
    kept = {node.id for node in ranked}

    modules = [
        {
            "path": node.path,
            "language": node.language,
            "lines": node.size_lines,
            "importedBy": fan_in[node.id],
            "imports": fan_out[node.id],
        }
        for node in ranked
    ]

    edges: list[tuple[str, str]] = []
    for edge in graph.edges:
        if edge.source_id in kept and edge.target_id in kept:
            source, target = by_id.get(edge.source_id), by_id.get(edge.target_id)
            if source and target:
                edges.append((source.path, target.path))
        if len(edges) >= MAX_EDGES:
            break

    languages = Counter(node.language for node in graph.nodes)

    return Evidence(
        project_dir=project_dir,
        modules=modules,
        edges=edges,
        entrypoints=_entrypoints(project_dir),
        manifests=_dependencies(project_dir),
        infrastructure=_infrastructure(project_dir),
        languages=dict(languages.most_common()),
    )


def render_section(evidence: Evidence) -> str:
    """The evidence as a prompt section — measured facts, labelled as such."""
    lines: list[str] = ["## Repository evidence (measured, not inferred)", ""]

    if evidence.languages:
        spread = ", ".join(
            f"{lang} ({count} files)" for lang, count in evidence.languages.items()
        )
        lines += [f"**Languages.** {spread}", ""]

    if evidence.entrypoints:
        lines += ["**Entrypoints.**"]
        lines += [f"- `{path}`" for path in evidence.entrypoints]
        lines.append("")

    if evidence.infrastructure:
        lines += ["**Deployment and runtime boundaries.**"]
        lines += [f"- `{path}`" for path in evidence.infrastructure]
        lines.append("")

    if evidence.modules:
        lines += [
            "**Most connected modules.** Ranked by import degree; the count is "
            + "how many project files import it and how many it imports.",
            "",
            "| path | lang | lines | imported by | imports |",
            "|---|---|---|---|---|",
        ]
        lines += [
            f"| `{m['path']}` | {m['language']} | {m['lines']} | "
            f"{m['importedBy']} | {m['imports']} |"
            for m in evidence.modules
        ]
        lines.append("")

    if evidence.edges:
        lines += [
            "**Import edges between those modules.** A real edge in the source, "
            + "not a guess about runtime causality — a call at startup and a call "
            + "on every request look identical here.",
            "",
        ]
        lines += [f"- `{a}` → `{b}`" for a, b in evidence.edges]
        lines.append("")

    if evidence.manifests:
        lines += ["**Declared dependencies.**", ""]
        for manifest, names in evidence.manifests.items():
            lines.append(f"- `{manifest}`: {', '.join(names)}")
        lines.append("")

    return "\n".join(lines)
