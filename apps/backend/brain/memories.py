"""The memories agents already have, and the brain they now share.

Every agent keeps its own memory — ``~/.claude/CLAUDE.md``, ``~/.codex/AGENTS.md``,
hermes's ``MEMORY.md`` — and none of them reads the others'. This module does two
things with those files, in opposite directions:

| Direction | What | Function |
|---|---|---|
| agent -> brain | every instruction an agent already follows becomes a brain note, once | `ingest` |
| brain -> agent | the agent's own memory file is told the brain exists and what it says | `bridge` |

**Similar is not duplicate, and neither is lost.** Two agents told "réponds en
français" in different words hold one instruction, not two: `remember` finds the
existing note by similarity and adds the second agent to it, which is how the
brain learns that an instruction is *shared*. The agent's own wording is never
rewritten — its file stays as it is, and the brain's instructions apply **in
addition**. The bridge tells each agent exactly that, and marks which brain
instructions it already follows, so a similar one reads as confirmation, not as
a second rule to reconcile.

**Nothing the brain wrote is read back as an agent's memory.** The bridge block
is delimited, and `extract_instructions` drops it before reading: otherwise every
ingest would re-import the brain into itself, credited to whichever agent it
had just been bridged to.

**A secret is not knowledge.** The brain is a git repository with a remote, so
a line that looks like a credential is redacted from every snapshot and never
becomes an instruction.
"""

from __future__ import annotations

import hashlib
import os
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from difflib import SequenceMatcher
from pathlib import Path

from .agents import AGENTS, AgentSpec, agent
from .home import digest_path, kind_dir
from .notes import Note, iter_notes, now_iso, read_note, slugify, write_note

__all__ = [
    "BRIDGE_START",
    "BRIDGE_END",
    "extract_instructions",
    "similarity",
    "remember",
    "instructions",
    "ingest",
    "write_digest",
    "bridge_block",
    "bridge",
    "refresh_bridges",
    "discover",
]

BRIDGE_START = "<!-- workpilot-brain:start -->"
BRIDGE_END = "<!-- workpilot-brain:end -->"
_BLOCK = re.compile(
    re.escape(BRIDGE_START) + r".*?" + re.escape(BRIDGE_END) + r"\n?", re.DOTALL
)

_SECRET = re.compile(
    r"(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY|(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,})",
    re.IGNORECASE,
)
_LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$")
_STOP = frozenset(
    "a an the and or of to in on for with is are be it this that as at by from you your "
    "le la les un une des de du et ou en au aux pour par sur dans avec est sont ce cet cette "
    "tu te toi ton ta tes vous votre vos il elle on ne pas que qui se sa son ses".split()
)
_MIN_LEN = 12
_MAX_LEN = 600


def _threshold() -> float:
    try:
        return min(1.0, max(0.3, float(os.environ.get("BRAIN_SIMILARITY", "0.72"))))
    except ValueError:
        return 0.72


# ---------------------------------------------------------------------------
# Reading an agent's memory
# ---------------------------------------------------------------------------


def strip_bridge(text: str) -> str:
    return _BLOCK.sub("", text)


def redact(text: str) -> str:
    return "\n".join(
        "[redacted by WorkPilot Brain: looked like a credential]"
        if _SECRET.search(line)
        else line
        for line in text.splitlines()
    )


def extract_instructions(text: str) -> list[str]:
    """The rules a memory file states: list items and short standalone lines.

    Headings, code blocks, ``@imports``, HTML comments and tables are structure,
    not instructions. A paragraph longer than ``_MAX_LEN`` is prose about
    something, and a rule nobody could quote back.
    """
    text = strip_bridge(text)
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            text = text[end + 4 :]
    out: dict[str, None] = {}
    in_fence = False
    in_comment = False
    for raw in text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if "<!--" in stripped:
            in_comment = "-->" not in stripped
            continue
        if in_comment:
            in_comment = "-->" not in stripped
            continue
        if not stripped or stripped.startswith(("#", "@", "|", ">", "<")):
            continue
        match = _LIST_ITEM.match(line)
        candidate = match.group(1) if match else stripped
        candidate = re.sub(r"\s+", " ", candidate).strip()
        if not (_MIN_LEN <= len(candidate) <= _MAX_LEN):
            continue
        if _SECRET.search(candidate):
            continue
        out.setdefault(candidate, None)
    return list(out)


def _normalize(text: str) -> str:
    folded = (
        unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    )
    return re.sub(r"[^a-z0-9]+", " ", folded).strip()


