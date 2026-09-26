"""Does the code depend the way the architecture diagram says it does?

A clean-architecture diagram is a claim about dependency direction: `Api ->
Application -> Domain`, `Infrastructure -> Application`, and nothing pointing
back. The claim is drawn once, in `docs/`, and the code drifts away from it one
`<ProjectReference>` at a time — a repository interface implemented inside
Domain, an Application service reaching into Infrastructure for a DbContext.
Nobody re-reads the diagram when adding a reference, and no reviewer can see the
whole graph from a diff.

This module reads both sides without a model:

| Side | Read from |
|---|---|
| the diagram | the repository's own draw.io / Excalidraw files, and C4 written as code — Structurizr DSL, C4-PlantUML (`diagrams.py`, `c4.py`) |
| the code | the module graph the build declares: `.csproj` `ProjectReference`, Maven `<dependency>` between the reactor's modules, Gradle `project(":x")`, npm / pnpm / yarn workspace dependencies, Cargo `path =` dependencies |

**Declared, not inferred.** A module dependency is the one graph that is
declared rather than guessed: it is what the build uses, and a layer of a
clean-architecture solution *is* a module — a .NET project, a Maven or Gradle
module, a workspace package, a crate. An import-based graph answers a fuzzier
question and would be a different module; a single-module project has no
declared graph and is left alone.

**Transitive, not literal.** A diagram draws `Api -> Application -> Domain`; a
direct `Api -> Domain` reference is allowed by it and is not reported. Only a
dependency the diagram cannot reach is: *inverted* when the diagram points the
other way (the real clean-architecture violation), *undrawn* otherwise.

**A diagram drawn the other way round says nothing.** Some teams draw data flow
rather than dependencies. When a diagram's arrows only ever contradict the
code's direction, it is reported as ambiguous and produces no finding — a check
that flags every reference in a solution is a check people learn to ignore.
"""

from __future__ import annotations

import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .diagrams import _xml, parse_diagram
from .models import DiagramModel

#: Where a repository keeps architecture diagrams.
DIAGRAM_DIRS = ("docs", "doc", "architecture", "design", ".")
DIAGRAM_SUFFIXES = (
    ".dsl",
    ".puml",
    ".plantuml",
    ".drawio",
    ".dio",
    ".excalidraw",
    ".drawio.svg",
    ".drawio.png",
    ".excalidraw.svg",
    ".excalidraw.png",
)
SKIP_DIRS = {
    ".git",
    ".workpilot",
    "node_modules",
    "bin",
    "obj",
    ".venv",
    "venv",
    "dist",
    "build",
    ".vs",
    ".idea",
    "packages",
    "TestResults",
}
MAX_DIAGRAMS = 20
MAX_PROJECTS = 400
MAX_DIAGRAM_BYTES = 5 * 1024 * 1024
MAX_FINDINGS = 25

_SEGMENT = re.compile(r"[A-Za-z0-9]+")
#: PascalCase words: `SharedKernel` -> `Shared`, `Kernel`; `DBContext` -> `DB`, `Context`.
_WORD = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+")
_TEST_SEGMENTS = {"test", "tests", "unittests", "integrationtests", "specs", "e2e"}


@dataclass
class ConformanceFinding:
    diagram: str
    source_project: str
    target_project: str
    source_layer: str
    target_layer: str
    #: ``inverted``: the diagram points from target to source.
    #: ``undrawn``: the diagram connects the two layers in no direction.
    kind: str
    #: The `.csproj` that declares the reference, relative to the project.
    file: str = ""


@dataclass
class DiagramCheck:
    diagram: str
    #: layer label -> project names it covers.
    layers: dict[str, list[str]] = field(default_factory=dict)
    #: ``checked``, ``too-few-layers``, ``ambiguous-direction``.
    status: str = "checked"
    allowed: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class ConformanceReport:
    checks: list[DiagramCheck] = field(default_factory=list)
    findings: list[ConformanceFinding] = field(default_factory=list)
    #: Why nothing was checked: ``no-diagram``, ``no-projects``.
    skipped: str = ""

    def to_dict(self) -> dict:
        return {
            "checks": [
                {**asdict(c), "allowed": [list(edge) for edge in c.allowed]}
                for c in self.checks
            ],
            "findings": [asdict(f) for f in self.findings],
            "skipped": self.skipped,
        }


