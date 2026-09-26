"""A sequence diagram's calls, looked up in the code by name.

`Controller -> Handler : Handle(command)` then `Handler -> Repository :
AddAsync(order)` is the flow somebody designed, and the easiest thing for an
implementation to drift from: a handler that skips the repository, a method
renamed on one side. A diagram kept as source — PlantUML or Mermaid — names
the participants and the calls exactly, so each call is a lookup: is there a
type by that name, and does it (or its file) declare that method?

| Source | Read from |
|---|---|
| PlantUML `@startuml … @enduml` | `.puml` / `.plantuml` / `.iuml`, fenced ```plantuml blocks, and the source PlantUML embeds in its PNG exports |
| Mermaid `sequenceDiagram` | `.mmd` / `.mermaid`, fenced ```mermaid blocks |
| OCR text | only when an image carries no embedded source |

**Unverified is not false.** A call nobody could find by name is reported
*not verified* — the participant may be named for a role rather than a class
(`API`, `Payment provider`), the method may be generated, or the flow may be
the one the task is about to build. What a lookup cannot establish is said,
never turned into a finding. Actors, databases and queues are not code and
are not looked up; return arrows are answers, not calls.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .conformance import DIAGRAM_DIRS, MAX_DIAGRAM_BYTES, _walk
from .diagrams import png_text_chunks
from .orm import _sources

MAX_DIAGRAMS = 10
MAX_CALLS = 60
SEQUENCE_SUFFIXES = (".puml", ".plantuml", ".iuml", ".mmd", ".mermaid", ".md")
#: Participant kinds that are not code.
NOT_CODE = {"actor", "database", "queue", "collections"}


@dataclass
class SequenceCall:
    source: str
    target: str
    message: str
    method: str = ""
    #: ``verified`` (type and method found), ``method-not-found`` (the type is
    #: there, the method is not), ``type-not-found``, ``not-a-call`` (the
    #: message names no method), ``not-code`` (an actor, a database…).
    status: str = ""
    file: str = ""
    line: int = 0


@dataclass
class SequenceDiagram:
    source: str
    format: str
    #: alias -> (label, kind)
    participants: dict[str, tuple[str, str]] = field(default_factory=dict)
    calls: list[SequenceCall] = field(default_factory=list)


@dataclass
class SequenceCheck:
    diagram: str
    format: str
    origin: str
    calls: list[SequenceCall] = field(default_factory=list)

    @property
    def verified(self) -> int:
        return sum(1 for c in self.calls if c.status == "verified")

    @property
    def checkable(self) -> int:
        return sum(1 for c in self.calls if c.status not in ("not-code", "not-a-call"))


@dataclass
class SequenceReport:
    checks: list[SequenceCheck] = field(default_factory=list)
    skipped: str = ""

    def to_dict(self) -> dict:
        return {
            "checks": [
                {
                    **{k: v for k, v in asdict(c).items() if k != "calls"},
                    "calls": [asdict(call) for call in c.calls],
                    "verified": c.verified,
                    "checkable": c.checkable,
                }
                for c in self.checks
            ],
            "skipped": self.skipped,
        }


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

_PUML_BLOCK = re.compile(r"@startuml.*?@enduml", re.S | re.I)
_PUML_PARTICIPANT = re.compile(
    r"^\s*(?P<kind>participant|actor|boundary|control|entity|database|collections|queue)\s+"
    r"(?:\"(?P<qlabel>[^\"]+)\"(?:\s+as\s+(?P<qalias>[\w.]+))?|(?P<name>[\w.]+)(?:\s+as\s+(?P<alias>[\w.]+))?)",
    re.M | re.I,
)
_PUML_MESSAGE = re.compile(
    r"^\s*(?P<a>\"[^\"]+\"|[\w.]+)\s*(?P<arrow><?-{1,2}(?:\[[^\]]*\])?(?:>>?|\\\\?|//?|x)|<-{1,2})\s*"
    r"(?P<b>\"[^\"]+\"|[\w.]+)\s*(?:\+\+|--|\*\*|!!)?\s*:\s*(?P<msg>.+?)\s*$",
    re.M,
)
_MERMAID_PARTICIPANT = re.compile(
    r"^\s*(?P<kind>participant|actor)\s+(?P<name>[\w.-]+)(?:\s+as\s+(?P<label>.+?))?\s*$",
    re.M,
)
_MERMAID_MESSAGE = re.compile(
    r"^\s*(?P<a>\w[\w.]*(?:-\w[\w.]*)*)\s*(?P<arrow>-{1,2}>>|-{1,2}>|-{1,2}x|-{1,2}\))\s*[+-]?\s*"
    r"(?P<b>\w[\w.]*(?:-\w[\w.]*)*)\s*:\s*(?P<msg>.+?)\s*$",
    re.M,
)
_FENCE = re.compile(
    r"```(?P<lang>plantuml|puml|mermaid)\s*\n(?P<body>.*?)```", re.S | re.I
)
_METHOD = re.compile(r"(?P<name>[A-Za-z_]\w*)\s*\(")
_IDENT = re.compile(r"^[A-Za-z_][\w.]*$")


def _unquote(name: str) -> str:
    return name.strip().strip('"')


def _method_of(message: str) -> str:
    """`Handle(command)` -> `Handle`; `repo.AddAsync(o)` -> `AddAsync`; `validate` -> `validate`."""
    message = re.sub(r"^\s*\d+[.:)]?\s+", "", message).strip()
    if message.upper().startswith(("GET ", "POST ", "PUT ", "PATCH ", "DELETE ")):
        return ""
    calls = _METHOD.findall(message)
    if calls:
        return calls[-1]
    if _IDENT.match(message):
        return message.rpartition(".")[2]
    return ""


def parse_plantuml(text: str, source: str) -> SequenceDiagram | None:
    blocks = _PUML_BLOCK.findall(text or "") or ([text] if text else [])
    diagram = SequenceDiagram(source=source, format="plantuml")
    for block in blocks:
        if "->" not in block and "<-" not in block:
            continue
        for p in _PUML_PARTICIPANT.finditer(block):
            label = p["qlabel"] or p["name"]
            alias = p["qalias"] or p["alias"] or label
            diagram.participants[alias] = (label, p["kind"].lower())
        for m in _PUML_MESSAGE.finditer(block):
            arrow = m["arrow"]
            a, b = _unquote(m["a"]), _unquote(m["b"])
            if arrow.startswith("<"):
                a, b = b, a
            if "--" in arrow:
                continue  # a dashed arrow is a return
            diagram.calls.append(SequenceCall(a, b, m["msg"]))
    return diagram if diagram.calls else None


def parse_mermaid_sequence(text: str, source: str) -> SequenceDiagram | None:
    diagram = SequenceDiagram(source=source, format="mermaid")
    blocks = [
        m["body"] for m in _FENCE.finditer(text or "") if m["lang"].lower() == "mermaid"
    ]
    for block in blocks or [text or ""]:
        if "sequenceDiagram" not in block:
            continue
        body = block.split("sequenceDiagram", 1)[1]
        for p in _MERMAID_PARTICIPANT.finditer(body):
            diagram.participants[p["name"]] = (
                (p["label"] or p["name"]).strip(),
                p["kind"].lower(),
            )
        for m in _MERMAID_MESSAGE.finditer(body):
            if m["arrow"].startswith("--"):
                continue
            diagram.calls.append(SequenceCall(m["a"], m["b"], m["msg"]))
    return diagram if diagram.calls else None


def parse_sequence(text: str, source: str) -> SequenceDiagram | None:
    """A PlantUML or Mermaid sequence in `text`, including fenced Markdown blocks."""
    for fence in _FENCE.finditer(text or ""):
        if fence["lang"].lower() in ("plantuml", "puml"):
            if found := parse_plantuml(fence["body"], source):
                return found
    if "sequenceDiagram" in (text or ""):
        return parse_mermaid_sequence(text, source)
    if "@startuml" in (text or "").lower() or source.lower().endswith(
        (".puml", ".plantuml", ".iuml")
    ):
        return parse_plantuml(text, source)
    return None


def plantuml_png_source(data: bytes) -> str:
    """The source PlantUML keeps in its PNG exports (`plantuml` text chunk)."""
    return png_text_chunks(data).get("plantuml", "")


# ---------------------------------------------------------------------------
# The code side
# ---------------------------------------------------------------------------

_DECLARATION = re.compile(
    r"\b(?:class|interface|struct|record|enum|object|trait)\s+(?P<a>[A-Za-z_]\w*)"
    r"|\btype\s+(?P<b>[A-Z]\w*)\s+(?:struct|interface)\b"
)


class SymbolIndex:
    """Type name -> [(file, line)], read once from the project's sources."""

    def __init__(self, project_dir: Path) -> None:
        self.types: dict[str, list[tuple[str, int]]] = {}
        self.texts: dict[str, str] = {}
        for relative, text in _sources(Path(project_dir)):
            for m in _DECLARATION.finditer(text):
                name = m["a"] or m["b"]
                self.types.setdefault(name.lower(), []).append(
                    (relative, text.count("\n", 0, m.start()) + 1)
                )
                self.texts.setdefault(relative, text)

    def find_type(self, names: list[str]) -> list[tuple[str, int]]:
        for name in names:
            if found := self.types.get(name.lower()):
                return found
        return []

    def find_method(
        self, files: list[tuple[str, int]], method: str
    ) -> tuple[str, int] | None:
        pattern = re.compile(
            rf"(?:\bdef\s+{re.escape(method)}\b|\bfunc\s*(?:\([^)]*\)\s*)?{re.escape(method)}\s*\(|"
            rf"\b{re.escape(method)}\s*(?:<[^>\n]*>)?\s*\()"
        )
        for relative, _line in files:
            text = self.texts.get(relative, "")
            if m := pattern.search(text):
                return relative, text.count("\n", 0, m.start()) + 1
        return None


