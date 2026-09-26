"""Does the ORM map the data model the ERD draws?

An entity-relationship diagram is a claim about tables and cardinalities, and
the code drifts from it one entity at a time: a table the diagram promises that
nobody mapped, a relation drawn one-to-many and configured one-to-one, a
navigation property added with no line on the diagram. Like the architecture
diagram in `conformance.py`, it is drawn once and nobody re-reads it while
editing a mapping.

| Side | Read from |
|---|---|
| the diagram | draw.io / Excalidraw (tables = boxes, rows = columns, crow's feet or a `1:N` label = cardinality), DBML (dbdiagram.io), Mermaid `erDiagram` — the repository's `docs/` and the task's attachments; OCR text only when it *is* one of those sources |
| the code | `orm.py`: EF Core, SQLAlchemy, Django, TypeORM, Prisma, JPA, ActiveRecord, Doctrine, Eloquent, GORM — read, never compiled |

**Structured first.** A `.dbml` or a Mermaid block says `>` or `}o--||`; a
draw.io ERD says `ERmany`. OCR text is parsed only as one of those formats (a
screenshot of dbdiagram.io's editor), never as "boxes the OCR happened to see".

**An ambiguity is said, not scored.** An arrow with no crow's foot and no
label draws a relation and no cardinality; a crow's foot at one end only is
half an answer; a `1:N` label read against an arrow the code has the other way
round may simply be drawn backwards. Each is listed as ambiguous and produces
no finding — the same rule as `ambiguous-direction` in `conformance.py`.

**A task's ERD is the target, the repository's is the record.** Differences
with an attached ERD are most likely the work the task asks for; differences
with `docs/` are existing drift. The prompt says which is which.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .conformance import DIAGRAM_DIRS, DIAGRAM_SUFFIXES, MAX_DIAGRAM_BYTES, _walk
from .diagrams import parse_diagram
from .models import DiagramModel
from .orm import OrmModel, _norm, canonical, read_orm

MAX_ERDS = 10
MAX_FINDINGS = 30
ERD_TEXT_SUFFIXES = (".dbml", ".mmd", ".mermaid", ".md")

#: A diagram file named like this is read as an ERD even without crow's feet.
_ERD_NAME = re.compile(
    r"(?:^|[^a-z])(?:erd|er[-_ ]?diagram|entit(?:y|ies)|schema|database|db|"
    r"data[-_ ]?model|mcd|mld|mpd|tables?)(?:[^a-z]|$)",
    re.IGNORECASE,
)


@dataclass
class ErdTable:
    name: str
    columns: list[str] = field(default_factory=list)


@dataclass
class ErdRelation:
    a: str
    b: str
    #: ``1:N`` (``a`` one, ``b`` many), ``1:1``, ``N:N``, or "" when undrawn.
    kind: str = ""
    #: How the cardinality was read: ``markers`` (crow's feet, DBML operator,
    #: Mermaid), ``label`` (a `1:N` written on the arrow), or "".
    evidence: str = ""
    #: Why the cardinality cannot be judged: ``not-drawn``, ``one-end-only``.
    ambiguous: str = ""


@dataclass
class Erd:
    source: str
    format: str
    tables: list[ErdTable] = field(default_factory=list)
    relations: list[ErdRelation] = field(default_factory=list)


@dataclass
class ErdFinding:
    erd: str
    #: ``missing-entity`` (drawn, not mapped), ``undrawn-entity`` (mapped, not
    #: drawn), ``missing-relation``, ``undrawn-relation``, ``cardinality-mismatch``.
    kind: str
    subject: str
    drawn: str = ""
    code: str = ""
    file: str = ""
    line: int = 0


@dataclass
class ErdCheck:
    erd: str
    format: str
    #: ``attachment`` (the task's target) or ``repository`` (documentation).
    origin: str
    #: ``checked``, ``no-match`` (no table names an entity).
    status: str = "checked"
    matched: dict[str, str] = field(default_factory=dict)
    ambiguous: list[str] = field(default_factory=list)


@dataclass
class ErdReport:
    checks: list[ErdCheck] = field(default_factory=list)
    findings: list[ErdFinding] = field(default_factory=list)
    frameworks: list[str] = field(default_factory=list)
    #: ``no-erd``, ``no-orm`` when nothing was compared.
    skipped: str = ""

    def to_dict(self) -> dict:
        return {
            "checks": [asdict(c) for c in self.checks],
            "findings": [asdict(f) for f in self.findings],
            "frameworks": self.frameworks,
            "skipped": self.skipped,
        }


# ---------------------------------------------------------------------------
# Cardinality
# ---------------------------------------------------------------------------

_MANY = {"n", "m", "*", "0..*", "1..*", "0..n", "1..n", "many"}
_LABEL = re.compile(
    r"(?<![\w.])(?P<l>0\.\.1|1\.\.1|0\.\.\*|1\.\.\*|0\.\.n|1\.\.n|1|n|m|\*|one|many)\s*"
    r"(?:[:\-–/]|\bto\b)\s*"
    r"(?P<r>0\.\.1|1\.\.1|0\.\.\*|1\.\.\*|0\.\.n|1\.\.n|1|n|m|\*|one|many)(?![\w.])",
    re.IGNORECASE,
)


def _kind_from_ends(a: str, b: str, left: str, right: str) -> tuple[str, str, str]:
    if left == "one" and right == "many":
        return "1:N", a, b
    if left == "many" and right == "one":
        return "1:N", b, a
    if left == right == "one":
        return canonical("1:1", a, b)
    return canonical("N:N", a, b)


def _relation(a: str, b: str, left: str, right: str, label: str) -> ErdRelation:
    if left and right:
        kind, x, y = _kind_from_ends(a, b, left, right)
        return ErdRelation(x, y, kind, "markers")
    if match := _LABEL.search(label or ""):
        sides = [
            "many" if s.lower() in _MANY else "one" for s in (match["l"], match["r"])
        ]
        kind, x, y = _kind_from_ends(a, b, *sides)
        return ErdRelation(x, y, kind, "label")
    x, y = sorted((a, b))
    return ErdRelation(x, y, "", "", "one-end-only" if (left or right) else "not-drawn")


# ---------------------------------------------------------------------------
# The diagram side
# ---------------------------------------------------------------------------


def _table_name(label: str) -> str:
    """`Orders`, `orders (table)`, `dbo.Orders PK id` -> the first identifier."""
    match = re.search(r"[A-Za-z_][\w.]*", label or "")
    return match.group(0).rpartition(".")[2] if match else ""


def erd_from_diagram(model: DiagramModel, source: str) -> Erd | None:
    """The tables and relations of a draw.io / Excalidraw ERD, or None.

    A diagram is an ERD when an arrow carries an entity-relation marker, or
    when its name says so and its boxes hold rows. An architecture diagram is
    neither, and reading its layers as tables would compare nonsense.
    """
    has_markers = any(e.source_end or e.target_end for e in model.edges)
    children: dict[str, list[str]] = {}
    for node in model.nodes:
        if node.parent:
            children.setdefault(node.parent, []).append(node.label)
    named = bool(_ERD_NAME.search(Path(source).stem))
    if not has_markers and not (named and (children or model.edges)):
        return None

    parents = {n.id: n.parent for n in model.nodes}

    def top(node_id: str) -> str:
        seen: set[str] = set()
        while parents.get(node_id) and node_id not in seen:
            seen.add(node_id)
            node_id = parents[node_id]
        return node_id

    tops = [n for n in model.nodes if not n.parent]
    tables: dict[str, ErdTable] = {}
    for node in tops:
        name = _table_name(node.label)
        if name:
            tables[node.id] = ErdTable(
                name, [c for c in children.get(node.id, []) if c][:60]
            )
    if not tables:
        return None
    erd = Erd(source=source, format=model.format, tables=list(tables.values()))
    for edge in model.edges:
        a, b = tables.get(top(edge.source)), tables.get(top(edge.target))
        if a is None or b is None or a is b:
            continue
        erd.relations.append(
            _relation(a.name, b.name, edge.source_end, edge.target_end, edge.label)
        )
    return erd


_DBML_TABLE = re.compile(
    r"^\s*Table\s+(?:\"?[\w]+\"?\.)?\"?(?P<name>\w+)\"?(?:\s+as\s+\w+)?\s*(?:\[[^\]]*\])?\s*\{(?P<body>[^}]*)\}",
    re.M | re.I,
)
_DBML_COLUMN = re.compile(
    r"^\s*\"?(?P<col>\w+)\"?\s+(?P<type>[\w()\[\],.\"]+)(?P<rest>.*)$", re.M
)
_DBML_INLINE = re.compile(r"\bref\s*:\s*(?P<op><>|[<>-])\s*(?P<target>[\w.\"]+)", re.I)
_DBML_REF = re.compile(
    r"(?P<l>\"?\w+\"?(?:\.\"?\w+\"?){1,2})\s*(?P<op><>|[<>-])\s*(?P<r>\"?\w+\"?(?:\.\"?\w+\"?){1,2})"
)
_DBML_REF_LINE = re.compile(r"^\s*Ref\b[^:{\n]*[:{](?P<rest>[^}\n]*)", re.M | re.I)
_DBML_REF_BLOCK = re.compile(r"^\s*Ref\b[^{\n]*\{(?P<body>[^}]*)\}", re.M | re.I)


def _dbml_table(ref: str) -> str:
    """`schema.table.column` / `table.column` -> `table`."""
    parts = [p.strip('"') for p in ref.split(".")]
    return parts[-2] if len(parts) >= 2 else parts[0]


def _dbml_relation(left: str, op: str, right: str) -> ErdRelation:
    ends = {
        ">": ("many", "one"),
        "<": ("one", "many"),
        "-": ("one", "one"),
        "<>": ("many", "many"),
    }
    l_end, r_end = ends[op]
    kind, a, b = _kind_from_ends(left, right, l_end, r_end)
    return ErdRelation(a, b, kind, "markers")


def parse_dbml(text: str, source: str) -> Erd | None:
    tables = list(_DBML_TABLE.finditer(text or ""))
    if not tables:
        return None
    erd = Erd(source=source, format="dbml")
    for table in tables:
        name = table.group("name")
        columns = []
        for column in _DBML_COLUMN.finditer(table.group("body")):
            if column.group("col").lower() in ("note", "indexes"):
                continue
            columns.append(column.group("col"))
            if inline := _DBML_INLINE.search(column.group("rest")):
                erd.relations.append(
                    _dbml_relation(name, inline["op"], _dbml_table(inline["target"]))
                )
        erd.tables.append(ErdTable(name, columns))
    refs: list[str] = [m["rest"] for m in _DBML_REF_LINE.finditer(text)]
    refs += [m["body"] for m in _DBML_REF_BLOCK.finditer(text)]
    for chunk in refs:
        for ref in _DBML_REF.finditer(chunk):
            erd.relations.append(
                _dbml_relation(_dbml_table(ref["l"]), ref["op"], _dbml_table(ref["r"]))
            )
    return erd


_MERMAID_BLOCK = re.compile(r"```mermaid\s*\n(?P<body>.*?)```", re.S)
_MERMAID_REL = re.compile(
    r"^\s*\"?(?P<a>[\w-]+)\"?\s+(?P<l>\|\||\|o|o\||\}o|\}\||o\{|\|\{)(?:--|\.\.)"
    r"(?P<r>\|\||o\||\|o|o\{|\|\{|\}o|\}\|)\s+\"?(?P<b>[\w-]+)\"?",
    re.M,
)
_MERMAID_ENTITY = re.compile(
    r"^\s*\"?(?P<name>[\w-]+)\"?\s*(?:\[[^\]]*\])?\s*\{(?P<body>[^}]*)\}", re.M
)


def parse_mermaid_er(text: str, source: str) -> Erd | None:
    """Every `erDiagram` in `text`: a `.mmd` file or the fenced blocks of Markdown."""
    blocks = [m["body"] for m in _MERMAID_BLOCK.finditer(text or "")] or [text or ""]
    erd = Erd(source=source, format="mermaid")
    names: dict[str, ErdTable] = {}
    for block in blocks:
        if "erDiagram" not in block:
            continue
        body = block.split("erDiagram", 1)[1]
        for entity in _MERMAID_ENTITY.finditer(body):
            columns = [
                parts[1]
                for line in entity["body"].splitlines()
                if len(parts := line.split()) >= 2
            ]
            names.setdefault(entity["name"], ErdTable(entity["name"], columns))
        for rel in _MERMAID_REL.finditer(body):
            left = "many" if "}" in rel["l"] else "one"
            right = "many" if "{" in rel["r"] else "one"
            for name in (rel["a"], rel["b"]):
                names.setdefault(name, ErdTable(name))
            kind, a, b = _kind_from_ends(rel["a"], rel["b"], left, right)
            erd.relations.append(ErdRelation(a, b, kind, "markers"))
    erd.tables = list(names.values())
    return erd if erd.tables else None


def parse_erd_text(text: str, source: str) -> Erd | None:
    """DBML or Mermaid, whichever `text` is."""
    return parse_dbml(text, source) or parse_mermaid_er(text, source)


def find_erds(project_dir: Path) -> list[Erd]:
    """The ERDs the repository keeps in its documentation directories."""
    found: list[Erd] = []
    seen: set[Path] = set()
    for relative in DIAGRAM_DIRS:
        base = project_dir / relative
        if not base.is_dir() or (relative != "." and base.is_symlink()):
            continue
        for path in _walk(base, 0 if relative == "." else 6):
            name = path.name.lower()
            if path in seen or not name.endswith(
                (*DIAGRAM_SUFFIXES, *ERD_TEXT_SUFFIXES)
            ):
                continue
            seen.add(path)
            try:
                if path.stat().st_size > MAX_DIAGRAM_BYTES:
                    continue
                data = path.read_bytes()
            except OSError:
                continue
            source = path.relative_to(project_dir).as_posix()
            erd: Erd | None
            if name.endswith(ERD_TEXT_SUFFIXES):
                erd = parse_erd_text(data.decode("utf-8", errors="replace"), source)
            else:
                model = parse_diagram(path, data)
                erd = erd_from_diagram(model, source) if model else None
            if erd is not None:
                found.append(erd)
                if len(found) >= MAX_ERDS:
                    return found
    return found


def erds_from_attachments(spec_dir: Path) -> list[Erd]:
    """ERDs among the task's attachments, as the preflight read them."""
    from .preflight import full_text, load_result

    result = load_result(Path(spec_dir))
    if result is None:
        return []
    found: list[Erd] = []
    for doc in result.documents:
        if doc.threat != "safe" or doc.status == "withheld":
            continue
        if doc.diagram is not None:
            if erd := erd_from_diagram(doc.diagram, doc.path):
                found.append(erd)
            continue
        text = full_text(doc, Path(spec_dir))
        if text and (erd := parse_erd_text(text, doc.path)):
            if doc.engine not in ("", "text"):
                erd.format += f" ({doc.engine})"
            found.append(erd)
    return found[:MAX_ERDS]