# ---------------------------------------------------------------------------
# Reading the two sides
# ---------------------------------------------------------------------------


def _walk(root: Path, max_depth: int):
    """Files under `root`, pruning build output and vendored trees."""
    root_depth = len(root.parts)
    for current, dirs, files in os.walk(root):
        path = Path(current)
        if len(path.parts) - root_depth >= max_depth:
            dirs[:] = []
        dirs[:] = sorted(
            d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")
        )
        for name in sorted(files):
            candidate = path / name
            # A link could name a file outside the repository; `os.walk`
            # already refuses to descend into linked directories.
            if not candidate.is_symlink():
                yield candidate


def find_diagrams(project_dir: Path) -> list[Path]:
    """The repository's own architecture diagrams, most likely first."""
    found: list[Path] = []
    seen: set[Path] = set()
    for relative in DIAGRAM_DIRS:
        base = project_dir / relative
        if not base.is_dir() or (relative != "." and base.is_symlink()):
            continue
        # Only the root's own files: a diagram kept beside the solution file
        # is a diagram of it, one buried in a sample project is not.
        depth = 0 if relative == "." else 6
        for path in _walk(base, depth):
            if path.name.lower().endswith(DIAGRAM_SUFFIXES) and path not in seen:
                seen.add(path)
                found.append(path)
                if len(found) >= MAX_DIAGRAMS:
                    return found
    return found


def _is_test_project(name: str) -> bool:
    segments = {s.lower() for s in _SEGMENT.findall(name)}
    return bool(segments & _TEST_SEGMENTS) or name.lower().endswith("tests")


def read_project_references(
    project_dir: Path,
) -> tuple[dict[str, str], list[tuple[str, str, str]]]:
    """(project name -> csproj path, [(from, to, csproj path)]).

    Test projects are left out on both ends: a test project references
    everything by design, and that is not a layer crossing.
    """
    projects: dict[str, str] = {}
    references: list[tuple[str, str, str]] = []
    for path in _walk(project_dir, 8):
        if path.suffix.lower() != ".csproj":
            continue
        if len(projects) >= MAX_PROJECTS:
            break
        name = path.stem
        if _is_test_project(name):
            continue
        relative = path.relative_to(project_dir).as_posix()
        projects[name] = relative
        try:
            root = _xml(path.read_text(encoding="utf-8-sig", errors="replace"))
        except Exception:  # noqa: BLE001 - an unreadable csproj adds no edge
            continue
        for element in root.iter():
            if element.tag.rsplit("}", 1)[-1] != "ProjectReference":
                continue
            include = (element.get("Include") or "").replace("\\", "/")
            target = Path(include).stem
            if target and not _is_test_project(target):
                references.append((name, target, relative))
    return projects, [r for r in references if r[1] in projects]


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _read_maven(
    project_dir: Path, modules: dict[str, str], edges: list[tuple[str, str, str]]
) -> None:
    """Maven: a module is an artifactId; an edge, a `<dependency>` on a sibling's."""
    for path in _walk(project_dir, 8):
        if path.name != "pom.xml":
            continue
        try:
            root = _xml(path.read_text(encoding="utf-8", errors="replace"))
        except Exception:  # noqa: BLE001 - an unreadable pom adds no module
            continue
        artifact = next(
            (c.text or "" for c in root if _local(c.tag) == "artifactId"), ""
        ).strip()
        if not artifact or _is_test_project(artifact):
            continue
        relative = path.relative_to(project_dir).as_posix()
        modules[artifact] = relative
        for dependencies in (c for c in root if _local(c.tag) == "dependencies"):
            for dependency in dependencies:
                target = next(
                    (c.text or "" for c in dependency if _local(c.tag) == "artifactId"),
                    "",
                ).strip()
                if target:
                    edges.append((artifact, target, relative))


_GRADLE_INCLUDE = re.compile(r"""['"]:?(?P<path>[\w.:-]+)['"]""")
_GRADLE_PROJECT = re.compile(
    r"""project\(\s*(?:path\s*[:=]\s*)?['"]:?(?P<path>[\w.:-]+)['"]|\bprojects\.(?P<accessor>[\w.]+)"""
)