def _tokens(text: str) -> set[str]:
    """Content words, cut to their first five letters.

    A crude stem, and enough: "réponds" / "répondre" and "answer" / "answered"
    are the same instruction, and the inflection is what differs between two
    agents told the same thing by the same person on different days.
    """
    return {t[:5] for t in _normalize(text).split() if t not in _STOP and len(t) > 1}


def similarity(a: str, b: str) -> float:
    """0..1. The larger of word overlap and character similarity.

    Word overlap catches reordering ("always answer in French" / "answer in
    French, always"); the character ratio catches a typo or an inflection the
    token set would count as a different word.
    """
    ta, tb = _tokens(a), _tokens(b)
    jaccard = len(ta & tb) / len(ta | tb) if ta and tb else 0.0
    ratio = SequenceMatcher(None, _normalize(a), _normalize(b)).ratio()
    return max(jaccard, ratio)


# ---------------------------------------------------------------------------
# The brain's instructions
# ---------------------------------------------------------------------------


@dataclass
class Instruction:
    rel: str
    text: str
    agents: list[str]
    status: str

    def to_dict(self) -> dict:
        return asdict(self)


def _instruction_text(note: Note) -> str:
    body = note.body.split("\n## ", 1)[0]
    lines = [
        line for line in body.splitlines() if line.strip() and not line.startswith("# ")
    ]
    return " ".join(line.strip() for line in lines).strip()


def instructions(root: Path, *, include_retired: bool = False) -> list[Instruction]:
    folder = kind_dir(root, "instruction").name
    out: list[Instruction] = []
    for rel in iter_notes(root):
        if rel.parts[0] != folder:
            continue
        try:
            note = read_note(root, rel)
        except OSError:
            continue
        status = str(note.meta.get("status") or "active")
        if status == "retired" and not include_retired:
            continue
        agents = note.meta.get("agents") or []
        out.append(
            Instruction(
                rel=note.rel,
                text=_instruction_text(note),
                agents=[str(a) for a in agents]
                if isinstance(agents, list)
                else [str(agents)],
                status=status,
            )
        )
    return out


@dataclass
class RememberResult:
    outcome: str
    """``created``, ``reinforced`` (another agent now holds it too) or ``known``."""
    rel: str
    similarity: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


def remember(
    root: Path, text: str, *, agent_name: str = "brain", source: str | None = None
) -> RememberResult:
    """File *text* as an instruction, merging it into a similar one if any."""
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        raise ValueError("an instruction cannot be empty")
    if _SECRET.search(text):
        raise ValueError("refusing to store what looks like a credential")
    best: tuple[float, Instruction | None] = (0.0, None)
    for existing in instructions(root, include_retired=True):
        score = similarity(text, existing.text)
        if score > best[0]:
            best = (score, existing)
    score, match = best
    if match is not None and score >= _threshold():
        note = read_note(root, match.rel)
        agents = list(note.meta.get("agents") or [])
        sources = list(note.meta.get("sources") or [])
        changed = False
        if agent_name not in agents:
            agents.append(agent_name)
            changed = True
        if source and source not in sources:
            sources.append(source)
            changed = True
        if note.meta.get("status") == "retired":
            note.meta["status"] = "active"
            changed = True
        if score < 0.999 and text not in note.body:
            note.body = (
                note.body.rstrip() + f"\n\n## Formulation de {agent_name}\n\n> {text}\n"
            )
            changed = True
        if not changed:
            return RememberResult("known", match.rel, round(score, 3))
        note.meta["agents"] = agents
        note.meta["sources"] = sources
        note.meta["updated"] = now_iso()
        write_note(root, note)
        return RememberResult("reinforced", match.rel, round(score, 3))

    digest = hashlib.sha256(_normalize(text).encode()).hexdigest()[:6]
    rel = Path(kind_dir(root, "instruction").name) / f"{slugify(text, 56)}-{digest}.md"
    note = Note(
        path=rel,
        meta={
            "kind": "instruction",
            "title": text if len(text) <= 80 else text[:77].rstrip() + "…",
            "status": "active",
            "agents": [agent_name],
            "sources": [source] if source else [],
            "tags": ["instruction"],
            "created": now_iso(),
            "updated": now_iso(),
        },
        body=f"{text}\n\n## Liens\n\n- [[{agent_name}]]\n",
    )
    write_note(root, note)
    return RememberResult("created", rel.as_posix(), round(score, 3))


# ---------------------------------------------------------------------------
# Agent -> brain
# ---------------------------------------------------------------------------


@dataclass
class MemoryFile:
    agent: str
    path: str
    scope: str
    exists: bool
    bridged: bool = False
    instructions: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