# ---------------------------------------------------------------------------
# The comparison
# ---------------------------------------------------------------------------


def _entity_keys(orm: OrmModel) -> dict[str, str]:
    keys: dict[str, str] = {}
    for entity in orm.entities.values():
        for name in (entity.name, entity.table, *entity.aliases):
            if name:
                keys.setdefault(_norm(name), entity.name)
    return keys


def _show(kind: str, a: str, b: str) -> str:
    return f"{a} {kind} {b}" if kind else f"{a} — {b}"


def compare(erd: Erd, orm: OrmModel, origin: str) -> tuple[ErdCheck, list[ErdFinding]]:
    check = ErdCheck(erd=erd.source, format=erd.format, origin=origin)
    keys = _entity_keys(orm)
    for table in erd.tables:
        if entity := keys.get(_norm(table.name)):
            check.matched[table.name] = entity
    if not check.matched:
        check.status = "no-match"
        return check, []

    findings: list[ErdFinding] = []
    for table in erd.tables:
        if table.name not in check.matched:
            findings.append(ErdFinding(erd.source, "missing-entity", table.name))
    drawn_entities = set(check.matched.values())
    if len(drawn_entities) >= 2:
        for entity in orm.entities.values():
            if entity.name not in drawn_entities and not _is_join_entity(
                entity.name, orm
            ):
                findings.append(
                    ErdFinding(
                        erd.source,
                        "undrawn-entity",
                        entity.name,
                        file=entity.file,
                        line=entity.line,
                    )
                )

    drawn_pairs: set[frozenset[str]] = set()
    for rel in erd.relations:
        x, y = check.matched.get(rel.a), check.matched.get(rel.b)
        if not x or not y:
            continue
        drawn_pairs.add(frozenset((x, y)))
        code = orm.relation_between(x, y)
        subject = _show("", rel.a, rel.b)
        if not code:
            findings.append(
                ErdFinding(
                    erd.source,
                    "missing-relation",
                    subject,
                    _show(rel.kind, rel.a, rel.b),
                )
            )
            continue
        if not rel.kind:
            check.ambiguous.append(
                f"{subject}: cardinality {rel.ambiguous.replace('-', ' ')}"
            )
            continue
        wanted = canonical(rel.kind, x, y)
        actual = [(r.kind, r.a, r.b) for r in code]
        if wanted in actual:
            continue
        reversed_ = canonical(rel.kind, y, x)
        if rel.evidence == "label" and reversed_ in actual:
            # A `1:N` written on an arrow the code has the other way round may
            # just be an arrow drawn backwards: said, not reported.
            check.ambiguous.append(
                f"{subject}: direction unclear ({rel.kind} on the arrow)"
            )
            continue
        first = code[0]
        findings.append(
            ErdFinding(
                erd.source,
                "cardinality-mismatch",
                subject,
                drawn=_show(rel.kind, rel.a, rel.b),
                code=_show(first.kind, first.a, first.b),
                file=first.file,
                line=first.line,
            )
        )
    for rel in orm.relations:
        if rel.a in drawn_entities and rel.b in drawn_entities:
            if frozenset((rel.a, rel.b)) not in drawn_pairs:
                findings.append(
                    ErdFinding(
                        erd.source,
                        "undrawn-relation",
                        _show("", rel.a, rel.b),
                        code=_show(rel.kind, rel.a, rel.b),
                        file=rel.file,
                        line=rel.line,
                    )
                )
    return check, findings


