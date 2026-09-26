"""The data model the code declares, read from the source without compiling it.

An ERD is compared with *something*: the entities the ORM maps and the
relations between them. That model is declared in the code of every backend
WorkPilot builds, each in its own idiom, and each idiom is regular enough to be
read without running a compiler, an interpreter or a database.

| Stack | Entities | Relations |
|---|---|---|
| EF Core (C#) | `DbSet<T>`, `Entity<T>()`, `IEntityTypeConfiguration<T>`, `[Table]` / `ToTable` | `HasOne`/`HasMany` + `WithOne`/`WithMany`, then navigation properties by convention |
| SQLAlchemy, SQLModel | `__tablename__`, `table=True` | `relationship(...)`, `Mapped[list[...]]`, `ForeignKey("t.id")`, `uselist=False`, `secondary=` |
| Django | `models.Model` subclasses, `db_table` | `ForeignKey`, `OneToOneField`, `ManyToManyField` |
| TypeORM, MikroORM | `@Entity(...)` | `@ManyToOne`, `@OneToMany`, `@OneToOne`, `@ManyToMany` |
| Prisma | `model X { … }`, `@@map` | fields typed by another model, `X[]` |
| JPA / Hibernate (Java, Kotlin) | `@Entity`, `@Table(name=…)` | `@ManyToOne`, `@OneToMany`, `@OneToOne`, `@ManyToMany` |
| ActiveRecord | `< ApplicationRecord`, `table_name` | `belongs_to`, `has_many`, `has_one`, `has_and_belongs_to_many` |
| Doctrine, Eloquent (PHP) | `#[ORM\\Entity]`, `extends Model`, `$table` | `ManyToOne`… / `belongsTo`, `hasMany`, `hasOne`, `belongsToMany` |
| GORM (Go) | structs embedding `gorm.Model` or tagged `gorm:` | fields typed by another entity, `[]Entity` |

**Explicit first, convention second.** An EF Core `HasOne(...).WithMany(...)` or
a JPA `@OneToMany` says what the relation is; a navigation property says what
the ORM will *infer*. Inference is only asked for a pair the explicit
declarations left unsaid, and follows the ORMs' own rule: a collection one way
and a reference (or nothing) the other is one-to-many, collections both ways
many-to-many, references both ways one-to-one.

A relation is canonical: ``one`` / ``many`` for 1:N, and the pair in name
order for 1:1 and N:N, so an ERD drawn either way round compares.
"""

from __future__ import annotations

import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

SKIP_DIRS = {
    ".git",
    ".workpilot",
    "node_modules",
    "bin",
    "obj",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    "dist",
    "build",
    "out",
    "target",
    "vendor",
    "packages",
    "migrations",
    "Migrations",
    "TestResults",
    "coverage",
}
SOURCE_SUFFIXES = (
    ".cs",
    ".py",
    ".ts",
    ".java",
    ".kt",
    ".rb",
    ".php",
    ".go",
    ".prisma",
)
MAX_FILES = 6000
MAX_FILE_BYTES = 512 * 1024
MAX_DEPTH = 12


@dataclass
class Entity:
    name: str
    #: The table it maps to when the code says so (`[Table]`, `__tablename__`…).
    table: str = ""
    file: str = ""
    line: int = 0
    #: Other names the table goes by (`DbSet<Order> Orders` is table `Orders`).
    aliases: list[str] = field(default_factory=list)


@dataclass
class OrmRelation:
    #: ``1:N`` (``a`` is the one side, ``b`` the many), ``1:1`` or ``N:N``.
    kind: str
    a: str
    b: str
    file: str = ""
    line: int = 0
    #: ``explicit`` (a mapping says so) or ``convention`` (navigation properties).
    source: str = "explicit"


@dataclass
class OrmModel:
    entities: dict[str, Entity] = field(default_factory=dict)
    relations: list[OrmRelation] = field(default_factory=list)
    frameworks: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "entities": [asdict(e) for e in self.entities.values()],
            "relations": [asdict(r) for r in self.relations],
            "frameworks": self.frameworks,
        }

    def relation_between(self, x: str, y: str) -> list[OrmRelation]:
        return [r for r in self.relations if {r.a, r.b} == {x, y}]