def _candidates(alias: str, label: str) -> list[str]:
    """`ctrl` / `Orders Controller` -> `ctrl`, `OrdersController`, `Orders_Controller`."""
    names = [alias]
    compact = re.sub(r"[^\w]", "", label)
    if compact:
        names.append(compact)
    pascal = "".join(w[:1].upper() + w[1:] for w in re.split(r"[^\w]+", label) if w)
    if pascal:
        names.append(pascal)
    # `IOrderRepository` and `OrderRepository` name the same collaborator.
    names += [n[1:] for n in list(names) if re.match(r"^I[A-Z]", n)]
    return list(dict.fromkeys(n for n in names if n))


def verify(diagram: SequenceDiagram, index: SymbolIndex, origin: str) -> SequenceCheck:
    check = SequenceCheck(diagram=diagram.source, format=diagram.format, origin=origin)
    for call in diagram.calls[:MAX_CALLS]:
        label, kind = diagram.participants.get(
            call.target, (call.target, "participant")
        )
        call.method = _method_of(call.message)
        if kind in NOT_CODE:
            call.status = "not-code"
        elif not call.method:
            call.status = "not-a-call"
        elif not (types := index.find_type(_candidates(call.target, label))):
            call.status = "type-not-found"
        elif found := index.find_method(types, call.method):
            call.status = "verified"
            call.file, call.line = found
        else:
            call.status = "method-not-found"
            call.file, call.line = types[0]
        # Shown by what the diagram calls them, not by their alias.
        call.source = diagram.participants.get(call.source, (call.source, ""))[0]
        call.target = label
        check.calls.append(call)
    return check


