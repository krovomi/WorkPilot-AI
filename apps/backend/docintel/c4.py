"""C4 models written as code, read as the same boxes and arrows as a drawing.

Teams that take architecture seriously often stop drawing it: a Structurizr
workspace or a C4-PlantUML file is versioned, diffed and rendered, and says
`api -> domain "uses"` in so many words. That is exactly the claim
`conformance.py` compares with the code — so these files are parsed into the
same `DiagramModel` a draw.io file becomes, and feed the same rules.

| Format | Elements | Containers | Arrows |
|---|---|---|---|
| Structurizr DSL (`workspace.dsl`) | `x = person / softwareSystem / container / component "Label"` | nesting, `group "Layer" { … }` | `a -> b "…"`, `-> b` inside an element |
| C4-PlantUML | `Person`, `System`, `Container`, `Component` (+ `Db`, `Queue`, `_Ext`) | `*_Boundary(…) { … }` | `Rel`, `Rel_*`, `Rel_Back` (reversed), `BiRel` (both ways) |

A relationship in C4 reads "A uses B", which is a dependency of A on B — the
direction `conformance.py` already expects. Views, styles and themes say
nothing about the model and are skipped.
"""

from __future__ import annotations

import re

from .models import DiagramEdge, DiagramModel, DiagramNode

_DSL_ELEMENT = re.compile(
    r"^\s*(?:(?P<id>[\w.]+)\s*=\s*)?(?P<kind>person|softwareSystem|softwaresystem|container|component|group|element)"
    r"\s+\"(?P<label>[^\"]*)\"",
    re.I,
)
_DSL_RELATION = re.compile(
    r"^\s*(?P<a>[\w.]+)?\s*->\s*(?P<b>[\w.]+)(?:\s+\"(?P<label>[^\"]*)\")?"
)
_DSL_SKIPPED_BLOCK = re.compile(
    r"^\s*(?:views|styles|configuration|properties|perspectives)\b", re.I
)


def parse_structurizr(text: str, name: str = "") -> DiagramModel | None:
    """The model of a Structurizr DSL workspace, or None."""
    if "workspace" not in (text or "") or "model" not in text:
        return None
    diagram = DiagramModel(format="structurizr", name=name)
    stack: list[str | None] = []
    skipping = 0
    anonymous = 0
    relations: list[tuple[str, str, str]] = []
    for raw in text.splitlines():
        line = (
            raw.split("//", 1)[0].split("#", 1)[0]
            if not raw.lstrip().startswith("!")
            else ""
        )
        opens, closes = line.count("{"), line.count("}")
        if skipping:
            skipping += opens - closes
            continue
        if _DSL_SKIPPED_BLOCK.match(line) and opens:
            skipping = opens - closes
            continue
        pushed: str | None = None
        if element := _DSL_ELEMENT.match(line):
            node_id = element["id"]
            if not node_id:
                anonymous += 1
                node_id = f"_{element['kind'].lower()}{anonymous}"
            parent = next((s for s in reversed(stack) if s), "")
            diagram.nodes.append(
                DiagramNode(id=node_id, label=element["label"], parent=parent)
            )
            pushed = node_id
        elif relation := _DSL_RELATION.match(line):
            source = relation["a"] or next((s for s in reversed(stack) if s), "")
            if source:
                relations.append((source, relation["b"], relation["label"] or ""))
        for _ in range(opens):
            stack.append(pushed)
            pushed = None
        for _ in range(closes):
            if stack:
                stack.pop()
    if not diagram.nodes:
        return None
    ids = {n.id for n in diagram.nodes}
    by_tail = {n.id.rpartition(".")[2]: n.id for n in diagram.nodes}
    for a, b, label in relations:
        # `!identifiers hierarchical` writes `shop.api`; the element was declared `api`.
        a = a if a in ids else by_tail.get(a.rpartition(".")[2], "")
        b = b if b in ids else by_tail.get(b.rpartition(".")[2], "")
        if a and b:
            diagram.edges.append(DiagramEdge(source=a, target=b, label=label))
    return diagram


_C4_ELEMENT = re.compile(
    r"^\s*(?P<macro>Person|System|Container|Component|Deployment_Node|Node)(?:Db|Queue)?(?:_Ext)?\s*\(\s*"
    r"(?P<alias>\w+)\s*,\s*\"(?P<label>[^\"]*)\"",
    re.M,
)
_C4_BOUNDARY = re.compile(
    r"^\s*(?P<macro>\w*Boundary)\s*\(\s*(?P<alias>\w+)\s*,\s*\"(?P<label>[^\"]*)\"[^{\n]*\{",
)
_C4_REL = re.compile(
    r"^\s*(?P<macro>Bi)?Rel(?P<suffix>_\w+)?\s*\(\s*(?P<a>\w+)\s*,\s*(?P<b>\w+)(?:\s*,\s*\"(?P<label>[^\"]*)\")?"
)


def is_c4_plantuml(text: str) -> bool:
    return bool(text) and (
        "C4_" in text
        or "C4-PlantUML" in text
        or bool(re.search(r"^\s*(?:Bi)?Rel(?:_\w+)?\s*\(", text, re.M))
    )


def parse_c4_plantuml(text: str, name: str = "") -> DiagramModel | None:
    """The elements, boundaries and relations of a C4-PlantUML file, or None."""
    if not is_c4_plantuml(text):
        return None
    diagram = DiagramModel(format="c4-plantuml", name=name)
    stack: list[str | None] = []
    for line in text.splitlines():
        if line.lstrip().startswith("'"):
            continue
        parent = next((s for s in reversed(stack) if s), "")
        pushed: str | None = None
        if boundary := _C4_BOUNDARY.match(line):
            diagram.nodes.append(
                DiagramNode(
                    id=boundary["alias"], label=boundary["label"], parent=parent
                )
            )
            pushed = boundary["alias"]
        elif element := _C4_ELEMENT.match(line):
            diagram.nodes.append(
                DiagramNode(id=element["alias"], label=element["label"], parent=parent)
            )
        elif rel := _C4_REL.match(line):
            a, b, label = rel["a"], rel["b"], rel["label"] or ""
            if (rel["suffix"] or "").lower().startswith("_back"):
                a, b = b, a
            diagram.edges.append(DiagramEdge(source=a, target=b, label=label))
            if rel["macro"]:
                diagram.edges.append(DiagramEdge(source=b, target=a, label=label))
        for _ in range(line.count("{")):
            stack.append(pushed)
            pushed = None
        for _ in range(line.count("}")):
            if stack:
                stack.pop()
    ids = {n.id for n in diagram.nodes}
    diagram.edges = [e for e in diagram.edges if e.source in ids and e.target in ids]
    return diagram if diagram.nodes else None