def _candidates(spec: AgentSpec, project_dir: Path | None) -> list[tuple[Path, str]]:
    out = [(p, "global") for p in spec.global_paths()]
    if project_dir is not None:
        out += [(project_dir / rel, "project") for rel in spec.project_memory]
    return out


def discover(
    project_dir: Path | None = None, names: list[str] | None = None
) -> list[MemoryFile]:
    """Every memory file each known agent would read, and whether it exists."""
    found: list[MemoryFile] = []
    for spec in AGENTS:
        if names and spec.name not in names:
            continue
        for path, scope in _candidates(spec, project_dir):
            exists = path.is_file()
            text = path.read_text(encoding="utf-8", errors="replace") if exists else ""
            found.append(
                MemoryFile(
                    agent=spec.name,
                    path=str(path),
                    scope=scope,
                    exists=exists,
                    bridged=BRIDGE_START in text,
                    instructions=len(extract_instructions(text)) if exists else 0,
                )
            )
    return found


@dataclass
class IngestReport:
    files: list[dict] = field(default_factory=list)
    created: int = 0
    reinforced: int = 0
    known: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


def _agent_page(root: Path, spec: AgentSpec) -> None:
    """``agents/<name>.md`` — the node every one of its instructions links to."""
    rel = Path("agents") / f"{spec.name}.md"
    if (root / rel).exists():
        return
    write_note(
        root,
        Note(
            path=rel,
            meta={
                "kind": "agent-memory",
                "title": spec.name,
                "agent": spec.name,
                "tags": ["agent"],
            },
            body=f"# {spec.label}\n\nAgent connecté au cerveau. Ses mémoires importées sont dans "
            f"`agents/{spec.name}/`.\n",
        ),
    )


def ingest(
    root: Path, project_dir: Path | None = None, names: list[str] | None = None
) -> IngestReport:
    """Snapshot every existing agent memory into the brain and file its instructions."""
    report = IngestReport()
    for spec in AGENTS:
        if names and spec.name not in names:
            continue
        for path, scope in _candidates(spec, project_dir):
            if not path.is_file():
                continue
            raw = path.read_text(encoding="utf-8", errors="replace")
            text = strip_bridge(raw)
            items = extract_instructions(text)
            _agent_page(root, spec)
            label = (
                f"{scope}-{project_dir.name}"
                if scope == "project" and project_dir
                else scope
            )
            snap_rel = (
                Path("agents") / spec.name / f"{label}-{slugify(path.name, 40)}.md"
            )
            write_note(
                root,
                Note(
                    path=snap_rel,
                    meta={
                        "kind": "agent-memory",
                        "title": f"{spec.label} — {path.name} ({label})",
                        "agent": spec.name,
                        "scope": scope,
                        "source": str(path),
                        "sha256": hashlib.sha256(text.encode()).hexdigest(),
                        "updated": now_iso(),
                        "tags": ["agent-memory", spec.name],
                    },
                    body=f"Instantané de `{path}` — lu par [[{spec.name}]].\n\n"
                    + redact(text).strip()
                    + "\n",
                ),
            )
            counts = {"created": 0, "reinforced": 0, "known": 0}
            for item in items:
                outcome = remember(
                    root, item, agent_name=spec.name, source=snap_rel.as_posix()
                ).outcome
                counts[outcome] += 1
            report.created += counts["created"]
            report.reinforced += counts["reinforced"]
            report.known += counts["known"]
            report.files.append(
                {"agent": spec.name, "path": str(path), "scope": scope, **counts}
            )
    write_digest(root)
    return report


# ---------------------------------------------------------------------------
# Brain -> agent
# ---------------------------------------------------------------------------