# ---------------------------------------------------------------------------
# Where diagrams come from
# ---------------------------------------------------------------------------


def find_sequences(project_dir: Path) -> list[SequenceDiagram]:
    found: list[SequenceDiagram] = []
    seen: set[Path] = set()
    for relative in DIAGRAM_DIRS:
        base = project_dir / relative
        if not base.is_dir() or (relative != "." and base.is_symlink()):
            continue
        for path in _walk(base, 0 if relative == "." else 6):
            name = path.name.lower()
            if path in seen or not (
                name.endswith(SEQUENCE_SUFFIXES) or name.endswith(".png")
            ):
                continue
            seen.add(path)
            try:
                if path.stat().st_size > MAX_DIAGRAM_BYTES:
                    continue
                data = path.read_bytes()
            except OSError:
                continue
            text = (
                plantuml_png_source(data)
                if name.endswith(".png")
                else data.decode("utf-8", errors="replace")
            )
            if text and (
                diagram := parse_sequence(
                    text, path.relative_to(project_dir).as_posix()
                )
            ):
                found.append(diagram)
                if len(found) >= MAX_DIAGRAMS:
                    return found
    return found


def sequences_from_attachments(spec_dir: Path) -> list[SequenceDiagram]:
    """Sequences among the task's attachments: embedded source first, OCR last."""
    from .preflight import load_result

    result = load_result(Path(spec_dir))
    if result is None:
        return []
    found: list[SequenceDiagram] = []
    spec_root = Path(spec_dir).resolve()
    for doc in result.documents:
        if doc.threat != "safe" or doc.status == "withheld":
            continue
        original = Path(spec_dir) / doc.path
        text = ""
        try:
            original.resolve().relative_to(spec_root)
            if original.suffix.lower() == ".png" and not original.is_symlink():
                text = plantuml_png_source(original.read_bytes())
        except (ValueError, OSError):
            continue
        fmt_suffix = ""
        if not text and doc.extracted_path:
            try:
                full = Path(spec_dir) / doc.extracted_path
                full.resolve().relative_to(spec_root)
                text = full.read_text(encoding="utf-8")
            except (ValueError, OSError):
                text = ""
        text = text or doc.text
        if doc.engine not in (
            "",
            "text",
            "drawio",
            "excalidraw",
        ) and not text.lstrip().startswith("@start"):
            fmt_suffix = f" ({doc.engine})"
        if text and (diagram := parse_sequence(text, doc.path)):
            diagram.format += fmt_suffix
            found.append(diagram)
    return found[:MAX_DIAGRAMS]