def _read_gradle(
    project_dir: Path, modules: dict[str, str], edges: list[tuple[str, str, str]]
) -> None:
    """Gradle: modules from `settings.gradle(.kts)`, edges from `project(":x")`."""
    for settings_name in ("settings.gradle", "settings.gradle.kts"):
        settings = project_dir / settings_name
        if not settings.is_file() or settings.is_symlink():
            continue
        text = settings.read_text(encoding="utf-8", errors="replace")
        declared = [
            m["path"]
            for line in text.splitlines()
            if line.strip().startswith("include")
            for m in _GRADLE_INCLUDE.finditer(line)
        ]
        for module_path in declared:
            name = module_path.split(":")[-1]
            directory = project_dir / module_path.replace(":", "/")
            build = next(
                (
                    directory / f
                    for f in ("build.gradle.kts", "build.gradle")
                    if (directory / f).is_file()
                ),
                None,
            )
            if _is_test_project(name) or build is None or build.is_symlink():
                continue
            relative = build.relative_to(project_dir).as_posix()
            modules[name] = relative
            for m in _GRADLE_PROJECT.finditer(
                build.read_text(encoding="utf-8", errors="replace")
            ):
                target = (m["path"] or "").split(":")[-1] or (
                    m["accessor"] or ""
                ).split(".")[-1]
                if target:
                    edges.append((name, target, relative))