def canonical(kind: str, a: str, b: str) -> tuple[str, str, str]:
    """(kind, a, b) with `N:1` turned round and symmetric pairs sorted."""
    if kind == "N:1":
        return "1:N", b, a
    if kind in ("1:1", "N:N") and b < a:
        return kind, b, a
    return kind, a, b


# ---------------------------------------------------------------------------
# Walking the sources
# ---------------------------------------------------------------------------


def _sources(root: Path):
    root_depth = len(root.parts)
    count = 0
    for current, dirs, files in os.walk(root):
        base = Path(current)
        if len(base.parts) - root_depth >= MAX_DEPTH:
            dirs[:] = []
        dirs[:] = sorted(
            d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")
        )
        for name in sorted(files):
            if not name.endswith(SOURCE_SUFFIXES):
                continue
            path = base / name
            if path.is_symlink():
                continue
            try:
                if path.stat().st_size > MAX_FILE_BYTES:
                    continue
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            yield path.relative_to(root).as_posix(), text
            count += 1
            if count >= MAX_FILES:
                return


def _line_at(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


_COLLECTION = re.compile(
    r"^(?:I?Collection|I?List|IEnumerable|IReadOnlyCollection|IReadOnlyList|HashSet|ISet|Set|"
    r"MutableList|MutableSet|Array|Mapped\[list|list|List|Sequence|Iterable)\s*[<\[]\s*"
    r"['\"]?(?P<inner>[\w.]+)['\"]?\s*[>\]]"
)


def _element(type_text: str) -> tuple[str, bool]:
    """(element type, is a collection) for `ICollection<Order>`, `Order[]`, `list["Order"]`."""
    t = type_text.strip().rstrip("?").strip()
    t = re.sub(r"^(?:Mapped|Optional)\[(.*)\]$", r"\1", t).strip()
    if m := _COLLECTION.match(t):
        return m.group("inner").rpartition(".")[2], True
    if t.endswith("[]"):
        return t[:-2].strip().rpartition(".")[2], True
    if t.startswith("[]"):
        return t[2:].lstrip("*").rpartition(".")[2], True
    return t.strip("'\"*").rpartition(".")[2].rstrip("?"), False


class _Builder:
    """Collects declarations; resolves conventions once every file is read."""

    def __init__(self) -> None:
        self.model = OrmModel()
        self.explicit: list[OrmRelation] = []
        #: (owner, target, is_collection, file, line) — navigation properties.
        self.navigations: list[tuple[str, str, bool, str, int]] = []
        self.fk_tables: list[tuple[str, str, str, int]] = []

    def entity(self, name: str, file: str, line: int, table: str = "") -> Entity:
        entity = self.model.entities.get(name)
        if entity is None:
            entity = Entity(name=name, file=file, line=line)
            self.model.entities[name] = entity
        if table and not entity.table:
            entity.table = table
        return entity

    def framework(self, name: str) -> None:
        if name not in self.model.frameworks:
            self.model.frameworks.append(name)

    def relate(self, kind: str, a: str, b: str, file: str, line: int) -> None:
        kind, a, b = canonical(kind, a, b)
        self.explicit.append(OrmRelation(kind, a, b, file, line, "explicit"))

    def build(self) -> OrmModel:
        entities = self.model.entities
        relations: dict[tuple[str, str, str], OrmRelation] = {}
        for rel in self.explicit:
            if rel.a in entities and rel.b in entities:
                relations.setdefault((rel.kind, rel.a, rel.b), rel)
        # A foreign key naming a table ("customers.id") is a many-to-one.
        by_table = {}
        for entity in entities.values():
            for key in (entity.table, *entity.aliases):
                if key:
                    by_table[key.lower()] = entity.name
        for owner, table, file, line in self.fk_tables:
            target = by_table.get(table.lower()) or next(
                (n for n in entities if _norm(n) == _norm(table)), ""
            )
            if target and owner in entities and target != owner:
                kind, a, b = canonical("1:N", target, owner)
                if not any({r.a, r.b} == {a, b} for r in relations.values()):
                    relations[(kind, a, b)] = OrmRelation(kind, a, b, file, line)

        covered = {frozenset((r.a, r.b)) for r in relations.values()}
        refs: dict[tuple[str, str], tuple[bool, str, int]] = {}
        for owner, target, many, file, line in self.navigations:
            if owner in entities and target in entities and owner != target:
                previous = refs.get((owner, target))
                refs[(owner, target)] = (
                    many or bool(previous and previous[0]),
                    file,
                    line,
                )
        for (owner, target), (many, file, line) in sorted(refs.items()):
            pair = frozenset((owner, target))
            if pair in covered:
                continue
            covered.add(pair)
            back = refs.get((target, owner))
            if many and back and back[0]:
                kind, a, b = canonical("N:N", owner, target)
            elif many:
                kind, a, b = "1:N", owner, target
            elif back and back[0]:
                kind, a, b = "1:N", target, owner
            elif back:
                kind, a, b = canonical("1:1", owner, target)
            else:
                # A lone reference is a foreign key on the owner's side.
                kind, a, b = "1:N", target, owner
            relations[(kind, a, b)] = OrmRelation(kind, a, b, file, line, "convention")
        self.model.relations = sorted(
            relations.values(), key=lambda r: (r.a, r.b, r.kind)
        )
        return self.model


# ---------------------------------------------------------------------------
# One reader per idiom
# ---------------------------------------------------------------------------

_CLASS = re.compile(
    r"\b(?:class|record|struct)\s+(?P<name>[A-Z]\w*)(?:\s*<[^>{]*>)?(?P<rest>[^{;]*)[{;]?"
)


def _class_spans(text: str) -> list[tuple[str, int, int, str]]:
    """(name, start, end, header) of each class, a class ending where the next begins."""
    matches = list(_CLASS.finditer(text))
    spans = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        spans.append((match.group("name"), match.start(), end, match.group("rest")))
    return spans


# --- EF Core ----------------------------------------------------------------

_DBSET = re.compile(r"\bDbSet\s*<\s*(?P<type>[\w.]+)\s*>\s+(?P<name>\w+)")
_EF_ENTITY = re.compile(
    r"(?:\bEntity\s*<\s*(?P<a>[\w.]+)\s*>|IEntityTypeConfiguration\s*<\s*(?P<b>[\w.]+)\s*>)"
)
_EF_TABLE_ATTR = re.compile(
    r"\[Table\(\s*\"(?P<table>[^\"]+)\"[^\]]*\]\s*(?:\[[^\]]*\]\s*)*"
    r"(?:public\s+|internal\s+|sealed\s+|partial\s+|abstract\s+)*(?:class|record)\s+(?P<name>\w+)"
)
_EF_TO_TABLE = re.compile(r"\bToTable\(\s*\"(?P<table>[^\"]+)\"")
_EF_CHAIN = re.compile(
    r"\.(?P<first>HasOne|HasMany)\s*(?:<\s*(?P<ftype>[\w.]+)\s*>)?\s*\(\s*(?:\w+\s*=>\s*\w+\.(?P<fnav>\w+))?\s*\)"
    r"(?:\s*\.\s*(?P<second>WithOne|WithMany)\s*\(\s*(?:\w+\s*=>\s*\w+\.(?P<snav>\w+))?\s*\))?",
    re.S,
)
_CS_PROPERTY = re.compile(
    r"\bpublic\s+(?:virtual\s+|required\s+|override\s+)*(?P<type>[\w.<>\[\]?, ]+?)\s+(?P<name>\w+)\s*\{\s*(?:get|init)"
)


def _owner_at(anchors: list[tuple[int, str]], offset: int) -> str:
    """The entity a fluent chain configures: the nearest anchor above it."""
    owner = ""
    for position, name in anchors:
        if position <= offset:
            owner = name
    return owner


def _read_efcore(files: list[tuple[str, str]], builder: _Builder) -> None:
    cs = [(p, t) for p, t in files if p.endswith(".cs")]
    if not any("DbContext" in t or "IEntityTypeConfiguration" in t for _p, t in cs):
        return
    names: set[str] = set()
    for path, text in cs:
        for m in _DBSET.finditer(text):
            name = m.group("type").rpartition(".")[2]
            names.add(name)
            entity = builder.entity(name, path, _line_at(text, m.start()))
            if m.group("name") not in entity.aliases:
                entity.aliases.append(m.group("name"))
        for m in _EF_ENTITY.finditer(text):
            names.add((m.group("a") or m.group("b")).rpartition(".")[2])
    if not names:
        return
    builder.framework("efcore")

    properties: dict[str, dict[str, str]] = {}
    for path, text in cs:
        for name, start, end, _header in _class_spans(text):
            if name not in names:
                continue
            entity = builder.entity(name, path, _line_at(text, start))
            # Where the class is declared, not the `DbSet` that named it.
            entity.file, entity.line = path, _line_at(text, start)
            body = text[start:end]
            props = properties.setdefault(name, {})
            for p in _CS_PROPERTY.finditer(body):
                props[p.group("name")] = p.group("type")
        for m in _EF_TABLE_ATTR.finditer(text):
            if m.group("name") in names:
                builder.entity(
                    m.group("name"), path, _line_at(text, m.start()), m.group("table")
                )

    for path, text in cs:
        # The entity a fluent chain configures: the nearest `Entity<T>` or
        # `IEntityTypeConfiguration<T>` above it.
        anchors = [
            (m.start(), (m.group("a") or m.group("b")).rpartition(".")[2])
            for m in _EF_ENTITY.finditer(text)
        ]
        if not anchors:
            continue

        for m in _EF_TO_TABLE.finditer(text):
            if owner := _owner_at(anchors, m.start()):
                builder.entity(owner, path, 0, m.group("table"))
        for m in _EF_CHAIN.finditer(text):
            owner = _owner_at(anchors, m.start())
            if not owner:
                continue
            target = m.group("ftype") or ""
            if not target and m.group("fnav"):
                target, _many = _element(
                    properties.get(owner, {}).get(m.group("fnav"), "")
                )
            target = target.rpartition(".")[2]
            if not target:
                continue
            line = _line_at(text, m.start())
            first, second = m.group("first"), m.group("second")
            if first == "HasOne" and second == "WithMany":
                builder.relate("1:N", target, owner, path, line)
            elif first == "HasMany" and second == "WithOne":
                builder.relate("1:N", owner, target, path, line)
            elif first == "HasOne" and second == "WithOne":
                builder.relate("1:1", owner, target, path, line)
            elif first == "HasMany" and second == "WithMany":
                builder.relate("N:N", owner, target, path, line)
            elif first == "HasMany":
                builder.relate("1:N", owner, target, path, line)
            elif first == "HasOne":
                builder.relate("1:N", target, owner, path, line)

    for owner, props in properties.items():
        entity = builder.model.entities[owner]
        for type_text in props.values():
            target, many = _element(type_text)
            if target in names:
                builder.navigations.append(
                    (owner, target, many, entity.file, entity.line)
                )


# --- Python -----------------------------------------------------------------

_PY_CLASS = re.compile(r"^class\s+(?P<name>\w+)\s*\((?P<bases>[^)]*)\)\s*:", re.M)
_TABLENAME = re.compile(r"__tablename__\s*=\s*['\"](?P<t>[\w.]+)['\"]")
_DB_TABLE = re.compile(r"\bdb_table\s*=\s*['\"](?P<t>[\w.]+)['\"]")
_DJANGO_FIELD = re.compile(
    r"=\s*models\.(?P<kind>ForeignKey|OneToOneField|ManyToManyField)\(\s*['\"]?(?P<target>[\w.]+)['\"]?"
)
_SA_RELATIONSHIP = re.compile(
    r"(?P<attr>\w+)\s*(?::\s*(?P<ann>Mapped\[[^\n=]+?\]))?\s*=\s*(?:relationship|Relationship|db\.relationship)"
    r"\((?P<args>[^)]*)\)"
)
_SA_FK = re.compile(
    r"(?:ForeignKey\(|foreign_key\s*=\s*)\s*['\"](?P<table>[\w]+)\.\w+['\"]"
)


def _read_python(files: list[tuple[str, str]], builder: _Builder) -> None:
    for path, text in files:
        if not path.endswith(".py"):
            continue
        is_django = "models.Model" in text and "django" in text
        is_sa = any(k in text for k in ("__tablename__", "relationship(", "table=True"))
        if not (is_django or is_sa):
            continue
        classes = list(_PY_CLASS.finditer(text))
        for index, cls in enumerate(classes):
            end = classes[index + 1].start() if index + 1 < len(classes) else len(text)
            body = text[cls.start() : end]
            name, bases = cls.group("name"), cls.group("bases")
            line = _line_at(text, cls.start())
            if is_django and "models.Model" in bases:
                builder.framework("django")
                table = m.group("t") if (m := _DB_TABLE.search(body)) else ""
                builder.entity(name, path, line, table)
                for f in _DJANGO_FIELD.finditer(body):
                    target = f.group("target").rpartition(".")[2]
                    if target == "self":
                        target = name
                    fline = line + body.count("\n", 0, f.start())
                    kind = {"ForeignKey": "1:N", "OneToOneField": "1:1"}.get(
                        f.group("kind"), "N:N"
                    )
                    if kind == "1:N":
                        builder.relate(kind, target, name, path, fline)
                    else:
                        builder.relate(kind, name, target, path, fline)
            elif is_sa and ((m := _TABLENAME.search(body)) or "table=True" in bases):
                builder.framework("sqlalchemy")
                builder.entity(name, path, line, m.group("t") if m else "")
                for fk in _SA_FK.finditer(body):
                    builder.fk_tables.append(
                        (
                            name,
                            fk.group("table"),
                            path,
                            line + body.count("\n", 0, fk.start()),
                        )
                    )
                for rel in _SA_RELATIONSHIP.finditer(body):
                    args = rel.group("args")
                    ann = rel.group("ann") or ""
                    first = re.match(r"\s*['\"]?(?P<t>[\w.]+)['\"]?", args)
                    target, many = _element(ann) if ann else ("", False)
                    if (
                        not target
                        and first
                        and first.group("t") not in ("back_populates", "secondary")
                    ):
                        target = first.group("t").rpartition(".")[2]
                    if not target:
                        continue
                    rline = line + body.count("\n", 0, rel.start())
                    if "secondary" in args:
                        builder.relate("N:N", name, target, path, rline)
                    elif "uselist=False" in args.replace(" ", ""):
                        builder.relate("1:1", name, target, path, rline)
                    elif ann:
                        # Without `Mapped[...]` the side is the foreign key's to
                        # decide, and `ForeignKey(...)` above already said it.
                        builder.navigations.append((name, target, many, path, rline))


# --- TypeORM / MikroORM, JPA, Doctrine: decorators on a field -------------------

_TS_ENTITY = re.compile(
    r"@Entity\(\s*(?:['\"](?P<t1>[\w.]+)['\"]|\{[^}]*?\b(?:name|tableName)\s*:\s*['\"](?P<t2>[\w.]+)['\"][^}]*\})?\s*\)"
    r"\s*(?:@\w+\([^)]*\)\s*)*(?:export\s+)?(?:abstract\s+)?class\s+(?P<name>\w+)"
)
_TS_RELATION = re.compile(
    r"@(?P<kind>ManyToOne|OneToMany|OneToOne|ManyToMany)\(\s*\(\)\s*=>\s*(?P<target>\w+)"
)
_JPA_ENTITY = re.compile(
    r"@Entity\b(?:\([^)]*\))?(?P<between>(?:\s*@[\w.]+(?:\([^)]*\))?)*)\s*"
    r"(?:public\s+|open\s+|data\s+|abstract\s+|final\s+)*class\s+(?P<name>\w+)"
)
_JPA_TABLE = re.compile(r"@Table\(\s*(?:name\s*=\s*)?\"(?P<t>[\w.]+)\"")
_JPA_RELATION = re.compile(
    r"@(?P<kind>ManyToOne|OneToMany|OneToOne|ManyToMany)\b(?P<args>\([^)]*\))?"
    r"(?:\s*@[\w.]+(?:\([^)]*\))?)*\s*"
    r"(?:(?:private|protected|public|lateinit|open)\s+)*(?:(?:val|var)\s+\w+\s*:\s*(?P<kt>[\w<>?., ]+?)(?:\s*[=\n])"
    r"|(?:final\s+)?(?P<jt>[\w<>?., ]+?)\s+\w+\s*[;=])"
)
_TARGET_ENTITY = re.compile(
    r"targetEntity\s*[:=]\s*['\"]?(?:[\w\\]+\\)?(?P<t>\w+)(?:::class|\.class)?"
)
_PHP_ENTITY = re.compile(
    r"(?:#\[ORM\\Entity[^\]]*\]|@ORM\\Entity\b)(?P<between>[\s\S]{0,400}?)class\s+(?P<name>\w+)"
)
_PHP_TABLE = re.compile(
    r"(?:ORM\\Table\(\s*(?:name\s*[:=]\s*)?['\"](?P<t>[\w.]+)['\"])"
)
_PHP_RELATION = re.compile(
    r"ORM\\(?P<kind>ManyToOne|OneToMany|OneToOne|ManyToMany)\((?P<args>[^)]*)\)"
)


def _add_decorated(
    builder: _Builder,
    owner: str,
    kind: str,
    target: str,
    path: str,
    line: int,
) -> None:
    target = target.rpartition(".")[2].rpartition("\\")[2]
    if not target:
        return
    if kind == "ManyToOne":
        builder.relate("1:N", target, owner, path, line)
    elif kind == "OneToMany":
        builder.relate("1:N", owner, target, path, line)
    elif kind == "OneToOne":
        builder.relate("1:1", owner, target, path, line)
    else:
        builder.relate("N:N", owner, target, path, line)


def _owner_of(spans: list[tuple[str, int, int, str]], offset: int) -> str:
    for name, start, end, _h in spans:
        if start <= offset < end:
            return name
    return ""


def _read_decorated(files: list[tuple[str, str]], builder: _Builder) -> None:
    for path, text in files:
        if path.endswith(".ts") and "@Entity" in text:
            entities = list(_TS_ENTITY.finditer(text))
            if not entities:
                continue
            builder.framework("typeorm")
            for m in entities:
                builder.entity(
                    m.group("name"),
                    path,
                    _line_at(text, m.start()),
                    m.group("t1") or m.group("t2") or "",
                )
            spans = _class_spans(text)
            for r in _TS_RELATION.finditer(text):
                if owner := _owner_of(spans, r.start()):
                    _add_decorated(
                        builder,
                        owner,
                        r.group("kind"),
                        r.group("target"),
                        path,
                        _line_at(text, r.start()),
                    )
        elif path.endswith((".java", ".kt")) and "@Entity" in text:
            entities = list(_JPA_ENTITY.finditer(text))
            if not entities:
                continue
            builder.framework("jpa")
            for m in entities:
                table = (
                    t.group("t")
                    if (t := _JPA_TABLE.search(m.group("between") or ""))
                    else ""
                )
                builder.entity(m.group("name"), path, _line_at(text, m.start()), table)
            spans = _class_spans(text)
            for r in _JPA_RELATION.finditer(text):
                owner = _owner_of(spans, r.start())
                if not owner:
                    continue
                explicit = _TARGET_ENTITY.search(r.group("args") or "")
                target = (
                    explicit.group("t")
                    if explicit
                    else _element(r.group("kt") or r.group("jt") or "")[0]
                )
                _add_decorated(
                    builder,
                    owner,
                    r.group("kind"),
                    target,
                    path,
                    _line_at(text, r.start()),
                )
        elif path.endswith(".php") and "ORM" in text and "Entity" in text:
            entities = list(_PHP_ENTITY.finditer(text))
            if not entities:
                continue
            builder.framework("doctrine")
            for m in entities:
                table = (
                    t.group("t")
                    if (t := _PHP_TABLE.search(m.group("between") or ""))
                    else ""
                )
                builder.entity(m.group("name"), path, _line_at(text, m.start()), table)
            spans = _class_spans(text)
            for r in _PHP_RELATION.finditer(text):
                owner = _owner_of(spans, r.start())
                explicit = _TARGET_ENTITY.search(r.group("args"))
                if owner and explicit:
                    _add_decorated(
                        builder,
                        owner,
                        r.group("kind"),
                        explicit.group("t"),
                        path,
                        _line_at(text, r.start()),
                    )


# --- Prisma -------------------------------------------------------------------

_PRISMA_MODEL = re.compile(r"^model\s+(?P<name>\w+)\s*\{(?P<body>.*?)^\}", re.M | re.S)
_PRISMA_FIELD = re.compile(
    r"^\s*(?P<field>\w+)\s+(?P<type>\w+)(?P<list>\[\])?(?P<opt>\?)?", re.M
)
_PRISMA_MAP = re.compile(r"@@map\(\s*\"(?P<t>[\w.]+)\"")


def _read_prisma(files: list[tuple[str, str]], builder: _Builder) -> None:
    for path, text in files:
        if not path.endswith(".prisma"):
            continue
        models = list(_PRISMA_MODEL.finditer(text))
        if not models:
            continue
        builder.framework("prisma")
        names = {m.group("name") for m in models}
        for m in models:
            name = m.group("name")
            line = _line_at(text, m.start())
            table = t.group("t") if (t := _PRISMA_MAP.search(m.group("body"))) else ""
            builder.entity(name, path, line, table)
            for f in _PRISMA_FIELD.finditer(m.group("body")):
                if f.group("type") in names:
                    builder.navigations.append(
                        (name, f.group("type"), bool(f.group("list")), path, line)
                    )


# --- ActiveRecord, Eloquent ----------------------------------------------------

_AR_CLASS = re.compile(
    r"^\s*class\s+(?P<name>\w+)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)", re.M
)
_AR_ASSOC = re.compile(
    r"^\s*(?P<kind>belongs_to|has_many|has_one|has_and_belongs_to_many)\s+:(?P<target>\w+)(?P<opts>[^\n]*)",
    re.M,
)
_AR_TABLE = re.compile(r"self\.table_name\s*=\s*['\"](?P<t>[\w.]+)['\"]")
_ELOQUENT_CLASS = re.compile(
    r"class\s+(?P<name>\w+)\s+extends\s+(?:Model|Authenticatable|Pivot)\b"
)
_ELOQUENT_REL = re.compile(
    r"\$this->(?P<kind>belongsTo|hasMany|hasOne|belongsToMany)\(\s*(?:[\w\\]+\\)?(?P<target>\w+)::class"
)
_ELOQUENT_TABLE = re.compile(r"protected\s+\$table\s*=\s*['\"](?P<t>[\w.]+)['\"]")


def _camel(name: str) -> str:
    return "".join(part.capitalize() for part in name.split("_"))


def _read_convention_orms(files: list[tuple[str, str]], builder: _Builder) -> None:
    for path, text in files:
        if path.endswith(".rb") and (cls := _AR_CLASS.search(text)):
            builder.framework("activerecord")
            name = cls.group("name")
            table = t.group("t") if (t := _AR_TABLE.search(text)) else ""
            builder.entity(name, path, _line_at(text, cls.start()), table)
            for a in _AR_ASSOC.finditer(text):
                opts = a.group("opts")
                explicit = re.search(r"class_name:\s*['\"](?P<c>[\w:]+)['\"]", opts)
                target = (
                    explicit.group("c").rpartition(":")[2]
                    if explicit
                    else _camel(_singular(a.group("target")))
                )
                line = _line_at(text, a.start())
                kind = a.group("kind")
                if kind == "belongs_to":
                    builder.relate("1:N", target, name, path, line)
                elif kind == "has_one":
                    builder.relate("1:1", name, target, path, line)
                elif kind == "has_many" and "through:" not in opts:
                    builder.relate("1:N", name, target, path, line)
                else:
                    builder.relate("N:N", name, target, path, line)
        elif path.endswith(".php") and (cls := _ELOQUENT_CLASS.search(text)):
            builder.framework("eloquent")
            name = cls.group("name")
            table = t.group("t") if (t := _ELOQUENT_TABLE.search(text)) else ""
            builder.entity(name, path, _line_at(text, cls.start()), table)
            for r in _ELOQUENT_REL.finditer(text):
                line = _line_at(text, r.start())
                kind, target = r.group("kind"), r.group("target")
                if kind == "belongsTo":
                    builder.relate("1:N", target, name, path, line)
                elif kind == "hasMany":
                    builder.relate("1:N", name, target, path, line)
                elif kind == "hasOne":
                    builder.relate("1:1", name, target, path, line)
                else:
                    builder.relate("N:N", name, target, path, line)


# --- GORM -----------------------------------------------------------------------

_GO_STRUCT = re.compile(
    r"^type\s+(?P<name>\w+)\s+struct\s*\{(?P<body>.*?)^\}", re.M | re.S
)
_GO_FIELD = re.compile(r"^\s*(?P<field>\w+)\s+(?P<type>\[\]\*?\w+|\*?\w+)\b", re.M)


def _read_gorm(files: list[tuple[str, str]], builder: _Builder) -> None:
    structs: list[tuple[str, str, int, str]] = []
    for path, text in files:
        if not path.endswith(".go") or "gorm" not in text:
            continue
        for m in _GO_STRUCT.finditer(text):
            body = m.group("body")
            if "gorm.Model" in body or 'gorm:"' in body:
                structs.append((m.group("name"), path, _line_at(text, m.start()), body))
    if not structs:
        return
    builder.framework("gorm")
    names = {s[0] for s in structs}
    for name, path, line, _body in structs:
        builder.entity(name, path, line)
    for name, path, line, body in structs:
        for f in _GO_FIELD.finditer(body):
            target, many = _element(f.group("type").replace("*", ""))
            if target in names and target != name:
                builder.navigations.append((name, target, many, path, line))


# ---------------------------------------------------------------------------
# Names
# ---------------------------------------------------------------------------


def _singular(word: str) -> str:
    lower = word.lower()
    if lower.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    if lower.endswith(("sses", "xes", "ches", "shes", "zes")):
        return word[:-2]
    if lower.endswith("s") and not lower.endswith(("ss", "us", "is")) and len(word) > 3:
        return word[:-1]
    return word


def _norm(name: str) -> str:
    """`dbo.Order_Lines`, `OrderLine`, `order_lines`, `orderlines` -> `orderline`."""
    name = name.strip().strip('"`[]').rpartition(".")[2]
    return _singular(re.sub(r"[^A-Za-z0-9]", "", name)).lower()


def read_orm(project_dir: Path) -> OrmModel:
    """Every ORM model the project declares. Never raises."""
    builder = _Builder()
    try:
        files = list(_sources(Path(project_dir)))
    except OSError:
        return builder.model
    for reader in (
        _read_efcore,
        _read_python,
        _read_decorated,
        _read_prisma,
        _read_convention_orms,
        _read_gorm,
    ):
        try:
            reader(files, builder)
        except Exception:  # noqa: BLE001 - one idiom misread is not a failed build
            continue
    return builder.build()