def check_sequences(project_dir: Path, spec_dir: Path | None = None) -> SequenceReport:
    """Every sequence — the task's, then the repository's — against the code."""
    report = SequenceReport()
    try:
        attached = sequences_from_attachments(spec_dir) if spec_dir is not None else []
        documented = find_sequences(Path(project_dir))
        if not attached and not documented:
            report.skipped = "no-sequence"
            return report
        index = SymbolIndex(Path(project_dir))
        for origin, diagrams in (("attachment", attached), ("repository", documented)):
            for diagram in diagrams:
                report.checks.append(verify(diagram, index, origin))
    except OSError:
        report.skipped = report.skipped or "unreadable"
    return report


def _name(text: str) -> str:
    """A participant as the diagram names it — somebody's text, so words only."""
    return re.sub(r"[^\w .-]", "", text)[:60].strip() or "?"


_STATUS_TEXT = {
    "method-not-found": "not verified — the type is there, no method by that name",
    "type-not-found": "not verified — no type by that name",
}


def sequence_section(project_dir: Path, spec_dir: Path | None = None) -> str:
    report = check_sequences(Path(project_dir), spec_dir)
    checks = [c for c in report.checks if c.calls]
    if not checks:
        return ""
    lines = [
        "## Sequence diagrams vs. code",
        "",
        "Each call of the diagram(s) below was looked up by name: the participant as a "
        "type, the message as a method. **Not verified is not wrong** — a participant "
        "named for a role, a generated method, or the flow this task is about to build "
        "all read the same way; check before relying on one. A task's own diagram is "
        "the flow to implement; a repository diagram is the flow to keep.",
    ]
    for check in checks:
        role = "the task's flow" if check.origin == "attachment" else "documented flow"
        lines += [
            "",
            f"`{check.diagram}` ({check.format}, {role}) — {check.verified} of "
            f"{check.checkable} call(s) verified:",
        ]
        for call in check.calls:
            if call.status in ("not-code", "not-a-call"):
                continue
            head = f"- {_name(call.source)} -> {_name(call.target)}: `{call.method}`"
            if call.status == "verified":
                lines.append(f"{head} — `{call.file}:{call.line}`")
            else:
                where = f" (`{call.file}`)" if call.file else ""
                lines.append(f"{head} — {_STATUS_TEXT[call.status]}{where}")
    return "\n".join(lines)