def _is_join_entity(name: str, orm: OrmModel) -> bool:
    """`OrderTag` between `Order` and `Tag`: an ERD draws the N:N, not the table."""
    many_sides = {r.a for r in orm.relations if r.kind == "1:N" and r.b == name}
    return len(many_sides) >= 2


_ORDER = {
    "missing-entity": 0,
    "missing-relation": 1,
    "cardinality-mismatch": 2,
    "undrawn-relation": 3,
    "undrawn-entity": 4,
}


def check_erd(project_dir: Path, spec_dir: Path | None = None) -> ErdReport:
    """Every ERD — attached to the task, then in the repository — against the ORM."""
    report = ErdReport()
    try:
        attached = erds_from_attachments(spec_dir) if spec_dir is not None else []
        documented = find_erds(Path(project_dir))
        if not attached and not documented:
            report.skipped = "no-erd"
            return report
        orm = read_orm(Path(project_dir))
        report.frameworks = orm.frameworks
        if not orm.entities:
            report.skipped = "no-orm"
            return report
        for origin, erds in (("attachment", attached), ("repository", documented)):
            for erd in erds:
                check, findings = compare(erd, orm, origin)
                report.checks.append(check)
                report.findings.extend(findings)
    except OSError:
        report.skipped = report.skipped or "unreadable"
    report.findings.sort(key=lambda f: (_ORDER.get(f.kind, 9), f.erd, f.subject))
    return report