def _workspace_patterns(project_dir: Path) -> list[str]:
    """The globs a JS monorepo declares: `workspaces` in package.json, or pnpm's file."""
    import json

    patterns: list[str] = []
    try:
        root = json.loads((project_dir / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        root = {}
    declared = root.get("workspaces") if isinstance(root, dict) else None
    if isinstance(declared, dict):
        declared = declared.get("packages")
    if isinstance(declared, list):
        patterns += [str(p) for p in declared]
    try:
        pnpm = (project_dir / "pnpm-workspace.yaml").read_text(encoding="utf-8")
    except OSError:
        pnpm = ""
    patterns += re.findall(r"^\s*-\s*['\"]?([^'\"#\n]+?)['\"]?\s*$", pnpm, re.M)
    return [p for p in patterns if not p.startswith("!") and ".." not in p]


def _read_workspaces(
    project_dir: Path, modules: dict[str, str], edges: list[tuple[str, str, str]]
) -> None:
    """npm / pnpm / yarn workspaces: a package's `dependencies` on a sibling package.

    The packages are the ones the workspace declares, not every `package.json`
    on disk: a fixture or an example app is not a module of the build.
    """
    import json

    packages: list[tuple[str, dict, str]] = []
    seen: set[Path] = set()
    for pattern in _workspace_patterns(project_dir):
        for manifest in sorted(project_dir.glob(f"{pattern.rstrip('/')}/package.json")):
            if (
                manifest in seen
                or manifest.is_symlink()
                or "node_modules" in manifest.parts
            ):
                continue
            seen.add(manifest)
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(data, dict) and isinstance(data.get("name"), str):
                packages.append(
                    (data["name"], data, manifest.relative_to(project_dir).as_posix())
                )
    if len(packages) < 2:
        return
    for name, data, relative in packages:
        if _is_test_project(name):
            continue
        modules[name] = relative
        for key in ("dependencies", "peerDependencies"):
            section = data.get(key)
            if isinstance(section, dict):
                edges.extend((name, str(target), relative) for target in section)


_CARGO_NAME = re.compile(r"^\s*name\s*=\s*\"(?P<name>[^\"]+)\"", re.M)
_CARGO_PATH_DEP = re.compile(
    r"^\s*(?P<name>[\w-]+)\s*=\s*\{[^}\n]*\bpath\s*=\s*\"(?P<path>[^\"]+)\"", re.M
)


def _read_cargo(
    project_dir: Path, modules: dict[str, str], edges: list[tuple[str, str, str]]
) -> None:
    """Cargo workspaces: a crate's `path =` dependency on a sibling crate."""
    for path in _walk(project_dir, 6):
        if path.name != "Cargo.toml":
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        package = text.split("[package]", 1)
        if len(package) < 2 or not (m := _CARGO_NAME.search(package[1])):
            continue
        name = m["name"]
        if _is_test_project(name):
            continue
        relative = path.relative_to(project_dir).as_posix()
        modules[name] = relative
        for dep in _CARGO_PATH_DEP.finditer(text):
            edges.append((name, dep["name"], relative))


def read_module_references(
    project_dir: Path,
) -> tuple[dict[str, str], list[tuple[str, str, str]]]:
    """(module -> manifest, [(from, to, manifest)]) across every build system.

    `.csproj` first, then Maven, Gradle, JS workspaces and Cargo: a repository
    with a .NET API and a TypeScript front-end workspace gets both graphs, and a
    box names whichever modules it covers.
    """
    modules, edges = read_project_references(project_dir)
    extra: dict[str, str] = {}
    extra_edges: list[tuple[str, str, str]] = []
    for reader in (_read_maven, _read_gradle, _read_workspaces, _read_cargo):
        try:
            reader(project_dir, extra, extra_edges)
        except OSError:
            continue
        if len(extra) >= MAX_PROJECTS:
            break
    for name, manifest in extra.items():
        modules.setdefault(name, manifest)
    edges = edges + [e for e in extra_edges if e[1] in modules and e[0] != e[1]]
    return modules, list(dict.fromkeys(edges))


# ---------------------------------------------------------------------------
# Matching boxes to projects
# ---------------------------------------------------------------------------


def _segments(text: str) -> list[str]:
    """Lower-cased words, PascalCase split: a box reads `Shared Kernel`, the
    project is `Acme.SharedKernel`, and both must say the same two words."""
    return [w.lower() for s in _SEGMENT.findall(text) for w in _WORD.findall(s)]


def _covers(label: str, project: str) -> int:
    """How specifically `label` names `project`: 0 when it does not.

    A box names a project when its words appear as a contiguous run of the
    project's name segments: `Domain` covers `Acme.Orders.Domain`,
    `Infrastructure` covers `Acme.Infrastructure.Persistence`. The score is the
    number of words matched, so the most specific box wins.
    """
    words = _segments(label)
    parts = _segments(project)
    if not words or len(words) > len(parts):
        return 0
    for start in range(len(parts) - len(words) + 1):
        if parts[start : start + len(words)] == words:
            return len(words)
    return 0


def assign_layers(diagram: DiagramModel, projects: list[str]) -> dict[str, str]:
    """project -> id of the box that names it most specifically."""
    assignment: dict[str, tuple[int, str]] = {}
    for node in diagram.nodes:
        if not node.label:
            continue
        for project in projects:
            score = _covers(node.label, project)
            if score and score > assignment.get(project, (0, ""))[0]:
                assignment[project] = (score, node.id)
    return {project: node_id for project, (_s, node_id) in assignment.items()}


def _closure(diagram: DiagramModel) -> dict[str, set[str]]:
    """node id -> every node id reachable along the arrows.

    A container's arrows apply to what it contains, and what it contains may go
    where the container goes: a `Infrastructure` swimlane pointing at
    `Application` allows every box inside it to depend on Application.
    """
    parents = {n.id: n.parent for n in diagram.nodes if n.parent}
    graph: dict[str, set[str]] = {n.id: set() for n in diagram.nodes}
    for edge in diagram.edges:
        graph.setdefault(edge.source, set()).add(edge.target)

    def ancestors(node_id: str) -> list[str]:
        chain, seen = [], set()
        while node_id in parents and node_id not in seen:
            seen.add(node_id)
            node_id = parents[node_id]
            chain.append(node_id)
        return chain

    reach: dict[str, set[str]] = {}
    for start in graph:
        frontier = [start, *ancestors(start)]
        visited: set[str] = set()
        while frontier:
            current = frontier.pop()
            if current in visited:
                continue
            visited.add(current)
            for target in graph.get(current, ()):
                frontier.append(target)
                # Reaching a container reaches what it contains.
                frontier.extend(c for c, p in parents.items() if p == target)
        reach[start] = visited
    return reach


# ---------------------------------------------------------------------------
# The check
# ---------------------------------------------------------------------------


def check_diagram(
    diagram: DiagramModel,
    diagram_path: str,
    projects: dict[str, str],
    references: list[tuple[str, str, str]],
) -> tuple[DiagramCheck, list[ConformanceFinding]]:
    layer_of = assign_layers(diagram, list(projects))
    labels = {n.id: n.label or n.id for n in diagram.nodes}
    layers: dict[str, list[str]] = {}
    for project, node_id in sorted(layer_of.items()):
        layers.setdefault(labels[node_id], []).append(project)

    check = DiagramCheck(diagram=diagram_path, layers=layers)
    if len(layers) < 2:
        check.status = "too-few-layers"
        return check, []

    reach = _closure(diagram)
    check.allowed = sorted(
        {
            (labels[e.source], labels[e.target])
            for e in diagram.edges
            if e.source in labels and e.target in labels
        }
    )

    conforming = 0
    candidates: list[ConformanceFinding] = []
    for source, target, csproj in references:
        a, b = layer_of.get(source), layer_of.get(target)
        if not a or not b or a == b:
            continue
        if b in reach.get(a, ()):
            conforming += 1
            continue
        kind = "inverted" if a in reach.get(b, ()) else "undrawn"
        candidates.append(
            ConformanceFinding(
                diagram=diagram_path,
                source_project=source,
                target_project=target,
                source_layer=labels[a],
                target_layer=labels[b],
                kind=kind,
                file=csproj,
            )
        )

    inverted = sum(1 for c in candidates if c.kind == "inverted")
    if conforming == 0 and inverted and inverted == len(candidates):
        # Every crossing contradicts the arrows and none agrees: the diagram
        # draws data flow, not dependencies. Saying so beats flagging the
        # whole solution.
        check.status = "ambiguous-direction"
        return check, []
    return check, candidates


def check_conformance(project_dir: Path) -> ConformanceReport:
    """Every repository diagram against the solution's references. Never raises."""
    report = ConformanceReport()
    try:
        diagrams = find_diagrams(project_dir)
        if not diagrams:
            report.skipped = "no-diagram"
            return report
        projects, references = read_module_references(project_dir)
        if len(projects) < 2:
            report.skipped = "no-projects"
            return report
        for path in diagrams:
            try:
                if path.stat().st_size > MAX_DIAGRAM_BYTES:
                    continue
                diagram = parse_diagram(path, path.read_bytes())
            except OSError:
                continue
            if diagram is None or any(
                e.source_end or e.target_end for e in diagram.edges
            ):
                # An ERD's boxes are tables, not layers: `erd.py` reads it.
                continue
            relative = path.relative_to(project_dir).as_posix()
            check, findings = check_diagram(diagram, relative, projects, references)
            report.checks.append(check)
            report.findings.extend(findings)
    except OSError:
        report.skipped = report.skipped or "unreadable"
    # Inverted first: that is the clean-architecture violation.
    report.findings.sort(key=lambda f: (f.kind != "inverted", f.source_project))
    return report


_SECTION_INTRO = (
    "The repository's architecture diagram(s) below were read as dependency "
    "rules (an arrow `A -> B` means *A may depend on B*, transitively) and "
    "compared with the module dependencies the build declares (`.csproj` "
    "project references, Maven / Gradle modules, workspace packages, crates). "
    "Do not add a reference the diagram does not allow; if the task needs one, "
    "say so and name the diagram rather than adding it silently."
)


def conformance_section(project_dir: Path) -> str:
    """The declared dependency rules, and where the code already breaks them."""
    report = check_conformance(Path(project_dir))
    checked = [c for c in report.checks if c.status == "checked"]
    if not checked:
        return ""

    lines = ["## Architecture diagram vs. module references", "", _SECTION_INTRO]
    for check in checked:
        lines.append("")
        lines.append(f"`{check.diagram}` — layers:")
        for layer, members in check.layers.items():
            shown = ", ".join(members[:6]) + (" …" if len(members) > 6 else "")
            lines.append(f"- {layer}: {shown}")
        if check.allowed:
            arrows = ", ".join(f"{a} -> {b}" for a, b in check.allowed[:20])
            lines.append(f"Allowed: {arrows}")

    findings = report.findings[:MAX_FINDINGS]
    if findings:
        lines.append("")
        lines.append(
            "Already in the code and contrary to the diagram (existing debt — "
            "do not add to it; a reviewer reports a *new* one as HIGH):"
        )
        for f in findings:
            verb = "points backwards" if f.kind == "inverted" else "is not drawn"
            lines.append(
                f"- `{f.source_project}` ({f.source_layer}) -> `{f.target_project}` "
                f"({f.target_layer}) {verb} — `{f.file}`"
            )
        if len(report.findings) > MAX_FINDINGS:
            lines.append(f"- … {len(report.findings) - MAX_FINDINGS} more")
    return "\n".join(lines)