def write_digest(root: Path) -> Path:
    """``INSTRUCTIONS.md``: every active instruction, one line, most shared first."""
    items = sorted(instructions(root), key=lambda i: (-len(i.agents), i.text.lower()))
    lines = [
        "---",
        "kind: digest",
        "title: Instructions partagées",
        "generated: true",
        "---",
        "",
        "# Instructions partagées",
        "",
        (
            "Généré par WorkPilot Brain à chaque modification — ne pas éditer ici, "
            "éditer la note dans `instructions/`."
        ),
        "",
    ]
    for item in items:
        who = ", ".join(item.agents)
        lines.append(f"- {item.text}  _(source : {who})_")
    path = digest_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def bridge_block(root: Path, spec: AgentSpec, own_text: str = "") -> str:
    """The block written into *spec*'s memory file.

    Per agent: the brain instructions it already follows are marked as such, so
    a similar instruction reads as confirmation rather than as a second rule.
    """
    own = extract_instructions(own_text)
    items = sorted(instructions(root), key=lambda i: (-len(i.agents), i.text.lower()))
    shared, already = [], []
    for item in items:
        if any(similarity(item.text, mine) >= _threshold() for mine in own):
            # Only worth listing when another agent holds it too: that is the
            # news. One the agent alone holds is already in the file above.
            if any(a != spec.name for a in item.agents):
                already.append(item)
        else:
            shared.append(item)

    head = [
        BRIDGE_START,
        "## Cerveau partagé (WorkPilot Brain)",
        "",
        (
            f"Tu partages un cerveau avec les autres agents IA de cet utilisateur : `{root}` "
            "(vault Obsidian + `graphify-out/graph.json`), exposé par le serveur MCP `workpilot-brain`."
        ),
        "",
        (
            "- **Rappel** : pour toute question « qu'avait-on décidé / où est / qu'est-ce qui est relié à », "
            "applique le skill `graph-first-recall` — `brain_recall` (graphe puis index) avant "
            "`brain_read_note` (fichier brut), et arrête-toi dès que tu as la réponse."
        ),
        (
            "- **Instructions** : celles du cerveau s'appliquent **en plus** des tiennes. Une instruction "
            "similaire à l'une des tiennes se renforce : applique les deux. En cas de contradiction, "
            "l'instruction la plus spécifique (ce projet, puis cet agent) l'emporte — signale-la avec "
            "`brain_remember`."
        ),
        (
            "- **Écriture** : une décision, une convention ou une préférence durable va dans le cerveau "
            "(`brain_write_note`, `brain_remember`) ; elle est poussée (git push) aux autres agents."
        ),
    ]
    if spec.supports_import:
        head += ["", f"@{digest_path(root)}"]
    tail = [BRIDGE_END]

    body: list[str] = []
    if shared and not spec.supports_import:
        body += ["", "### Instructions du cerveau à appliquer en plus des tiennes", ""]
        body += [f"- {item.text}" for item in shared]
    if already:
        body += [
            "",
            "### Déjà dans ta mémoire, et partagées avec d'autres agents (renforcées)",
            "",
        ]
        body += [f"- {item.text}  _({', '.join(item.agents)})_" for item in already]

    text = "\n".join(head + body + tail) + "\n"
    if len(text) <= spec.bridge_budget:
        return text
    # Over budget (hermes): keep the pointer, let MCP carry the content.
    pointer = "\n".join(
        head[:4]
        + [
            "",
            f"Instructions partagées : {len(items)} (outil MCP `brain_instructions`). "
            "Elles s'appliquent en plus des tiennes.",
        ]
        + tail
    )
    return pointer + "\n"


@dataclass
class BridgeResult:
    agent: str
    path: str | None
    action: str
    """``written``, ``unchanged``, ``preview`` or ``unsupported``."""
    preview: str = ""
    backup: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def bridge(root: Path, name: str, *, apply: bool = False) -> BridgeResult:
    """Put the bridge block into *name*'s global memory file (create it if needed)."""
    spec = agent(name)
    path = spec.bridge_path()
    if path is None:
        return BridgeResult(spec.name, None, "unsupported")
    current = (
        path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
    )
    block = bridge_block(root, spec, current)
    if BRIDGE_START in current:
        updated = _BLOCK.sub(lambda _m: block, current, count=1)
    else:
        sep = (
            ""
            if not current or current.endswith("\n\n")
            else ("\n" if current.endswith("\n") else "\n\n")
        )
        updated = current + sep + block
    if updated == current:
        return BridgeResult(spec.name, str(path), "unchanged")
    if not apply:
        return BridgeResult(spec.name, str(path), "preview", preview=block)
    backup = None
    if current and BRIDGE_START not in current:
        backup_path = path.with_name(path.name + ".workpilot-brain.bak")
        if not backup_path.exists():
            backup_path.write_text(current, encoding="utf-8")
        backup = str(backup_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(updated, encoding="utf-8")
    return BridgeResult(spec.name, str(path), "written", backup=backup)


def refresh_bridges(root: Path) -> list[BridgeResult]:
    """Rewrite the block in every memory file that already carries one.

    Only files a person bridged: a sync never adds a block to a file it was not
    asked to touch, it keeps the ones it was asked to up to date.
    """
    out = []
    for spec in AGENTS:
        path = spec.bridge_path()
        if path is None or not path.is_file():
            continue
        if BRIDGE_START not in path.read_text(encoding="utf-8", errors="replace"):
            continue
        out.append(bridge(root, spec.name, apply=True))
    return out