_INTRO = {
    "attachment": (
        "The task attaches this ERD: it is the **target** data model. The "
        "differences below are most likely what the task asks you to change — "
        "map them, with a migration if the project uses migrations."
    ),
    "repository": (
        "The repository documents its data model in this ERD. The differences "
        "below already exist: do not widen them, and if the task changes the "
        "model, say whether the diagram must follow."
    ),
}
_WHAT = {
    "missing-entity": "drawn, not mapped by any entity",
    "undrawn-entity": "mapped, not drawn",
    "missing-relation": "drawn, no mapping relates them",
    "undrawn-relation": "mapped, not drawn",
    "cardinality-mismatch": "cardinality differs",
}


def erd_section(project_dir: Path, spec_dir: Path | None = None) -> str:
    """The ERD's claims next to the ORM's, for the planner, the coder and QA."""
    report = check_erd(Path(project_dir), spec_dir)
    checked = [c for c in report.checks if c.status == "checked"]
    if not checked:
        return ""
    lines = [
        "## Data model: ERD vs. ORM mapping",
        "",
        (
            f"ORM read from the code ({', '.join(report.frameworks)}), without compiling. "
            "Cardinality is written `A 1:N B` (one A, many B). A reviewer reports a *new* "
            "difference with a repository ERD as MEDIUM, and one left with the task's ERD as HIGH."
        ),
    ]
    for check in checked:
        lines += ["", f"`{check.erd}` ({check.format}) — {_INTRO[check.origin]}"]
        pairs = ", ".join(f"{t} = {e}" for t, e in list(check.matched.items())[:15])
        lines.append(f"Tables mapped: {pairs}")
        mine = [f for f in report.findings if f.erd == check.erd][:MAX_FINDINGS]
        for f in mine:
            where = (
                f" — `{f.file}:{f.line}`"
                if f.file and f.line
                else (f" — `{f.file}`" if f.file else "")
            )
            detail = ""
            if f.kind == "cardinality-mismatch":
                detail = f": drawn `{f.drawn}`, mapped `{f.code}`"
            elif f.code:
                detail = f": `{f.code}`"
            elif f.drawn and f.drawn != f.subject:
                detail = f": `{f.drawn}`"
            lines.append(f"- {f.subject} — {_WHAT[f.kind]}{detail}{where}")
        if check.ambiguous:
            lines.append(
                "Not judged (the diagram does not say): "
                + "; ".join(check.ambiguous[:10])
            )
    return "\n".join(lines)
